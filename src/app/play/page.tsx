"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { QUIZ_EVENTS } from "@/lib/socket/events";
import { ANSWER_COLORS } from "@/lib/quiz/colors";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FullQuestion {
  id: string;
  text: string;
  answerType: string;
  answers: { id: string; text: string; isCorrect: boolean; sortOrder: number }[];
  timeLimitSecs: number | null;
  points: number;
  explanation: string | null;
}

interface BeamerQuestion {
  id: string;
  text?: string;
  answerType: string;
  answers: { id: string; text?: string; sortOrder: number }[];
  timeLimitSecs: number | null;
  remainingSecs?: number | null;
  index: number;
  total: number;
  explanation?: string | null;
}

interface RevealData {
  correctAnswerIds: string[];
  scoreGained: number;
  totalScore: number;
}

interface TopScore {
  rank: number;
  displayName: string;
  score: number;
}

interface CardQuestion {
  text?: string;
  index: number;
  total: number;
  timeLimitSecs?: number | null;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export default function PlayPage() {
  return <Suspense><PlayContent /></Suspense>;
}

// ─── Auth + mode detection ────────────────────────────────────────────────────

type Init =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "autonomous"; questions: FullQuestion[]; socket: Socket }
  | { status: "beamer"; socket: Socket };

function PlayContent() {
  const searchParams = useSearchParams();
  const lobbyId = searchParams.get("lobbyId") ?? "";
  const token = searchParams.get("token") ?? "";

  const [init, setInit] = useState<Init>({ status: "loading" });
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    if (!lobbyId || !token) { setInit({ status: "error", message: "Fehlende Parameter" }); return; }

    let socket: Socket;

    const setReady = (result: Exclude<Init, { status: "loading" | "error" }>) => {
      const remaining = Math.max(0, 3000 - (Date.now() - startTimeRef.current));
      if (remaining > 0) setTimeout(() => setInit(result), remaining);
      else setInit(result);
    };

    fetch("/api/auth/module-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "include",
    }).then(async (res) => {
      if (!res.ok) { setInit({ status: "error", message: "Authentifizierung fehlgeschlagen" }); return; }

      const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || window.location.origin;
      socket = io(socketUrl, { withCredentials: true });

      socket.on("connect_error", () => {
        setInit({ status: "error", message: "Verbindung zum Server fehlgeschlagen" });
      });

      socket.on("connect", () => {
        socket.emit(QUIZ_EVENTS.JOIN, { lobbyId, token }, async (ack: { ok: boolean; gameMode?: string; error?: string }) => {
          if (!ack.ok) { setInit({ status: "error", message: ack.error ?? "Beitreten fehlgeschlagen" }); return; }

          const mode = (ack.gameMode as "AUTONOMOUS" | "BEAMER") ?? "AUTONOMOUS";
          window.parent.postMessage({ type: "READY" }, "*");

          if (mode === "AUTONOMOUS") {
            try {
              const r = await fetch(`/api/sessions/${encodeURIComponent(lobbyId)}/quiz`, { credentials: "include" });
              if (!r.ok) throw new Error();
              const data = await r.json();
              setReady({ status: "autonomous", questions: data.questions, socket });
            } catch {
              setInit({ status: "error", message: "Quiz konnte nicht geladen werden" });
            }
          } else {
            setReady({ status: "beamer", socket });
          }
        });
      });
    });

    return () => { socket?.disconnect(); };
  }, [lobbyId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (init.status === "loading") return (
    <Shell>
      <img src="/logo.png" alt="Quizzl" className="w-32 mb-6 select-none" draggable={false} />
      <p className="text-gray-800 font-bold text-lg">Gleich geht's los!</p>
      <p className="text-gray-400 text-sm mt-1">Verbinde...</p>
    </Shell>
  );

  if (init.status === "error") return (
    <Shell>
      <p className="text-4xl mb-3">⚠️</p>
      <p className="text-gray-700 font-semibold">{init.message}</p>
    </Shell>
  );

  if (init.status === "autonomous") {
    return <AutonomousPlay questions={init.questions} socket={init.socket} />;
  }

  return <BeamerPlay socket={init.socket} />;
}

// ─── AUTONOMOUS mode — fully client-side ──────────────────────────────────────

function AutonomousPlay({ questions, socket }: { questions: FullQuestion[]; socket: Socket }) {
  const [qIndex, setQIndex] = useState(0);
  const [phase, setPhase] = useState<"question" | "revealed" | "ended">("question");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reveal, setReveal] = useState<{ correctAnswerIds: string[]; scoreGained: number; totalScore: number } | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(questions[0]?.timeLimitSecs ?? null);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  const [paused, setPaused] = useState(false);

  // Refs for timer callbacks (avoid stale closures)
  const scoreRef = useRef(0);
  const correctRef = useRef(0);
  const wrongRef = useRef(0);
  const qIndexRef = useRef(0);
  const selectedIdsRef = useRef<string[]>([]);
  const phaseRef = useRef<"question" | "revealed" | "ended">("question");
  const timeLeftRef = useRef<number | null>(questions[0]?.timeLimitSecs ?? null);
  const prevPhaseRef = useRef<"question" | "revealed" | "ended">("question");

  useEffect(() => { qIndexRef.current = qIndex; }, [qIndex]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { timeLeftRef.current = timeLeft; }, [timeLeft]);

  // Socket: END from teacher, SCOREBOARD updates, pause/resume
  useEffect(() => {
    const onEnd = (data: { topScores?: TopScore[] }) => {
      if (data.topScores) setTopScores(data.topScores);
      phaseRef.current = "ended";
      setPhase("ended");
    };
    const onScoreboard = (data: { topN: TopScore[] }) => setTopScores(data.topN);
    const onPause = () => { prevPhaseRef.current = phaseRef.current; setPaused(true); };
    const onResume = () => setPaused(false);
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "END") { phaseRef.current = "ended"; setPhase("ended"); }
    };
    socket.on(QUIZ_EVENTS.END, onEnd);
    socket.on(QUIZ_EVENTS.SCOREBOARD, onScoreboard);
    socket.on(QUIZ_EVENTS.PAUSE, onPause);
    socket.on(QUIZ_EVENTS.RESUME, onResume);
    window.addEventListener("message", onMessage);
    return () => {
      socket.off(QUIZ_EVENTS.END, onEnd);
      socket.off(QUIZ_EVENTS.SCOREBOARD, onScoreboard);
      socket.off(QUIZ_EVENTS.PAUSE, onPause);
      socket.off(QUIZ_EVENTS.RESUME, onResume);
      window.removeEventListener("message", onMessage);
    };
  }, [socket]);

  // Timer countdown (one tick per second, pauses on "paused" or "revealed")
  useEffect(() => {
    if (timeLeft === null || timeLeft <= 0 || paused || phase !== "question") return;
    const id = setTimeout(() => {
      setTimeLeft((t) => {
        const next = t !== null && t > 0 ? t - 1 : t;
        timeLeftRef.current = next;
        return next;
      });
    }, 1000);
    return () => clearTimeout(id);
  }, [timeLeft, paused, phase]);

  // Auto-reveal when timer hits 0
  useEffect(() => {
    if (timeLeft !== 0) return;
    if (phaseRef.current !== "question") return;
    doReveal(selectedIdsRef.current, true);
  }, [timeLeft]); // eslint-disable-line react-hooks/exhaustive-deps

  const doReveal = useCallback((answerIds: string[], timedOut = false) => {
    if (phaseRef.current !== "question") return;
    const q = questions[qIndexRef.current];
    if (!q) return;

    const correctIds = q.answers.filter((a) => a.isCorrect).map((a) => a.id);
    const correct =
      q.answerType === "MULTIPLE_CHOICE"
        ? correctIds.length === answerIds.length &&
          correctIds.every((id) => answerIds.includes(id)) &&
          answerIds.every((id) => correctIds.includes(id))
        : answerIds.length === 1 && correctIds.includes(answerIds[0]);

    let gained = 0;
    if (correct && !timedOut) {
      gained = q.points;
      correctRef.current += 1;
    } else {
      wrongRef.current += 1;
    }

    scoreRef.current += gained;
    phaseRef.current = "revealed";
    setPhase("revealed");
    setReveal({ correctAnswerIds: correctIds, scoreGained: gained, totalScore: scoreRef.current });

    const idx = qIndexRef.current;
    window.parent.postMessage({
      type: "PROGRESS",
      progress: questions.length > 0 ? (idx + 1) / questions.length : 0,
      score: scoreRef.current,
      displayText: `Frage ${idx + 1}/${questions.length} · ${scoreRef.current} Pkt.`,
      details: {
        "Frage": `${idx + 1} / ${questions.length}`,
        "Richtig": correctRef.current,
        "Falsch": wrongRef.current,
        "Punkte": scoreRef.current,
      },
    }, "*");
  }, [questions]);

  const goNext = useCallback(() => {
    const nextIndex = qIndexRef.current + 1;
    if (nextIndex >= questions.length) {
      socket.emit(QUIZ_EVENTS.AUTONOMOUS_COMPLETE, { totalScore: scoreRef.current });
      window.parent.postMessage({ type: "COMPLETE", score: scoreRef.current }, "*");
      phaseRef.current = "ended";
      setPhase("ended");
    } else {
      qIndexRef.current = nextIndex;
      setQIndex(nextIndex);
      phaseRef.current = "question";
      setPhase("question");
      setSelectedIds([]);
      selectedIdsRef.current = [];
      setReveal(null);
      const secs = questions[nextIndex].timeLimitSecs ?? null;
      timeLeftRef.current = secs;
      setTimeLeft(secs);
    }
  }, [questions, socket]);

  const toggleAnswer = (id: string) => {
    if (phaseRef.current !== "question") return;
    const q = questions[qIndexRef.current];
    if (!q) return;
    if (q.answerType === "MULTIPLE_CHOICE") {
      setSelectedIds((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        selectedIdsRef.current = next;
        return next;
      });
    } else {
      selectedIdsRef.current = [id];
      setSelectedIds([id]);
    }
  };

  const submitAnswer = useCallback(() => {
    if (phaseRef.current !== "question" || selectedIdsRef.current.length === 0) return;
    doReveal(selectedIdsRef.current, false);
  }, [doReveal]);

  // ─── Screens ─────────────────────────────────────────────────────────────────

  if (paused) return (
    <Shell>
      <div className="text-5xl mb-3">⏸</div>
      <p className="text-gray-600 text-xl font-bold">Pause</p>
    </Shell>
  );

  if (phase === "ended") return (
    <Shell>
      <p className="text-gray-400 text-xs font-semibold uppercase tracking-widest mb-1">Quiz beendet</p>
      <p className="text-gray-900 text-5xl font-black mb-0.5">{scoreRef.current}</p>
      <p className="text-gray-500 text-base mb-6">Punkte</p>
      {topScores.length > 0 && (
        <div className="w-full max-w-xs rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
          {topScores.slice(0, 5).map((s, i) => (
            <div key={s.rank} className={`flex items-center gap-3 px-4 py-3 bg-white ${i < topScores.length - 1 ? "border-b border-gray-100" : ""}`}>
              <span className={`text-base font-black w-6 text-center ${s.rank === 1 ? "text-yellow-500" : "text-gray-300"}`}>{s.rank}</span>
              <span className="flex-1 text-gray-800 font-medium text-sm truncate">{s.displayName}</span>
              <span className="text-gray-700 font-bold text-sm">{s.score}</span>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );

  const q = questions[qIndex];
  if (!q) return <Shell><Spinner /></Shell>;
  const isMultiple = q.answerType === "MULTIPLE_CHOICE";
  const hasSelection = selectedIds.length > 0;
  const cardQ: CardQuestion = { text: q.text, index: qIndex, total: questions.length, timeLimitSecs: q.timeLimitSecs };

  if (phase === "revealed" && reveal) {
    const correct = reveal.scoreGained > 0;
    return (
      <GameCard question={cardQ} timeLeft={null}>
        <div className="flex flex-col items-center gap-1 mb-4">
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl ${correct ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-500"}`}>
            {correct ? "✓" : "✗"}
          </div>
          <p className={`text-lg font-black mt-1 ${correct ? "text-emerald-600" : "text-red-500"}`}>
            {correct ? "Richtig!" : "Falsch!"}
          </p>
          {correct && <p className="text-gray-700 font-semibold text-base">+{reveal.scoreGained} Punkte</p>}
          <p className="text-gray-400 text-xs">Gesamt: {reveal.totalScore} Punkte</p>
        </div>

        <div className="w-full space-y-2 mb-4">
          {q.answers.map((a) => {
            const isCorrect = reveal.correctAnswerIds.includes(a.id);
            const wasSelected = selectedIds.includes(a.id);
            return (
              <div key={a.id} className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-sm ${
                isCorrect ? "border-emerald-300 bg-emerald-50" : wasSelected ? "border-red-200 bg-red-50" : "border-gray-100 bg-gray-50"
              }`}>
                <span className={`flex-1 font-medium leading-tight ${isCorrect ? "text-emerald-800" : wasSelected ? "text-red-700" : "text-gray-500"}`}>{a.text}</span>
                {isCorrect && <span className="text-emerald-500 font-bold">✓</span>}
              </div>
            );
          })}
        </div>

        {q.explanation && (
          <div className="w-full mb-4 px-3 py-2.5 rounded-xl bg-blue-50 border border-blue-100">
            <p className="text-xs font-semibold text-blue-500 uppercase tracking-wide mb-1">Erklärung</p>
            <p className="text-sm text-blue-900 leading-snug">{q.explanation}</p>
          </div>
        )}

        <button
          onClick={goNext}
          className="w-full py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform"
        >
          {qIndex + 1 >= questions.length ? "Ergebnis ansehen →" : "Nächste Frage →"}
        </button>
      </GameCard>
    );
  }

  return (
    <GameCard question={cardQ} timeLeft={timeLeft}>
      <div className="flex flex-col gap-2.5">
        <div className="grid grid-cols-2 gap-2.5">
          {q.answers.map((a) => {
            const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
            const isSelected = selectedIds.includes(a.id);
            return (
              <button
                key={a.id}
                onClick={() => toggleAnswer(a.id)}
                className={`flex items-center justify-center px-3 py-4 rounded-2xl font-semibold transition-all active:scale-95 text-center text-sm leading-tight
                  ${color.bg} ${color.text}
                  ${isSelected ? "ring-4 ring-white ring-offset-2 ring-offset-gray-50 scale-95" : "shadow-sm"}
                `}
              >
                {a.text}
              </button>
            );
          })}
        </div>
        {hasSelection && (
          <button onClick={submitAnswer} className="w-full py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform">
            {isMultiple ? `Antworten abgeben (${selectedIds.length})` : "Antwort einloggen"}
          </button>
        )}
      </div>
    </GameCard>
  );
}

// ─── BEAMER mode — server-controlled ──────────────────────────────────────────

function BeamerPlay({ socket }: { socket: Socket }) {
  type BeamerPhase = "waiting" | "question" | "answered" | "revealed" | "scoreboard" | "ended" | "paused";
  const [phase, setPhase] = useState<BeamerPhase>("waiting");
  const [question, setQuestion] = useState<BeamerQuestion | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [reveal, setReveal] = useState<RevealData | null>(null);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  const [finalScore, setFinalScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finalScoreRef = useRef(0);
  const prevPhaseRef = useRef<BeamerPhase>("waiting");

  useEffect(() => { finalScoreRef.current = finalScore; }, [finalScore]);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const startTimer = useCallback((secs: number) => {
    clearTimer();
    setTimeLeft(secs);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t === null || t <= 1) { clearTimer(); return 0; }
        return t - 1;
      });
    }, 1000);
  }, [clearTimer]);

  const applyQuestion = useCallback((data: BeamerQuestion) => {
    clearTimer();
    setQuestion(data);
    setSelectedIds([]);
    setSubmitted(false);
    setReveal(null);
    setPhase("question");
    if (data.timeLimitSecs) startTimer(data.remainingSecs ?? data.timeLimitSecs);
    window.parent.postMessage({ type: "PROGRESS", progress: data.total > 0 ? data.index / data.total : 0, score: finalScoreRef.current }, "*");
  }, [clearTimer, startTimer]);

  useEffect(() => {
    const onQuestion = (data: BeamerQuestion) => applyQuestion(data);
    const onTimerSync = ({ remainingSecs }: { remainingSecs: number }) => setTimeLeft(remainingSecs);
    const onReveal = (data: RevealData) => {
      clearTimer();
      setReveal(data);
      setFinalScore(data.totalScore);
      setPhase("revealed");
      setQuestion((q) => {
        if (q) window.parent.postMessage({ type: "PROGRESS", progress: (q.index + 1) / q.total, score: data.totalScore }, "*");
        return q;
      });
    };
    const onScoreboard = (data: { topN: TopScore[] }) => {
      setTopScores(data.topN);
      setPhase("scoreboard");
    };
    const onEnd = (data: { topScores?: TopScore[] }) => {
      clearTimer();
      if (data.topScores) setTopScores(data.topScores);
      setPhase("ended");
      window.parent.postMessage({ type: "COMPLETE", score: finalScoreRef.current }, "*");
    };
    const onPause = () => {
      setPhase((p) => { prevPhaseRef.current = p; return "paused"; });
      clearTimer();
    };
    const onResume = () => setPhase(prevPhaseRef.current);
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "END") { clearTimer(); setPhase("ended"); }
    };

    socket.on(QUIZ_EVENTS.QUESTION, onQuestion);
    socket.on(QUIZ_EVENTS.TIMER_SYNC, onTimerSync);
    socket.on(QUIZ_EVENTS.ANSWER_REVEAL, onReveal);
    socket.on(QUIZ_EVENTS.SCOREBOARD, onScoreboard);
    socket.on(QUIZ_EVENTS.END, onEnd);
    socket.on(QUIZ_EVENTS.PAUSE, onPause);
    socket.on(QUIZ_EVENTS.RESUME, onResume);
    window.addEventListener("message", onMessage);
    return () => {
      socket.off(QUIZ_EVENTS.QUESTION, onQuestion);
      socket.off(QUIZ_EVENTS.TIMER_SYNC, onTimerSync);
      socket.off(QUIZ_EVENTS.ANSWER_REVEAL, onReveal);
      socket.off(QUIZ_EVENTS.SCOREBOARD, onScoreboard);
      socket.off(QUIZ_EVENTS.END, onEnd);
      socket.off(QUIZ_EVENTS.PAUSE, onPause);
      socket.off(QUIZ_EVENTS.RESUME, onResume);
      window.removeEventListener("message", onMessage);
    };
  }, [socket, applyQuestion, clearTimer]);

  const toggleAnswer = (id: string) => {
    if (submitted || !question) return;
    if (question.answerType === "MULTIPLE_CHOICE") {
      setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
    } else {
      setSelectedIds([id]);
      setSubmitted(true);
      socket.emit(QUIZ_EVENTS.SUBMIT_ANSWER, { questionId: question.id, answerIds: [id] });
      setPhase("answered");
    }
  };

  const submitMultiple = () => {
    if (!question || submitted || selectedIds.length === 0) return;
    setSubmitted(true);
    socket.emit(QUIZ_EVENTS.SUBMIT_ANSWER, { questionId: question.id, answerIds: selectedIds });
    setPhase("answered");
  };

  // ─── Screens ───────────────────────────────────────────────────────────────

  if (phase === "paused") return (
    <Shell><div className="text-5xl mb-3">⏸</div><p className="text-gray-600 text-xl font-bold">Pause</p></Shell>
  );

  if (phase === "waiting") return (
    <Shell><Spinner /><p className="mt-4 text-gray-500 text-sm">Warte auf nächste Frage...</p></Shell>
  );

  if (phase === "ended") return (
    <Shell>
      <p className="text-gray-400 text-xs font-semibold uppercase tracking-widest mb-1">Quiz beendet</p>
      <p className="text-gray-900 text-5xl font-black mb-0.5">{finalScore}</p>
      <p className="text-gray-500 text-base mb-6">Punkte</p>
      {topScores.length > 0 && (
        <div className="w-full max-w-xs rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
          {topScores.slice(0, 5).map((s, i) => (
            <div key={s.rank} className={`flex items-center gap-3 px-4 py-3 bg-white ${i < topScores.length - 1 ? "border-b border-gray-100" : ""}`}>
              <span className={`text-base font-black w-6 text-center ${s.rank === 1 ? "text-yellow-500" : "text-gray-300"}`}>{s.rank}</span>
              <span className="flex-1 text-gray-800 font-medium text-sm truncate">{s.displayName}</span>
              <span className="text-gray-700 font-bold text-sm">{s.score}</span>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );

  if (phase === "scoreboard" && topScores.length > 0) return (
    <Shell>
      <p className="text-gray-400 text-xs font-semibold uppercase tracking-widest mb-4">Zwischenstand</p>
      <div className="w-full max-w-xs rounded-2xl border border-gray-100 overflow-hidden shadow-sm">
        {topScores.map((s, i) => (
          <div key={s.rank} className={`flex items-center gap-3 px-4 py-3 bg-white ${i < topScores.length - 1 ? "border-b border-gray-100" : ""} ${s.rank === 1 ? "bg-yellow-50" : ""}`}>
            <span className={`text-base font-black w-6 text-center ${s.rank === 1 ? "text-yellow-500" : "text-gray-300"}`}>{s.rank}</span>
            <span className="flex-1 text-gray-800 font-medium text-sm truncate">{s.displayName}</span>
            <span className="text-gray-700 font-bold text-sm">{s.score}</span>
          </div>
        ))}
      </div>
    </Shell>
  );

  if (phase === "revealed" && reveal) {
    const correct = reveal.scoreGained > 0;
    const cardQ = question ? { text: question.text, index: question.index, total: question.total } : null;
    return (
      <GameCard question={cardQ} timeLeft={null}>
        <div className="flex flex-col items-center gap-1 mb-4">
          <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl ${correct ? "bg-emerald-100 text-emerald-600" : "bg-red-100 text-red-500"}`}>
            {correct ? "✓" : "✗"}
          </div>
          <p className={`text-lg font-black mt-1 ${correct ? "text-emerald-600" : "text-red-500"}`}>
            {correct ? "Richtig!" : "Falsch!"}
          </p>
          {correct && <p className="text-gray-700 font-semibold text-base">+{reveal.scoreGained} Punkte</p>}
          <p className="text-gray-400 text-xs">Gesamt: {reveal.totalScore} Punkte</p>
        </div>
        {question?.answers && (
          <div className="w-full space-y-2">
            {question.answers.map((a) => {
              const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
              const isCorrect = reveal.correctAnswerIds.includes(a.id);
              const wasSelected = selectedIds.includes(a.id);
              return (
                <div key={a.id} className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-sm ${
                  isCorrect ? "border-emerald-300 bg-emerald-50" : wasSelected ? "border-red-200 bg-red-50" : "border-gray-100 bg-gray-50"
                }`}>
                  <span className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shrink-0 ${color.bg} ${color.text}`}>
                    {color.shape}
                  </span>
                  {a.text && <span className={`flex-1 font-medium leading-tight ${isCorrect ? "text-emerald-800" : wasSelected ? "text-red-700" : "text-gray-500"}`}>{a.text}</span>}
                  {isCorrect && <span className="text-emerald-500 font-bold">✓</span>}
                </div>
              );
            })}
          </div>
        )}
      </GameCard>
    );
  }

  if (!question) return <Shell><Spinner /></Shell>;
  const cardQ: CardQuestion = { text: question.text, index: question.index, total: question.total };

  return (
    <GameCard question={cardQ} timeLeft={timeLeft}>
      {phase === "answered" ? (
        <div className="flex flex-col items-center justify-center gap-2 py-6">
          <Spinner />
          <p className="text-gray-400 text-xs">Antwort eingegangen...</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {question.answers.map((a) => {
            const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
            const isSelected = selectedIds.includes(a.id);
            return (
              <button
                key={a.id}
                onClick={() => toggleAnswer(a.id)}
                disabled={submitted}
                className={`flex items-center justify-center p-6 rounded-2xl font-bold transition-all active:scale-95 text-2xl
                  ${color.bg} ${color.text}
                  ${isSelected ? "ring-4 ring-white ring-offset-2 ring-offset-gray-50 scale-95" : "shadow-sm"}
                  ${submitted ? "opacity-50" : "cursor-pointer"}
                `}
              >
                {color.shape}
              </button>
            );
          })}
          {question.answerType === "MULTIPLE_CHOICE" && selectedIds.length > 0 && (
            <button onClick={submitMultiple} className="col-span-2 py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform">
              Antworten abgeben ({selectedIds.length})
            </button>
          )}
        </div>
      )}
    </GameCard>
  );
}

// ─── Shared layout components ─────────────────────────────────────────────────

function GameCard({ children, question, timeLeft }: {
  children: React.ReactNode;
  question?: CardQuestion | null;
  timeLeft?: number | null;
}) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-6">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden flex flex-col min-h-[500px]">
        {question && (
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
              Frage {question.index + 1}/{question.total}
            </span>
            {timeLeft !== null && timeLeft !== undefined && (
              <span className={`font-black text-sm tabular-nums px-2.5 py-0.5 rounded-full ${
                timeLeft <= 5 ? "bg-red-100 text-red-600 animate-pulse" : "bg-gray-100 text-gray-600"
              }`}>
                {String(Math.floor(timeLeft / 60)).padStart(2, "0")}:{String(timeLeft % 60).padStart(2, "0")}
              </span>
            )}
          </div>
        )}
        {question?.text !== undefined && (
          <div className="px-5 pt-4 pb-3 min-h-[88px] flex items-center justify-center">
            {question.text
              ? <p className="text-gray-900 text-base font-bold leading-snug text-center">{question.text}</p>
              : <p className="text-gray-400 text-sm text-center">Schau auf den Beamer</p>
            }
          </div>
        )}
        <div className="px-5 pb-5 flex-1">{children}</div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm text-center flex flex-col items-center">
        {children}
      </div>
    </div>
  );
}

function Spinner({ small }: { small?: boolean }) {
  return (
    <div className={small
      ? "w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin"
      : "w-8 h-8 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin"
    } />
  );
}
