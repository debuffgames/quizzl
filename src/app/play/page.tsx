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
  | "loading"
  | "error"
  | "waiting"
  | "question"
  | "answered"
  | "revealed"
  | "scoreboard"
  | "ended"
  | "paused";

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
  // Ref so socket event handlers (stale closures) can read current gameMode
  const gameModeRef = useRef<"AUTONOMOUS" | "BEAMER">("AUTONOMOUS");

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const startTimer = useCallback((secs: number) => {
    clearTimer();
    setTimeLeft(secs);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t === null || t <= 1) {
          clearTimer();
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  }, []);

  const notifyReady = () => window.parent.postMessage({ type: "READY" }, "*");
  const notifyProgress = (index: number, total: number, score: number) =>
    window.parent.postMessage({ type: "PROGRESS", progress: total > 0 ? index / total : 0, score }, "*");
  const notifyComplete = (score: number) =>
    window.parent.postMessage({ type: "COMPLETE", score }, "*");

  useEffect(() => {
    if (!lobbyId || !token) {
      setError("Fehlende Parameter");
      setPhase("error");
      return;
    }

    fetch("/api/auth/module-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "include",
    }).then((res) => {
      if (!res.ok) {
        setError("Authentifizierung fehlgeschlagen");
        setPhase("error");
        return;
      }

      const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || window.location.origin;
      const socket = io(socketUrl, { withCredentials: true });
      socketRef.current = socket;

      socket.on("connect", () => {
        socket.emit(QUIZ_EVENTS.JOIN, { lobbyId, token }, (ack: { ok: boolean; gameMode?: string; error?: string }) => {
          if (!ack.ok) {
            setError(ack.error ?? "Beitreten fehlgeschlagen");
            setPhase("error");
            return;
          }
          const mode = (ack.gameMode as "AUTONOMOUS" | "BEAMER") ?? "AUTONOMOUS";
          gameModeRef.current = mode;
          setGameMode(mode);
          setPhase("waiting");
          notifyReady();
        });
      });

      socket.on("connect_error", () => {
        setError("Verbindung zum Server fehlgeschlagen");
        setPhase("error");
      });

      socket.on(QUIZ_EVENTS.QUESTION, (data: QuestionData) => {
        clearTimer();
        setQuestion(data);
        setSelectedIds([]);
        setSubmitted(false);
        setReveal(null);
        setPhase("question");
        if (data.timeLimitSecs) startTimer(data.remainingSecs ?? data.timeLimitSecs);
        notifyProgress(data.index, data.total, 0);
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
          if (q) notifyProgress(q.index + 1, q.total, data.totalScore);
          return q;
        });
      });

      socket.on(QUIZ_EVENTS.SCOREBOARD, (data: { topN: TopScore[] }) => {
        setTopScores(data.topN);
        // In AUTONOMOUS mode the server auto-advances — don't interrupt the revealed/waiting screen
        if (gameModeRef.current !== "AUTONOMOUS") setPhase("scoreboard");
      });

      socket.on(QUIZ_EVENTS.END, (data: { topScores?: TopScore[]; finalRank?: number; totalScore?: number }) => {
        clearTimer();
        if (data.topScores) setTopScores(data.topScores);
        if (data.totalScore !== undefined) setFinalScore(data.totalScore);
        setPhase("ended");
        notifyComplete(data.totalScore ?? finalScore);
      });

      socket.on(QUIZ_EVENTS.PAUSE, () => {
        setPhase((p) => { setPrevPhase(p); return "paused"; });
        clearTimer();
      });
      socket.on(QUIZ_EVENTS.RESUME, () => {
        setPhase(prevPhase);
        if (question?.timeLimitSecs && timeLeft && timeLeft > 0) startTimer(timeLeft);
      });
    });

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "PAUSE") socketRef.current?.emit(QUIZ_EVENTS.PAUSE);
      if (event.data?.type === "RESUME") socketRef.current?.emit(QUIZ_EVENTS.RESUME);
      if (event.data?.type === "END") { clearTimer(); setPhase("ended"); }
    };
    window.addEventListener("message", handleMessage);

    return () => {
      clearTimer();
      socketRef.current?.disconnect();
      window.removeEventListener("message", handleMessage);
    };
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
      // Auto-submit only in BEAMER mode (tap → instant); AUTONOMOUS uses explicit button
      if (gameModeRef.current === "BEAMER") {
        setSubmitted(true);
        socketRef.current?.emit(QUIZ_EVENTS.SUBMIT_ANSWER, { questionId: question.id, answerIds: [id] });
        setPhase("answered");
      }
    }
  };

  // ─── Full-screen states ────────────────────────────────────────────────────

  if (phase === "loading") return <Screen><Spinner /><p className="mt-4 text-gray-500">Verbinde...</p></Screen>;
  if (phase === "error") return <Screen><p className="text-red-600 font-semibold text-lg">{error}</p></Screen>;
  if (phase === "paused") return <Screen><p className="text-2xl font-bold text-gray-600">⏸ Pause</p></Screen>;
  if (phase === "waiting") return <Screen><p className="text-gray-500 text-lg">Warte auf die erste Frage...</p><Spinner /></Screen>;

  if (phase === "ended") {
    return (
      <Screen>
        <h2 className="text-2xl font-bold mb-2">Quiz beendet!</h2>
        <p className="text-4xl font-bold text-indigo-600 mb-6">{finalScore} Punkte</p>
        {topScores.length > 0 && (
          <div className="w-full max-w-sm">
            <h3 className="text-sm font-semibold text-gray-500 uppercase mb-2">Top-Ergebnisse</h3>
            {topScores.slice(0, 5).map((s) => (
              <div key={s.rank} className="flex items-center gap-3 py-1">
                <span className="text-gray-400 w-6 text-right">{s.rank}.</span>
                <span className="flex-1">{s.displayName}</span>
                <span className="font-semibold">{s.score}</span>
              </div>
            ))}
          </div>
        )}
      </Screen>
    );
  }

  if (phase === "scoreboard" && topScores.length > 0) {
    return (
      <Screen>
        <h2 className="text-xl font-bold mb-4">Zwischenstand</h2>
        <div className="w-full max-w-sm space-y-1">
          {topScores.map((s) => (
            <div key={s.rank} className={`flex items-center gap-3 py-2 px-3 rounded-lg ${s.rank === 1 ? "bg-yellow-50 border border-yellow-200" : "bg-gray-50"}`}>
              <span className="text-gray-500 w-6 text-right text-sm">{s.rank}.</span>
              <span className="flex-1 font-medium">{s.displayName}</span>
              <span className="font-bold">{s.score}</span>
            </div>
          ))}
        </div>
      </Screen>
    );
  }

  if (phase === "revealed" && reveal) {
    const correct = reveal.scoreGained > 0;
    const isBeamerReveal = gameMode === "BEAMER";
    return (
      <Screen>
        <div className="text-5xl mb-3">{correct ? "✓" : "✗"}</div>
        <p className={`text-2xl font-bold mb-1 ${correct ? "text-green-600" : "text-red-500"}`}>
          {correct ? "Richtig!" : "Falsch!"}
        </p>
        {correct && <p className="text-3xl font-bold text-indigo-600 mb-1">+{reveal.scoreGained}</p>}
        <p className="text-gray-500 text-sm">Gesamt: {reveal.totalScore} Punkte</p>
        {question && (
          <div className="mt-6 w-full max-w-sm space-y-2">
            {question.answers.map((a, i) => {
              const isCorrect = reveal.correctAnswerIds.includes(a.id);
              const wasSelected = selectedIds.includes(a.id);
              const color = ANSWER_COLORS[i % ANSWER_COLORS.length];
              return (
                <div key={a.id} className={`flex items-center gap-3 p-3 rounded-lg border-2 ${
                  isCorrect ? "border-green-400 bg-green-50" : wasSelected ? "border-red-300 bg-red-50" : "border-gray-200 bg-gray-50"
                }`}>
                  {isBeamerReveal && <span className={`w-8 h-8 rounded flex items-center justify-center text-sm font-bold ${color.bg} ${color.text}`}>{color.shape}</span>}
                  {a.text && <span className="flex-1 text-sm">{a.text}</span>}
                  {isCorrect && <span className="text-green-500 text-sm font-bold">✓</span>}
                </div>
              );
            })}
          </div>
        )}
        {/* In AUTONOMOUS mode, show "Weiter" to dismiss reveal screen while server prepares next question */}
        {!isBeamerReveal && (
          <button
            onClick={() => setPhase("waiting")}
            className="mt-6 px-8 py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors"
          >
            Weiter →
          </button>
        )}
      </Screen>
    );
  }

  if (!question) return <Screen><Spinner /></Screen>;

  // ─── Question / answered phase ─────────────────────────────────────────────

  const isBeamer = gameMode === "BEAMER";

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-white border-b shrink-0">
        <span className="text-sm text-gray-500">Frage {question.index + 1}/{question.total}</span>
        {timeLeft !== null && (
          <span className={`text-lg font-bold tabular-nums ${timeLeft <= 5 ? "text-red-500" : "text-gray-700"}`}>
            {String(Math.floor(timeLeft / 60)).padStart(2, "0")}:{String(timeLeft % 60).padStart(2, "0")}
          </span>
        )}
      </div>

      {/* Question text */}
      <div className="px-4 py-5 text-center shrink-0">
        {isBeamer ? (
          <p className="text-gray-400 text-sm">Schau auf den Beamer</p>
        ) : (
          question.text && <p className="text-xl font-semibold leading-snug">{question.text}</p>
        )}
      </div>

      {/* Answer area */}
      {phase === "answered" ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-500 text-lg">Warte auf Auflösung...</p>
        </div>
      ) : isBeamer ? (
        // BEAMER: 2x2 colored shape buttons, single-choice auto-submits on tap
        <div className="flex-1 px-4 pb-4 grid grid-cols-2 gap-3 content-start">
          {question.answers.map((a, i) => {
            const color = ANSWER_COLORS[i % ANSWER_COLORS.length];
            const isSelected = selectedIds.includes(a.id);
            return (
              <button
                key={a.id}
                onClick={() => toggleAnswer(a.id)}
                disabled={submitted}
                className={`flex flex-col items-center justify-center gap-1 p-4 rounded-xl border-2 font-semibold transition-transform active:scale-95 cursor-pointer
                  ${color.bg} ${color.text} ${color.border}
                  ${isSelected ? "ring-4 ring-offset-1 ring-white/60 scale-95" : ""}
                  ${submitted ? "opacity-50 cursor-not-allowed" : ""}
                `}
              >
                <span className="text-2xl">{color.shape}</span>
              </button>
            );
          })}
        </div>
      ) : (
        // AUTONOMOUS: text-only buttons stacked vertically, manual submit
        <div className="flex-1 px-4 pb-2 flex flex-col gap-3">
          {question.answers.map((a) => {
            const isSelected = selectedIds.includes(a.id);
            return (
              <button
                key={a.id}
                onClick={() => toggleAnswer(a.id)}
                disabled={submitted}
                className={`w-full px-4 py-4 rounded-xl border-2 text-left font-medium text-sm transition-colors
                  ${isSelected
                    ? "border-indigo-500 bg-indigo-50 text-indigo-800"
                    : "border-gray-200 bg-white text-gray-800 hover:border-gray-300"}
                  ${submitted ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
                `}
              >
                {a.text}
              </button>
            );
          })}
        </div>
      )}

      {/* Submit — AUTONOMOUS: for any selection; BEAMER: only for MULTIPLE_CHOICE */}
      {!isBeamer && phase === "question" && selectedIds.length > 0 && (
        <div className="px-4 pb-6 shrink-0">
          <button
            onClick={submitAnswer}
            className="w-full py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors"
          >
            Antwort einloggen
          </button>
        </div>
      )}
      {isBeamer && question.answerType === "MULTIPLE_CHOICE" && phase === "question" && selectedIds.length > 0 && (
        <div className="px-4 pb-4 shrink-0">
          <button
            onClick={submitAnswer}
            className="w-full py-3 bg-indigo-600 text-white font-bold rounded-xl hover:bg-indigo-700 transition-colors"
          >
            Antworten abgeben ({selectedIds.length})
          </button>
        </div>
      )}
    </div>
  );
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-center px-6">
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <div className="w-8 h-8 border-4 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />
  );
}
