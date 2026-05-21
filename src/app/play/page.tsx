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
  const [readyForNext, setReadyForNext] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gameModeRef = useRef<"AUTONOMOUS" | "BEAMER">("AUTONOMOUS");
  const phaseRef = useRef<Phase>("loading");
  // Buffer next question while on reveal screen so student controls the pace
  const pendingQuestionRef = useRef<QuestionData | null>(null);
  const readyForNextRef = useRef(false);
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
        // If student already clicked "Nächste Frage", apply immediately
        if (readyForNextRef.current) {
          readyForNextRef.current = false;
          setReadyForNext(false);
          applyQuestion(data);
          return;
        }
        // Buffer while student is still reading the reveal screen
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
      return;
    }
    // Ask server for next question immediately (AUTONOMOUS: per-student pacing)
    readyForNextRef.current = true;
    setReadyForNext(true);
    socketRef.current?.emit(QUIZ_EVENTS.READY_FOR_NEXT);
  }, [applyQuestion]);

  // ─── Screens ─────────────────────────────────────────────────────────────────

  if (phase === "loading") return (
    <Shell>
      <Spinner />
      <p className="mt-4 text-gray-400 text-sm">Verbinde...</p>
    </Shell>
  );

  if (phase === "error") return (
    <Shell>
      <p className="text-4xl mb-3">⚠️</p>
      <p className="text-gray-700 font-semibold">{error}</p>
    </Shell>
  );

  if (phase === "paused") return (
    <Shell>
      <div className="text-5xl mb-3">⏸</div>
      <p className="text-gray-600 text-xl font-bold">Pause</p>
    </Shell>
  );

  if (phase === "waiting") return (
    <Shell>
      <Spinner />
      <p className="mt-4 text-gray-500 text-sm">Warte auf nächste Frage...</p>
    </Shell>
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
    return (
      <GameCard question={question} timeLeft={null}>
        {/* Result */}
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

        {/* Answer list without icons in AUTONOMOUS */}
        {question && (
          <div className="w-full space-y-2 mb-4">
            {question.answers.map((a) => {
              const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
              const isCorrect = reveal.correctAnswerIds.includes(a.id);
              const wasSelected = selectedIds.includes(a.id);
              return (
                <div key={a.id} className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-sm ${
                  isCorrect ? "border-emerald-300 bg-emerald-50" : wasSelected ? "border-red-200 bg-red-50" : "border-gray-100 bg-gray-50"
                }`}>
                  {isBeamer && (
                    <span className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shrink-0 ${color.bg} ${color.text}`}>
                      {color.shape}
                    </span>
                  )}
                  {a.text && <span className={`flex-1 font-medium leading-tight ${isCorrect ? "text-emerald-800" : wasSelected ? "text-red-700" : "text-gray-500"}`}>{a.text}</span>}
                  {isCorrect && <span className="text-emerald-500 font-bold">✓</span>}
                </div>
              );
            })}
          </div>
        )}

        <button
          onClick={goNext}
          disabled={readyForNext}
          className="w-full py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform disabled:opacity-60 flex items-center justify-center gap-2"
        >
          {readyForNext ? <><Spinner small />Gleich...</> : "Nächste Frage →"}
        </button>
      </GameCard>
    );
  }

  if (!question) return <Shell><Spinner /></Shell>;

  const isBeamer = gameMode === "BEAMER";
  const isMultiple = question.answerType === "MULTIPLE_CHOICE";
  const hasSelection = selectedIds.length > 0;
  const answered = phase === "answered";

  // ─── Question screen ──────────────────────────────────────────────────────

  return (
    <GameCard question={question} timeLeft={timeLeft}>
      {answered ? (
        <div className="flex flex-col items-center justify-center gap-2 py-6">
          <Spinner />
          <p className="text-gray-400 text-xs">Antwort eingegangen...</p>
        </div>
      ) : isBeamer ? (  // BEAMER: big colored shape buttons only
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
          {isMultiple && hasSelection && (
            <button onClick={submitAnswer} className="col-span-2 py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform">
              Antworten abgeben ({selectedIds.length})
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            {question.answers.map((a) => {
              const color = ANSWER_COLORS[a.sortOrder % ANSWER_COLORS.length];
              const isSelected = selectedIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  onClick={() => toggleAnswer(a.id)}
                  disabled={submitted}
                  className={`flex items-center justify-center px-3 py-4 rounded-2xl font-semibold transition-all active:scale-95 text-center text-sm leading-tight
                    ${color.bg} ${color.text}
                    ${isSelected ? "ring-4 ring-white ring-offset-2 ring-offset-gray-50 scale-95" : "shadow-sm"}
                    ${submitted ? "opacity-50" : "cursor-pointer"}
                  `}
                >
                  {a.text}
                </button>
              );
            })}
          </div>
          {hasSelection && !submitted && (
            <button onClick={submitAnswer} className="w-full py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform">
              {isMultiple ? `Antworten abgeben (${selectedIds.length})` : "Antwort einloggen"}
            </button>
          )}
        </div>
      )}
    </GameCard>
  );
}

// ─── Shared layout components ─────────────────────────────────────────────────

interface GameCardProps {
  children: React.ReactNode;
  question?: QuestionData | null;
  timeLeft?: number | null;
}

function GameCard({ children, question, timeLeft }: GameCardProps) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-4 py-6">
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        {/* Fixed header strip */}
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

        {/* Question text — fixed-height area so card doesn't jump */}
        {question && (
          <div className="px-5 pt-4 pb-3 min-h-[80px] flex items-center justify-center">
            {question.text
              ? <p className="text-gray-900 text-base font-bold leading-snug text-center">{question.text}</p>
              : <p className="text-gray-400 text-sm text-center">Schau auf den Beamer</p>
            }
          </div>
        )}

        {/* Content */}
        <div className="px-5 pb-5">
          {children}
        </div>
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
