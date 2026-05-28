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
  speedMode?: string;
  answersVisibleAt?: number | null;
  bossAbility?: string | null;
  alreadyAnswered?: boolean;
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
  answerType?: string;
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
  | { status: "beamer"; socket: Socket; beamerMode: string };

function PlayContent() {
  const searchParams = useSearchParams();
  const lobbyId = searchParams.get("lobbyId") ?? "";
  const token = searchParams.get("token") ?? "";

  const [init, setInit] = useState<Init>({ status: "loading" });
  const [reconnecting, setReconnecting] = useState(false);
  const startTimeRef = useRef(Date.now());
  const hasJoinedRef = useRef(false);

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

      socket.on("disconnect", () => {
        if (hasJoinedRef.current) setReconnecting(true);
      });

      socket.on("connect", () => {
        setReconnecting(false);
        socket.emit(QUIZ_EVENTS.JOIN, { lobbyId, token }, async (ack: { ok: boolean; gameMode?: string; beamerMode?: string; error?: string }) => {
          if (!ack.ok) {
            if (!hasJoinedRef.current) setInit({ status: "error", message: ack.error ?? "Beitreten fehlgeschlagen" });
            return;
          }

          const isReconnect = hasJoinedRef.current;
          hasJoinedRef.current = true;
          if (isReconnect) return;

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
            setReady({ status: "beamer", socket, beamerMode: ack.beamerMode ?? "STANDARD" });
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
    return <AutonomousPlay questions={init.questions} socket={init.socket} reconnecting={reconnecting} />;
  }

  return <BeamerPlay socket={init.socket} reconnecting={reconnecting} initialBeamerMode={init.beamerMode} />;
}

// ─── AUTONOMOUS mode — fully client-side ──────────────────────────────────────

function AutonomousPlay({ questions, socket, reconnecting }: { questions: FullQuestion[]; socket: Socket; reconnecting: boolean }) {
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
  const questionStartedAtRef = useRef(Date.now());

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
    const timeTakenSecs = Math.max(0, (Date.now() - questionStartedAtRef.current) / 1000);
    socket.emit(QUIZ_EVENTS.STUDENT_PROGRESS, {
      questionId: q.id,
      questionIndex: idx,
      answerIds,
      isCorrect: gained > 0,
      timeTakenSecs: parseFloat(timeTakenSecs.toFixed(1)),
    });

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
      window.parent.postMessage({
        type: "PROGRESS",
        progress: 1,
        score: scoreRef.current,
        displayText: `Fertig · ${scoreRef.current} Pkt.`,
        details: { "Status": "Fertig ✓", "Richtig": correctRef.current, "Falsch": wrongRef.current, "Punkte": scoreRef.current },
      }, "*");
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
      questionStartedAtRef.current = Date.now();
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
      doReveal([id], false);
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
  const cardQ: CardQuestion = { text: q.text, answerType: q.answerType, index: qIndex, total: questions.length, timeLimitSecs: q.timeLimitSecs };

  if (phase === "revealed" && reveal) {
    const correct = reveal.scoreGained > 0;
    return (
      <GameCard question={cardQ} timeLeft={null} showLogo>
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
    <>
      {reconnecting && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-500 text-white text-xs font-semibold text-center py-1.5 px-4">
          Verbindung unterbrochen – wird neu verbunden…
        </div>
      )}
      <GameCard question={cardQ} timeLeft={timeLeft} showLogo>
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
          {isMultiple && hasSelection && (
            <button onClick={submitAnswer} className="w-full py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform">
              Antworten abgeben ({selectedIds.length})
            </button>
          )}
        </div>
      </GameCard>
    </>
  );
}

// ─── BEAMER mode — server-controlled ──────────────────────────────────────────

function BeamerPlay({ socket, reconnecting, initialBeamerMode }: { socket: Socket; reconnecting: boolean; initialBeamerMode: string }) {
  type BeamerPhase = "waiting" | "question" | "answered" | "revealed" | "scoreboard" | "ended" | "paused";
  const [phase, setPhase] = useState<BeamerPhase>("waiting");
  const [question, setQuestion] = useState<BeamerQuestion | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [reveal, setReveal] = useState<RevealData | null>(null);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  const [finalScore, setFinalScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [answersUnlocked, setAnswersUnlocked] = useState(true);
  const [teamInfo, setTeamInfo] = useState<{ teamIndex: number; teamName: string } | null>(null);
  const [myTeamHp, setMyTeamHp] = useState<{ hp: number; maxHp: number } | null>(null);
  const [dancing, setDancing] = useState(false);
  const [bossMode, setBossMode] = useState(false);
  const teamInfoRef = useRef<{ teamIndex: number; teamName: string } | null>(null);
  useEffect(() => { teamInfoRef.current = teamInfo; }, [teamInfo]);

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
    setReveal(null);
    const isBlitz = data.speedMode === "BLITZ";
    const visibleNow = data.answersVisibleAt !== null && data.answersVisibleAt !== undefined;
    setAnswersUnlocked(!isBlitz || visibleNow);
    setDancing(data.bossAbility === "DANCING_BUZZERS");
    if (data.alreadyAnswered) {
      setSelectedIds([]);
      setSubmitted(true);
      setPhase("answered");
    } else {
      setSelectedIds([]);
      setSubmitted(false);
      setPhase("question");
    }
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
    const onAnswersVisible = () => setAnswersUnlocked(true);
    const onTeamAssigned = (data: { teamIndex: number; teamName: string }) => setTeamInfo(data);
    const onShieldState = (data: { teams: { name: string; hp: number; maxHp: number }[] }) => {
      const ti = teamInfoRef.current;
      if (ti === null) return;
      const myTeam = data.teams[ti.teamIndex];
      if (myTeam) setMyTeamHp({ hp: myTeam.hp, maxHp: myTeam.maxHp });
    };
    const onBossState = (data: { ability?: string | null }) => {
      setBossMode(true);
      setDancing(data.ability === "DANCING_BUZZERS");
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
    socket.on(QUIZ_EVENTS.ANSWERS_VISIBLE, onAnswersVisible);
    socket.on(QUIZ_EVENTS.TEAM_ASSIGNED, onTeamAssigned);
    socket.on(QUIZ_EVENTS.SHIELD_STATE, onShieldState);
    socket.on(QUIZ_EVENTS.BOSS_STATE, onBossState);
    window.addEventListener("message", onMessage);
    return () => {
      socket.off(QUIZ_EVENTS.QUESTION, onQuestion);
      socket.off(QUIZ_EVENTS.TIMER_SYNC, onTimerSync);
      socket.off(QUIZ_EVENTS.ANSWER_REVEAL, onReveal);
      socket.off(QUIZ_EVENTS.SCOREBOARD, onScoreboard);
      socket.off(QUIZ_EVENTS.END, onEnd);
      socket.off(QUIZ_EVENTS.PAUSE, onPause);
      socket.off(QUIZ_EVENTS.RESUME, onResume);
      socket.off(QUIZ_EVENTS.ANSWERS_VISIBLE, onAnswersVisible);
      socket.off(QUIZ_EVENTS.TEAM_ASSIGNED, onTeamAssigned);
      socket.off(QUIZ_EVENTS.SHIELD_STATE, onShieldState);
      socket.off(QUIZ_EVENTS.BOSS_STATE, onBossState);
      window.removeEventListener("message", onMessage);
    };
  }, [socket, applyQuestion, clearTimer]);

  const toggleAnswer = (id: string) => {
    if (submitted || !question || !answersUnlocked) return;
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

  if (reconnecting) return (
    <Shell>
      <div className="w-10 h-10 border-4 border-gray-300 border-t-gray-600 rounded-full animate-spin mb-4" />
      <p className="text-gray-500 text-sm font-semibold">Verbindung unterbrochen – wird neu verbunden…</p>
    </Shell>
  );

  if (phase === "paused") return (
    <Shell><div className="text-5xl mb-3">⏸</div><p className="text-gray-600 text-xl font-bold">Pause</p></Shell>
  );

  if (phase === "waiting") return (
    <ModeStartScreen beamerMode={initialBeamerMode} teamInfo={teamInfo} />
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
    const cardQ = question ? { text: question.text, answerType: question.answerType, index: question.index, total: question.total } : null;
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
  const cardQ: CardQuestion = { text: question.text, answerType: question.answerType, index: question.index, total: question.total };

  return (
    <GameCard question={cardQ} timeLeft={timeLeft} teamInfo={teamInfo} myTeamHp={myTeamHp} bossMode={bossMode}>
      {phase === "answered" ? (
        <div className="flex flex-col items-center justify-center gap-2 py-6">
          <Spinner />
          <p className="text-gray-400 text-xs">Antwort eingegangen...</p>
        </div>
      ) : !answersUnlocked ? (
        <div className="flex flex-col items-center justify-center gap-3 py-8">
          <span className="text-4xl">🔒</span>
          <p className="text-gray-400 text-sm font-semibold">Warte auf den Lehrer...</p>
        </div>
      ) : dancing ? (
        <>
          <DancingBuzzers answers={question.answers} onAnswer={toggleAnswer} submitted={submitted} selectedIds={selectedIds} />
          {question.answerType === "MULTIPLE_CHOICE" && selectedIds.length > 0 && (
            <button onClick={submitMultiple} className="mt-3 w-full py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform">
              Antworten abgeben ({selectedIds.length})
            </button>
          )}
        </>
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

function GameCard({ children, question, timeLeft, teamInfo, myTeamHp, bossMode, showLogo }: {
  children: React.ReactNode;
  question?: CardQuestion | null;
  timeLeft?: number | null;
  teamInfo?: { teamIndex: number; teamName: string } | null;
  myTeamHp?: { hp: number; maxHp: number } | null;
  bossMode?: boolean;
  showLogo?: boolean;
}) {
  const teamColor = teamInfo?.teamIndex === 0 ? "#22c55e" : "#f97316";
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-6" style={teamInfo ? { borderTop: `6px solid ${teamColor}` } : undefined}>
      {showLogo && !teamInfo && !bossMode && (
        <img src="/quizzl_logo.png" alt="Quizzl" className="w-full max-w-sm mb-4 px-8 select-none" draggable={false} />
      )}
      {teamInfo && (
        <div className="w-full max-w-sm mb-3 flex flex-col items-center gap-1">
          <img
            src={teamInfo.teamIndex === 0 ? "/ch/edo_solo.png" : "/ch/parus.png"}
            alt={teamInfo.teamIndex === 0 ? "Edo" : "Parus"}
            className="h-72 w-auto object-contain select-none pointer-events-none"
            draggable={false}
          />
          <span className="text-2xl font-black tracking-tight" style={{ color: teamColor }}>
            {teamInfo.teamName}
          </span>
          {myTeamHp !== null && myTeamHp !== undefined && (
            <div className="flex flex-col items-center gap-0.5 w-full">
              <span className="text-sm font-bold" style={{ color: teamColor }}>
                Schild: {myTeamHp.hp} / {myTeamHp.maxHp}
              </span>
              <div className="w-full max-w-[200px] h-2 rounded-full bg-gray-200 overflow-hidden">
                <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${Math.max(0, Math.round((myTeamHp.hp / Math.max(myTeamHp.maxHp, 1)) * 100))}%`, backgroundColor: teamColor }} />
              </div>
            </div>
          )}
        </div>
      )}
      {bossMode && (
        <div className="w-full max-w-sm mb-3 flex items-end justify-center gap-3">
          <img src="/ch/trizea.png" alt="Trizea" className="h-48 w-auto object-contain select-none pointer-events-none" draggable={false} />
          <img src="/ch/parus.png" alt="Parus" className="h-60 w-auto object-contain select-none pointer-events-none" draggable={false} />
          <img src="/ch/edo_solo.png" alt="Edo" className="h-48 w-auto object-contain select-none pointer-events-none" draggable={false} />
        </div>
      )}
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
          <div className="px-5 pt-4 pb-3 min-h-[88px] flex flex-col items-center justify-center gap-1.5">
            {question.text
              ? <p className="text-gray-900 text-base font-bold leading-snug text-center">{question.text}</p>
              : <p className="text-gray-400 text-sm text-center">Schau auf den Beamer</p>
            }
            {question.answerType && (
              <p className="text-xs font-semibold text-indigo-500 text-center leading-tight">{questionTypeHint(question.answerType)}</p>
            )}
          </div>
        )}
        <div className="px-5 pb-5 flex-1">{children}</div>
      </div>
    </div>
  );
}

function ModeStartScreen({ beamerMode, teamInfo }: {
  beamerMode: string;
  teamInfo: { teamIndex: number; teamName: string } | null;
}) {
  const teamColor = teamInfo?.teamIndex === 0 ? "#22c55e" : "#f97316";

  if (beamerMode === "BOSS") {
    return (
      <Shell>
        <img src="/quizzl_logo.png" alt="Quizzl" className="w-36 mb-5 select-none" draggable={false} />
        <h1 className="text-xl font-black text-gray-900 mb-4">Boss-Kampf</h1>
        <img src="/ch/troodos.png" alt="Troodos" className="h-44 w-auto object-contain mb-5 select-none pointer-events-none" draggable={false} />
        <p className="text-gray-600 text-base text-center leading-relaxed max-w-xs">
          Troodos denkt, er wäre der schlauste Dino der Welt.<br />
          Du spielst im Team mit allen anderen.<br />
          Beantworte Fragen korrekt um Troodos zu zeigen, wer schlauer ist!
        </p>
      </Shell>
    );
  }

  if (beamerMode === "TEAM_SHIELD") {
    return (
      <Shell>
        <img src="/quizzl_logo.png" alt="Quizzl" className="w-36 mb-5 select-none" draggable={false} />
        <h1 className="text-xl font-black text-gray-900 mb-4">Team-Modus</h1>
        <div className="flex items-end gap-2 mb-5">
          <img src="/ch/edo_solo.png" alt="Team Grün" className="h-32 w-auto object-contain select-none pointer-events-none" draggable={false} />
          <img src="/ch/parus.png" alt="Team Orange" className="h-32 w-auto object-contain select-none pointer-events-none" draggable={false} />
        </div>
        <p className="text-gray-600 text-base text-center leading-relaxed max-w-xs">
          Team Grün und Team Orange treten gegeneinander an.
          {teamInfo ? (
            <> Du bist in <span className="font-black" style={{ color: teamColor }}>{teamInfo.teamName}</span>.</>
          ) : null}
          <br />Beantworte Fragen korrekt um dein Team zu unterstützen!
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <img src="/quizzl_logo.png" alt="Quizzl" className="w-36 mb-5 select-none" draggable={false} />
      <h1 className="text-xl font-black text-gray-900 mb-4">Quizzl</h1>
      <img src="/ch/edo_solo.png" alt="Edo" className="h-44 w-auto object-contain mb-5 select-none pointer-events-none" draggable={false} />
      <p className="text-gray-600 text-base text-center leading-relaxed max-w-xs">
        Alle Spieler treten gegeneinander an.<br />
        Beantworte Fragen korrekt um möglichst viele Punkte zu sammeln!
      </p>
    </Shell>
  );
}

function questionTypeHint(answerType: string): string {
  switch (answerType) {
    case "MULTIPLE_CHOICE": return "Es gibt mehrere richtige Antworten – bestätige deine Auswahl!";
    case "YES_NO": return "Ja oder Nein?";
    default: return "Es gibt eine richtige Antwort";
  }
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

const DANCING_BUTTON_SIZE = 88;

function DancingBuzzers({
  answers,
  onAnswer,
  submitted,
  selectedIds = [],
}: {
  answers: BeamerQuestion["answers"];
  onAnswer: (id: string) => void;
  submitted: boolean;
  selectedIds?: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Array<{ x: number; y: number }>>(() =>
    answers.map((_, i) => ({ x: i * 20, y: i * 20 }))
  );
  const [durations, setDurations] = useState<number[]>(() => answers.map(() => 0.7));

  useEffect(() => {
    const el = containerRef.current;
    const getPos = () => {
      const w = el ? el.offsetWidth : 300;
      const h = el ? el.offsetHeight : 260;
      return {
        x: Math.random() * Math.max(0, w - DANCING_BUTTON_SIZE),
        y: Math.random() * Math.max(0, h - DANCING_BUTTON_SIZE),
      };
    };

    const ids: ReturnType<typeof setTimeout>[] = [];

    const schedule = (idx: number): ReturnType<typeof setTimeout> =>
      setTimeout(
        () => {
          setPositions((prev) => { const n = [...prev]; n[idx] = getPos(); return n; });
          setDurations((prev) => { const n = [...prev]; n[idx] = 0.3 + Math.random() * 0.9; return n; });
          ids[idx] = schedule(idx);
        },
        350 + Math.random() * 950,
      );

    setPositions(answers.map(() => getPos()));
    answers.forEach((_, idx) => {
      ids[idx] = setTimeout(() => { ids[idx] = schedule(idx); }, idx * 120 + Math.random() * 200);
    });

    return () => ids.forEach((id) => clearTimeout(id));
  }, [answers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: "260px" }}>
      {answers.map((a, idx) => {
        const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
        const pos = positions[idx] ?? { x: 0, y: 0 };
        const dur = durations[idx] ?? 0.7;
        return (
          <button
            key={a.id}
            onClick={() => onAnswer(a.id)}
            disabled={submitted}
            className={`absolute flex items-center justify-center rounded-2xl font-bold text-2xl shadow-lg active:scale-95 ${color.bg} ${color.text} ${selectedIds.includes(a.id) ? "ring-4 ring-white ring-offset-2 ring-offset-gray-50 scale-90" : ""}`}
            style={{
              width: `${DANCING_BUTTON_SIZE}px`,
              height: `${DANCING_BUTTON_SIZE}px`,
              left: `${pos.x}px`,
              top: `${pos.y}px`,
              transition: `left ${dur}s cubic-bezier(0.25,0.46,0.45,0.94), top ${dur}s cubic-bezier(0.34,1.56,0.64,1)`,
            }}
          >
            {color.shape}
          </button>
        );
      })}
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
