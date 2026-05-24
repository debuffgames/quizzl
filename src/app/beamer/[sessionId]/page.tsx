"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { QUIZ_EVENTS } from "@/lib/socket/events";
import { ANSWER_COLORS } from "@/lib/quiz/colors";

interface AnswerData { id: string; text: string | null; sortOrder: number; }
interface QuestionData {
  id: string; text: string; answerType: string;
  answers: AnswerData[];
  timeLimitSecs: number | null; index: number; total: number;
  explanation?: string | null;
  speedMode?: string;
  answersVisibleAt?: number | null;
  bossAbility?: string | null;
  hiddenAnswerId?: string | null;
}
interface TopScore { rank: number; displayName: string; score: number; }
interface BossState { hp: number; maxHp: number; timerEnd: number; ability: string | null; wrongCount: number; threshold: number; }
interface ShieldTeam { name: string; hp: number; maxHp: number; }
interface ShieldState { teams: ShieldTeam[]; }

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
  const [beamerMode, setBeamerMode] = useState("STANDARD");
  const [speedMode, setSpeedMode] = useState("NORMAL");
  const [answersVisible, setAnswersVisible] = useState(false);
  const [bossState, setBossState] = useState<BossState | null>(null);
  const [shieldState, setShieldState] = useState<ShieldState | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

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

  // Boss timer tick
  useEffect(() => {
    if (beamerMode !== "BOSS" || !bossState) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [beamerMode, bossState]);

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
        socket.emit(QUIZ_EVENTS.BEAMER_JOIN, { sessionId, token }, (ack: { ok: boolean; beamerMode?: string; speedMode?: string; error?: string }) => {
          if (!ack.ok) { setError(ack.error ?? "Verbindung fehlgeschlagen"); setPhase("error"); return; }
          if (ack.beamerMode) setBeamerMode(ack.beamerMode);
          if (ack.speedMode) setSpeedMode(ack.speedMode);
          setPhase("waiting");
        });
      });

      socket.on("connect_error", () => { setError("Verbindung fehlgeschlagen"); setPhase("error"); });

      socket.on(QUIZ_EVENTS.QUESTION, (data: QuestionData) => {
        clearTimer();
        setQuestion(data);
        setCorrectIds([]);
        setResponseCount(null);
        setAnswersVisible(data.answersVisibleAt !== null && data.answersVisibleAt !== undefined);
        if (data.speedMode) setSpeedMode(data.speedMode);
        setPhase("question");
        if (data.timeLimitSecs) startTimer(data.timeLimitSecs);
      });

      socket.on(QUIZ_EVENTS.ANSWERS_VISIBLE, () => setAnswersVisible(true));
      socket.on(QUIZ_EVENTS.BOSS_STATE, (data: BossState) => { setBossState(data); setBeamerMode("BOSS"); });
      socket.on(QUIZ_EVENTS.SHIELD_STATE, (data: ShieldState) => { setShieldState(data); setBeamerMode("TEAM_SHIELD"); });

      socket.on(QUIZ_EVENTS.TIMER_SYNC, ({ remainingSecs }: { remainingSecs: number }) => setTimeLeft(remainingSecs));
      socket.on(QUIZ_EVENTS.RESPONSE_COUNT, (data: { answered: number; total: number }) => setResponseCount(data));

      socket.on(QUIZ_EVENTS.ANSWER_REVEAL, ({ correctAnswerIds }: { correctAnswerIds: string[] }) => {
        clearTimer();
        setCorrectIds(correctAnswerIds);
        setPhase("revealed");
      });

      socket.on(QUIZ_EVENTS.SCOREBOARD, ({ topN }: { topN: TopScore[] }) => {
        setTopScores(topN);
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
  const ability = question.bossAbility ?? null;
  const pct = responseCount ? Math.round((responseCount.answered / Math.max(responseCount.total, 1)) * 100) : 0;

  return (
    <div className="flex flex-col min-h-screen bg-gray-900 text-white gap-4 p-6 relative overflow-hidden">
      {/* Flickering beamer effect */}
      {ability === "FLICKERING_BEAMER" && !isRevealed && (
        <style>{`
          @keyframes flicker { 0%,100%{opacity:1} 10%{opacity:0.4} 20%{opacity:1} 50%{opacity:0.6} 60%{opacity:1} 80%{opacity:0.7} 90%{opacity:1} }
          .flicker-ability { animation: flicker 1.8s infinite; }
        `}</style>
      )}
      {ability === "MOVING_BUTTONS" && !isRevealed && (
        <style>{`
          @keyframes wobble { 0%,100%{transform:rotate(0deg) scale(1)} 20%{transform:rotate(-2deg) scale(1.03)} 40%{transform:rotate(2deg) scale(0.97)} 60%{transform:rotate(-1deg) scale(1.02)} 80%{transform:rotate(1deg) scale(0.98)} }
          .wobble-ability { animation: wobble 0.8s infinite; }
        `}</style>
      )}

      {/* Boss overlay */}
      {beamerMode === "BOSS" && bossState && (
        <div className="flex items-center gap-4 bg-black/40 rounded-2xl px-4 py-3">
          <div className="flex-1">
            <div className="flex items-center justify-between text-sm font-bold mb-1">
              <span className="text-red-400">👾 Boss</span>
              <span className="text-red-300">{bossState.hp} / {bossState.maxHp} HP</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-3">
              <div
                className="bg-red-500 h-3 rounded-full transition-all duration-500"
                style={{ width: `${Math.max(0, Math.round((bossState.hp / Math.max(bossState.maxHp, 1)) * 100))}%` }}
              />
            </div>
          </div>
          <div className="text-center min-w-[80px]">
            <p className="text-xs text-white/50 mb-0.5">Zeit</p>
            <p className={`text-2xl font-black tabular-nums ${(bossState.timerEnd - nowTick) < 60000 ? "text-red-400 animate-pulse" : "text-white"}`}>
              {formatTimer(Math.max(0, bossState.timerEnd - nowTick))}
            </p>
          </div>
          {ability && ability !== "NONE" && ability !== "DANCING_BUZZERS" && (
            <div className="bg-yellow-500/20 border border-yellow-500/40 rounded-xl px-3 py-1.5 text-center min-w-[100px]">
              <p className="text-[10px] text-yellow-300/70 uppercase font-semibold">Fähigkeit</p>
              <p className="text-xs text-yellow-300 font-bold">{abilityLabel(ability)}</p>
            </div>
          )}
        </div>
      )}

      {/* Team shield overlay */}
      {beamerMode === "TEAM_SHIELD" && shieldState && (
        <div className="grid grid-cols-2 gap-3">
          {shieldState.teams.map((t) => (
            <div key={t.name} className="rounded-xl bg-black/40 px-3 py-2">
              <div className="flex items-center justify-between text-sm font-bold mb-1" style={{ color: t.name === "Team Grün" ? "#22c55e" : "#8b5cf6" }}>
                <span>{t.name}</span>
                <span>{t.hp}/{t.maxHp}</span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2.5">
                <div className="h-2.5 rounded-full transition-all duration-500" style={{ width: `${Math.max(0, Math.round((t.hp / Math.max(t.maxHp, 1)) * 100))}%`, backgroundColor: t.name === "Team Grün" ? "#22c55e" : "#8b5cf6" }} />
              </div>
            </div>
          ))}
        </div>
      )}

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

      {/* BLITZ lock overlay — shown while answers are hidden */}
      {speedMode === "BLITZ" && !isRevealed && !answersVisible && (
        <div className="text-center py-4">
          <p className="text-white/50 text-2xl font-semibold">🔒 Antworten noch verborgen</p>
        </div>
      )}

      {/* Answer grid — hidden in BLITZ until answers visible */}
      {(speedMode !== "BLITZ" || answersVisible || isRevealed) && (
        <div className={`grid gap-4 ${question.answers.length === 2 ? "grid-cols-2" : "grid-cols-2 md:grid-cols-4"}`}>
          {question.answers.map((a, i) => {
            const color = ANSWER_COLORS[i % ANSWER_COLORS.length];
            const isCorrect = correctIds.includes(a.id);
            const wrong = isRevealed && !isCorrect;
            const isMirror = ability === "MIRROR_TEXT" && !isRevealed;
            const isHidden = a.text === null;
            return (
              <div
                key={a.id}
                className={`relative flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-4 transition-all duration-500
                  ${wrong
                    ? "bg-gray-700 border-gray-600 text-gray-500 scale-95"
                    : `${color.bg} ${color.border} ${color.text}`}
                  ${isCorrect && isRevealed ? "ring-4 ring-white scale-105" : ""}
                  ${ability === "FLICKERING_BEAMER" && !isRevealed ? "flicker-ability" : ""}
                  ${ability === "MOVING_BUTTONS" && !isRevealed ? "wobble-ability" : ""}
                `}
                style={{ animationDelay: ability === "MOVING_BUTTONS" ? `${i * 0.15}s` : undefined }}
              >
                <span className={`text-5xl ${wrong ? "grayscale opacity-40" : ""}`}>{color.shape}</span>
                {isHidden ? (
                  <span className="text-3xl font-bold">?</span>
                ) : (
                  <span
                    className="text-2xl font-bold text-center leading-tight"
                    style={isMirror ? { transform: "scaleX(-1)", display: "inline-block" } : undefined}
                  >
                    {a.text}
                  </span>
                )}
                {isCorrect && isRevealed && (
                  <span className="absolute top-2 right-2 text-2xl">✓</span>
                )}
              </div>
            );
          })}
        </div>
      )}

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

function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function abilityLabel(ability: string): string {
  switch (ability) {
    case "HIDDEN_ANSWER": return "Verborgen";
    case "HALF_TIME": return "Halbzeit";
    case "MIRROR_TEXT": return "Spiegel";
    case "MOVING_BUTTONS": return "Wackeln";
    case "FLICKERING_BEAMER": return "Flackern";
    case "DANCING_BUZZERS": return "Tanz";
    default: return ability;
  }
}

function FullScreen({ children, bg }: { children?: React.ReactNode; bg: string }) {
  return (
    <div className={`flex items-center justify-center min-h-screen ${bg}`}>
      {children}
    </div>
  );
}
