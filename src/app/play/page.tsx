"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { QUIZ_EVENTS } from "@/lib/socket/events";
import { ANSWER_COLORS } from "@/lib/quiz/colors";

interface AnswerData {
  id: string;
  text?: string;
  sortOrder: number;
}

interface QuestionData {
  id: string;
  text?: string;
  answerType: string;
  answers: AnswerData[];
  timeLimitSecs: number | null;
  remainingSecs?: number | null;
  index: number;
  total: number;
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

type Phase =
  | "loading" | "error" | "waiting"
  | "question" | "answered" | "revealed"
  | "scoreboard" | "ended" | "paused";

export default function PlayPage() {
  return <Suspense><PlayContent /></Suspense>;
}

function PlayContent() {
  const searchParams = useSearchParams();
  const lobbyId = searchParams.get("lobbyId") ?? "";
  const token = searchParams.get("token") ?? "";

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [gameMode, setGameMode] = useState<"AUTONOMOUS" | "BEAMER">("AUTONOMOUS");
  const [question, setQuestion] = useState<QuestionData | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [reveal, setReveal] = useState<RevealData | null>(null);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  const [finalScore, setFinalScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [prevPhase, setPrevPhase] = useState<Phase>("waiting");

  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameModeRef = useRef<"AUTONOMOUS" | "BEAMER">("AUTONOMOUS");
  const phaseRef = useRef<Phase>("loading");
  // Buffer next question while on reveal screen so student controls the pace
  const pendingQuestionRef = useRef<QuestionData | null>(null);
  const finalScoreRef = useRef(0);

  useEffect(() => { phaseRef.current = phase; }, [phase]);
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

  const applyQuestion = useCallback((data: QuestionData) => {
    clearTimer();
    setQuestion(data);
    setSelectedIds([]);
    setSubmitted(false);
    setReveal(null);
    setPhase("question");
    if (data.timeLimitSecs) startTimer(data.remainingSecs ?? data.timeLimitSecs);
    window.parent.postMessage({ type: "PROGRESS", progress: data.total > 0 ? data.index / data.total : 0, score: 0 }, "*");
  }, [clearTimer, startTimer]);

  useEffect(() => {
    if (!lobbyId || !token) { setError("Fehlende Parameter"); setPhase("error"); return; }

    fetch("/api/auth/module-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "include",
    }).then((res) => {
      if (!res.ok) { setError("Authentifizierung fehlgeschlagen"); setPhase("error"); return; }

      const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || window.location.origin;
      const socket = io(socketUrl, { withCredentials: true });
      socketRef.current = socket;

      socket.on("connect", () => {
        socket.emit(QUIZ_EVENTS.JOIN, { lobbyId, token }, (ack: { ok: boolean; gameMode?: string; error?: string }) => {
          if (!ack.ok) { setError(ack.error ?? "Beitreten fehlgeschlagen"); setPhase("error"); return; }
          const mode = (ack.gameMode as "AUTONOMOUS" | "BEAMER") ?? "AUTONOMOUS";
          gameModeRef.current = mode;
          setGameMode(mode);
          setPhase("waiting");
          window.parent.postMessage({ type: "READY" }, "*");
        });
      });

      socket.on("connect_error", () => { setError("Verbindung zum Server fehlgeschlagen"); setPhase("error"); });

      socket.on(QUIZ_EVENTS.QUESTION, (data: QuestionData) => {
        pendingQuestionRef.current = null;
        // Buffer if student is viewing their reveal — they control when to advance
        if (phaseRef.current === "revealed") {
          pendingQuestionRef.current = data;
          return;
        }
        applyQuestion(data);
      });

      socket.on(QUIZ_EVENTS.TIMER_SYNC, ({ remainingSecs }: { remainingSecs: number }) => {
        setTimeLeft(remainingSecs);
      });

      socket.on(QUIZ_EVENTS.ANSWER_REVEAL, (data: RevealData) => {
        clearTimer();
        setReveal(data);
        setFinalScore(data.totalScore);
        setPhase("revealed");
        setQuestion((q) => {
          if (q) window.parent.postMessage({ type: "PROGRESS", progress: (q.index + 1) / q.total, score: data.totalScore }, "*");
          return q;
        });
      });

      socket.on(QUIZ_EVENTS.SCOREBOARD, (data: { topN: TopScore[] }) => {
        setTopScores(data.topN);
        if (gameModeRef.current !== "AUTONOMOUS") setPhase("scoreboard");
      });

      socket.on(QUIZ_EVENTS.END, (data: { topScores?: TopScore[]; finalRank?: number; totalScore?: number }) => {
        clearTimer();
        pendingQuestionRef.current = null;
        if (data.topScores) setTopScores(data.topScores);
        if (data.totalScore !== undefined) setFinalScore(data.totalScore);
        setPhase("ended");
        window.parent.postMessage({ type: "COMPLETE", score: data.totalScore ?? finalScoreRef.current }, "*");
      });

      socket.on(QUIZ_EVENTS.PAUSE, () => { setPhase((p) => { setPrevPhase(p); return "paused"; }); clearTimer(); });
      socket.on(QUIZ_EVENTS.RESUME, () => {
        setPhase(prevPhase);
        if (question?.timeLimitSecs && timeLeft && timeLeft > 0) startTimer(timeLeft);
      });
    });

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "END") { clearTimer(); setPhase("ended"); }
    };
    window.addEventListener("message", handleMessage);
    return () => { clearTimer(); socketRef.current?.disconnect(); window.removeEventListener("message", handleMessage); };
  }, [lobbyId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitAnswer = useCallback(() => {
    if (!question || submitted || selectedIds.length === 0) return;
    setSubmitted(true);
    socketRef.current?.emit(QUIZ_EVENTS.SUBMIT_ANSWER, { questionId: question.id, answerIds: selectedIds });
    setPhase("answered");
  }, [question, submitted, selectedIds]);

  const toggleAnswer = (id: string) => {
    if (submitted) return;
    if (!question) return;
    if (question.answerType === "MULTIPLE_CHOICE") {
      setSelectedIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
    } else {
      setSelectedIds([id]);
      if (gameModeRef.current === "BEAMER") {
        setSubmitted(true);
        socketRef.current?.emit(QUIZ_EVENTS.SUBMIT_ANSWER, { questionId: question.id, answerIds: [id] });
        setPhase("answered");
      }
    }
  };

  const goNext = useCallback(() => {
    const pending = pendingQuestionRef.current;
    pendingQuestionRef.current = null;
    if (pending) {
      applyQuestion(pending);
    } else {
      setPhase("waiting");
    }
  }, [applyQuestion]);

  // ─── Screens ─────────────────────────────────────────────────────────────────

  if (phase === "loading") return (
    <FullScreen bg="bg-[#02512c]">
      <Spinner />
      <p className="mt-4 text-green-200 font-medium">Verbinde...</p>
    </FullScreen>
  );

  if (phase === "error") return (
    <FullScreen bg="bg-[#02512c]">
      <div className="bg-white/10 rounded-2xl px-6 py-5 text-center">
        <p className="text-4xl mb-3">⚠️</p>
        <p className="text-white font-bold text-lg">{error}</p>
      </div>
    </FullScreen>
  );

  if (phase === "paused") return (
    <FullScreen bg="bg-gray-800">
      <div className="text-6xl mb-4">⏸</div>
      <p className="text-white text-2xl font-bold">Pause</p>
    </FullScreen>
  );

  if (phase === "waiting") return (
    <FullScreen bg="bg-[#02512c]">
      <Spinner />
      <p className="mt-5 text-white text-xl font-bold">Warte auf nächste Frage...</p>
    </FullScreen>
  );

  if (phase === "ended") return (
    <FullScreen bg="bg-[#02512c]">
      <p className="text-white/70 text-sm font-medium uppercase tracking-widest mb-2">Quiz beendet</p>
      <p className="text-white text-6xl font-black mb-1">{finalScore}</p>
      <p className="text-green-200 text-lg font-semibold mb-8">Punkte</p>
      {topScores.length > 0 && (
        <div className="w-full max-w-xs bg-white/10 rounded-2xl overflow-hidden">
          {topScores.slice(0, 5).map((s, i) => (
            <div key={s.rank} className={`flex items-center gap-3 px-4 py-3 ${i < topScores.length - 1 ? "border-b border-white/10" : ""}`}>
              <span className={`text-lg font-black w-7 text-center ${s.rank === 1 ? "text-yellow-300" : "text-white/50"}`}>{s.rank}</span>
              <span className="flex-1 text-white font-semibold truncate">{s.displayName}</span>
              <span className="text-white font-bold">{s.score}</span>
            </div>
          ))}
        </div>
      )}
    </FullScreen>
  );

  if (phase === "scoreboard" && topScores.length > 0) return (
    <FullScreen bg="bg-[#02512c]">
      <p className="text-white/70 text-xs font-semibold uppercase tracking-widest mb-4">Zwischenstand</p>
      <div className="w-full max-w-xs bg-white/10 rounded-2xl overflow-hidden">
        {topScores.map((s, i) => (
          <div key={s.rank} className={`flex items-center gap-3 px-4 py-3 ${i < topScores.length - 1 ? "border-b border-white/10" : ""} ${s.rank === 1 ? "bg-yellow-400/20" : ""}`}>
            <span className={`text-lg font-black w-7 text-center ${s.rank === 1 ? "text-yellow-300" : "text-white/50"}`}>{s.rank}</span>
            <span className="flex-1 text-white font-semibold truncate">{s.displayName}</span>
            <span className="text-white font-bold">{s.score}</span>
          </div>
        ))}
      </div>
    </FullScreen>
  );

  if (phase === "revealed" && reveal) {
    const correct = reveal.scoreGained > 0;
    return (
      <FullScreen bg={correct ? "bg-emerald-600" : "bg-rose-600"}>
        <div className="text-7xl mb-3">{correct ? "✓" : "✗"}</div>
        <p className="text-white text-3xl font-black mb-1">{correct ? "Richtig!" : "Falsch!"}</p>
        {correct && (
          <p className="text-white/90 text-2xl font-bold mb-1">+{reveal.scoreGained} Punkte</p>
        )}
        <p className="text-white/70 text-sm mb-8">Gesamt: {reveal.totalScore} Punkte</p>

        {question && (
          <div className="w-full max-w-sm space-y-2 mb-6">
            {question.answers.map((a) => {
              const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
              const isCorrect = reveal.correctAnswerIds.includes(a.id);
              const wasSelected = selectedIds.includes(a.id);
              return (
                <div key={a.id} className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 ${
                  isCorrect
                    ? "bg-white border-white text-gray-900"
                    : wasSelected
                    ? "bg-white/20 border-white/40 text-white"
                    : "bg-white/10 border-white/20 text-white/70"
                }`}>
                  <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${color.bg} ${color.text}`}>
                    {color.shape}
                  </span>
                  {a.text && <span className="flex-1 text-sm font-medium leading-tight">{a.text}</span>}
                  {isCorrect && <span className="text-green-600 font-bold text-lg">✓</span>}
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={goNext}
          className="w-full max-w-sm py-4 bg-white text-gray-900 font-black text-lg rounded-2xl shadow-lg active:scale-95 transition-transform"
        >
          Nächste Frage →
        </button>
      </FullScreen>
    );
  }

  if (!question) return <FullScreen bg="bg-[#02512c]"><Spinner /></FullScreen>;

  const isBeamer = gameMode === "BEAMER";
  const isMultiple = question.answerType === "MULTIPLE_CHOICE";
  const hasSelection = selectedIds.length > 0;
  const answered = phase === "answered";

  // ─── Question screen ──────────────────────────────────────────────────────

  return (
    <div className="flex flex-col min-h-screen bg-[#02512c]">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 shrink-0">
        <span className="text-green-200 text-sm font-semibold">
          Frage {question.index + 1}<span className="text-green-400">/{question.total}</span>
        </span>
        {timeLeft !== null && (
          <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full font-black text-lg tabular-nums
            ${timeLeft <= 5 ? "bg-red-500 text-white animate-pulse" : "bg-white/20 text-white"}`}>
            {String(Math.floor(timeLeft / 60)).padStart(2, "0")}:{String(timeLeft % 60).padStart(2, "0")}
          </div>
        )}
      </div>

      {/* Question text */}
      <div className="px-5 pb-5 shrink-0">
        {isBeamer ? (
          <p className="text-green-300 text-base text-center font-medium">Schau auf den Beamer</p>
        ) : (
          question.text && (
            <p className="text-white text-xl font-bold leading-snug text-center">{question.text}</p>
          )
        )}
      </div>

      {/* Answer area */}
      <div className="flex-1 flex flex-col px-4 gap-3">
        {answered ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <Spinner />
            <p className="text-green-200 text-lg font-semibold">Antwort eingegangen...</p>
          </div>
        ) : isBeamer ? (
          // BEAMER: 2x2 colored buttons, no text
          <div className="grid grid-cols-2 gap-3 flex-1 content-start">
            {question.answers.map((a) => {
              const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
              const isSelected = selectedIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => toggleAnswer(a.id)}
                  disabled={submitted}
                  className={`flex flex-col items-center justify-center gap-2 p-5 rounded-2xl font-bold transition-all active:scale-95
                    ${color.bg} ${color.text}
                    ${isSelected ? "ring-4 ring-white ring-offset-2 ring-offset-[#02512c] scale-95" : ""}
                    ${submitted ? "opacity-50" : "cursor-pointer shadow-md"}
                  `}
                >
                  <span className="text-3xl">{color.shape}</span>
                </button>
              );
            })}
            {/* BEAMER MULTIPLE_CHOICE submit */}
            {isMultiple && hasSelection && (
              <button
                onClick={submitAnswer}
                className="col-span-2 py-4 bg-white text-gray-900 font-black text-base rounded-2xl shadow-lg active:scale-95 transition-transform"
              >
                Antworten abgeben ({selectedIds.length})
              </button>
            )}
          </div>
        ) : (
          // AUTONOMOUS: colorful buttons with text + submit directly below
          <>
            <div className="grid grid-cols-2 gap-3">
              {question.answers.map((a) => {
                const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
                const isSelected = selectedIds.includes(a.id);
                return (
                  <button
                    key={a.id}
                    onClick={() => toggleAnswer(a.id)}
                    disabled={submitted}
                    className={`flex flex-col items-start gap-1.5 p-4 rounded-2xl font-semibold transition-all active:scale-95 text-left
                      ${color.bg} ${color.text}
                      ${isSelected ? "ring-4 ring-white ring-offset-2 ring-offset-[#02512c] scale-95" : "shadow-md"}
                      ${submitted ? "opacity-50" : "cursor-pointer"}
                    `}
                  >
                    <span className="text-xl">{color.shape}</span>
                    {a.text && <span className="text-sm leading-tight">{a.text}</span>}
                  </button>
                );
              })}
            </div>

            {/* Submit button directly below answers */}
            {hasSelection && !submitted && (
              <button
                onClick={submitAnswer}
                className="w-full py-4 bg-white text-[#02512c] font-black text-lg rounded-2xl shadow-lg active:scale-95 transition-transform mt-1"
              >
                {isMultiple ? `Antworten abgeben (${selectedIds.length})` : "Antwort einloggen"}
              </button>
            )}
          </>
        )}
      </div>

      <div className="h-4 shrink-0" />
    </div>
  );
}

function FullScreen({ children, bg }: { children: React.ReactNode; bg?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center min-h-screen text-center px-6 ${bg ?? "bg-[#02512c]"}`}>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-10 h-10 border-4 border-white/30 border-t-white rounded-full animate-spin" />
  );
}
