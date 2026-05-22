"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { QUIZ_EVENTS } from "@/lib/socket/events";
import { ANSWER_COLORS } from "@/lib/quiz/colors";

interface AnswerData { id: string; text: string; sortOrder: number; }
interface QuestionData {
  id: string; text: string; answerType: string;
  answers: AnswerData[]; timeLimitSecs: number | null; index: number; total: number;
  explanation?: string | null;
}
interface TopScore { rank: number; displayName: string; score: number; }

type Phase = "loading" | "error" | "waiting" | "question" | "revealed" | "scoreboard";

export default function BeamerPage() {
  return <Suspense><BeamerContent /></Suspense>;
}

function BeamerContent() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState<QuestionData | null>(null);
  const [correctIds, setCorrectIds] = useState<string[]>([]);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  const [responseCount, setResponseCount] = useState<{ answered: number; total: number } | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };

  const startTimer = (secs: number) => {
    clearTimer();
    setTimeLeft(secs);
    timerRef.current = setInterval(() => {
      setTimeLeft((t) => {
        if (t === null || t <= 1) { clearTimer(); return 0; }
        return t - 1;
      });
    }, 1000);
  };

  useEffect(() => {
    if (!sessionId || !token) { setError("Fehlende Parameter"); setPhase("error"); return; }

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
        socket.emit(QUIZ_EVENTS.BEAMER_JOIN, { sessionId, token }, (ack: { ok: boolean; error?: string }) => {
          if (!ack.ok) { setError(ack.error ?? "Verbindung fehlgeschlagen"); setPhase("error"); return; }
          setPhase("waiting");
        });
      });

      socket.on("connect_error", () => { setError("Verbindung fehlgeschlagen"); setPhase("error"); });

      socket.on(QUIZ_EVENTS.QUESTION, (data: QuestionData) => {
        clearTimer();
        setQuestion(data);
        setCorrectIds([]);
        setResponseCount(null);
        setPhase("question");
        if (data.timeLimitSecs) startTimer(data.timeLimitSecs);
      });

      socket.on(QUIZ_EVENTS.TIMER_SYNC, ({ remainingSecs }: { remainingSecs: number }) => setTimeLeft(remainingSecs));

      socket.on(QUIZ_EVENTS.RESPONSE_COUNT, (data: { answered: number; total: number }) => setResponseCount(data));

      socket.on(QUIZ_EVENTS.ANSWER_REVEAL, ({ correctAnswerIds }: { correctAnswerIds: string[] }) => {
        clearTimer();
        setCorrectIds(correctAnswerIds);
        setPhase("revealed");
      });

      socket.on(QUIZ_EVENTS.SCOREBOARD, ({ topN }: { topN: TopScore[] }) => {
        setTopScores(topN);
        // Don't change phase — teacher controls flow; stay on revealed until next question
      });

      socket.on(QUIZ_EVENTS.END, ({ topScores: ts }: { topScores: TopScore[] }) => {
        clearTimer();
        if (ts) setTopScores(ts);
        setPhase("scoreboard");
      });
    });

    return () => {
      clearTimer();
      socketRef.current?.disconnect();
    };
  }, [sessionId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ───────────────────────────────────────────────────────────────

  if (phase === "loading") {
    return <FullScreen bg="bg-gray-900"><div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin" /></FullScreen>;
  }

  if (phase === "error") {
    return <FullScreen bg="bg-gray-900"><p className="text-red-400 text-2xl font-bold">{error}</p></FullScreen>;
  }

  if (phase === "waiting") {
    return (
      <FullScreen bg="bg-gray-900">
        <p className="text-white/60 text-3xl">Warte auf den Start...</p>
      </FullScreen>
    );
  }

  if (phase === "scoreboard") {
    return (
      <FullScreen bg="bg-gray-900">
        <h2 className="text-white text-4xl font-bold mb-8">🏆 Ergebnisse</h2>
        <div className="w-full max-w-lg space-y-3">
          {topScores.map((s) => (
            <div
              key={s.rank}
              className={`flex items-center gap-4 px-6 py-4 rounded-2xl ${
                s.rank === 1 ? "bg-yellow-400 text-gray-900" :
                s.rank === 2 ? "bg-gray-300 text-gray-900" :
                s.rank === 3 ? "bg-amber-600 text-white" :
                "bg-white/10 text-white"
              }`}
            >
              <span className="text-2xl font-bold w-10 text-center">{s.rank}.</span>
              <span className="flex-1 text-2xl font-semibold">{s.displayName}</span>
              <span className="text-2xl font-bold">{s.score}</span>
            </div>
          ))}
        </div>
      </FullScreen>
    );
  }

  if (!question) return <FullScreen bg="bg-gray-900" />;

  const isRevealed = phase === "revealed";
  const pct = responseCount ? Math.round((responseCount.answered / Math.max(responseCount.total, 1)) * 100) : 0;

  return (
    <div className="flex flex-col min-h-screen bg-gray-900 text-white p-8 gap-6">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-white/50 text-xl">Frage {question.index + 1} / {question.total}</span>
        {timeLeft !== null && (
          <span className={`text-5xl font-bold tabular-nums ${timeLeft <= 5 ? "text-red-400" : "text-white"}`}>
            {timeLeft}
          </span>
        )}
        {responseCount && (
          <span className="text-white/50 text-xl">{responseCount.answered} / {responseCount.total}</span>
        )}
      </div>

      {/* Response progress bar */}
      {responseCount && (
        <div className="w-full bg-white/10 rounded-full h-2">
          <div
            className="bg-indigo-400 h-2 rounded-full transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {/* Question text */}
      <div className="flex-1 flex items-center justify-center">
        <p className="text-4xl font-bold text-center leading-tight max-w-4xl">{question.text}</p>
      </div>

      {/* Answer grid */}
      <div className={`grid gap-4 ${question.answers.length === 2 ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4"}`}>
        {question.answers.map((a, i) => {
          const color = ANSWER_COLORS[i % ANSWER_COLORS.length];
          const isCorrect = correctIds.includes(a.id);
          const dimmed = isRevealed && !isCorrect;
          return (
            <div
              key={a.id}
              className={`relative flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-4 transition-all duration-500
                ${color.bg} ${color.border} ${color.text}
                ${dimmed ? "opacity-30 scale-95" : ""}
                ${isCorrect && isRevealed ? "ring-4 ring-white scale-105" : ""}
              `}
            >
              <span className="text-5xl">{color.shape}</span>
              <span className="text-2xl font-bold text-center leading-tight">{a.text}</span>
              {isCorrect && isRevealed && (
                <span className="absolute top-2 right-2 text-2xl">✓</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Explanation — shown after reveal */}
      {isRevealed && question.explanation && (
        <div className="w-full bg-white/10 rounded-2xl px-6 py-4 border border-white/20">
          <p className="text-white/50 text-sm font-semibold uppercase tracking-wider mb-2">Erklärung</p>
          <p className="text-white text-xl leading-snug">{question.explanation}</p>
        </div>
      )}
    </div>
  );
}

function FullScreen({ children, bg }: { children?: React.ReactNode; bg: string }) {
  return (
    <div className={`flex items-center justify-center min-h-screen ${bg}`}>
      {children}
    </div>
  );
}
