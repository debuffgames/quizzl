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
  timeLimitSecs: number | null; remainingSecs?: number | null; index: number; total: number;
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
interface BossResult {
  winner: "class" | "boss";
  bossTimeRemainingMs?: number;
  bossTotalMs?: number;
  bossHpRemaining?: number;
  bossMaxHp?: number;
}
interface ShieldResult {
  winner: string;
  shieldFinal: { name: string; hp: number; maxHp: number }[];
}

type Phase = "loading" | "error" | "waiting" | "question" | "revealed" | "scoreboard";

export default function BeamerPage() {
  return <Suspense><BeamerContent /></Suspense>;
}

function BeamerContent() {
  const { sessionId: lobbyId } = useParams<{ sessionId: string }>();
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
  const [hiddenReveal, setHiddenReveal] = useState<{ id: string; text: string } | null>(null);
  const [bossResult, setBossResult] = useState<BossResult | null>(null);
  const [shieldResult, setShieldResult] = useState<ShieldResult | null>(null);
  const [shieldAnimTrigger, setShieldAnimTrigger] = useState<{ preHp: [number, number]; postHp: [number, number]; key: number } | null>(null);
  const [bossAnimTrigger, setBossAnimTrigger] = useState<{ type: "attack" | "steal"; value: number; key: number } | null>(null);

  const [reconnecting, setReconnecting] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const hasJoinedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevShieldHpRef = useRef<[number, number] | null>(null);
  const prevBossHpRef = useRef<number | null>(null);
  const prevBossTimerEndRef = useRef<number | null>(null);
  const shieldStateRef = useRef<ShieldState | null>(null);
  useEffect(() => { shieldStateRef.current = shieldState; }, [shieldState]);

  useEffect(() => {
    if (!bossAnimTrigger) return;
    const id = setTimeout(() => setBossAnimTrigger(null), 1200);
    return () => clearTimeout(id);
  }, [bossAnimTrigger?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refs so the keyboard handler always reads current state without stale closures
  const phaseRef = useRef(phase);
  const speedModeRef = useRef(speedMode);
  const answersVisibleRef = useRef(answersVisible);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { speedModeRef.current = speedMode; }, [speedMode]);
  useEffect(() => { answersVisibleRef.current = answersVisible; }, [answersVisible]);

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

  const resetForNewSession = (bm?: string, sm?: string) => {
    clearTimer();
    setQuestion(null);
    setCorrectIds([]);
    setResponseCount(null);
    setTimeLeft(null);
    setAnswersVisible(false);
    setBossState(null);
    setShieldState(null);
    setHiddenReveal(null);
    setBossResult(null);
    setShieldResult(null);
    setBossAnimTrigger(null);
    prevBossHpRef.current = null;
    prevBossTimerEndRef.current = null;
    if (bm) setBeamerMode(bm);
    if (sm) setSpeedMode(sm);
    setPhase("waiting");
  };

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
        setReconnecting(false);
        socket.emit(QUIZ_EVENTS.BEAMER_JOIN, { lobbyId, token }, (ack: { ok: boolean; beamerMode?: string; speedMode?: string; error?: string }) => {
          if (!ack.ok) {
            if (!hasJoinedRef.current) { setError(ack.error ?? "Verbindung fehlgeschlagen"); setPhase("error"); }
            return;
          }
          const isReconnect = hasJoinedRef.current;
          hasJoinedRef.current = true;
          if (!isReconnect) {
            if (ack.beamerMode) setBeamerMode(ack.beamerMode);
            if (ack.speedMode) setSpeedMode(ack.speedMode);
            setPhase("waiting");
          }
          // On reconnect the server sends QUESTION via sendCurrentQuestion → phase restores automatically
        });
      });

      socket.on("disconnect", () => setReconnecting(true));

      socket.on(QUIZ_EVENTS.QUESTION, (data: QuestionData) => {
        clearTimer();
        setQuestion(data);
        setCorrectIds([]);
        setResponseCount(null);
        setAnswersVisible(data.answersVisibleAt !== null && data.answersVisibleAt !== undefined);
        setHiddenReveal(null);
        prevShieldHpRef.current = null;
        setShieldAnimTrigger(null);
        if (data.speedMode) setSpeedMode(data.speedMode);
        setPhase("question");
        if (data.timeLimitSecs) startTimer(data.remainingSecs ?? data.timeLimitSecs);
      });

      socket.on(QUIZ_EVENTS.ANSWERS_VISIBLE, () => setAnswersVisible(true));
      socket.on(QUIZ_EVENTS.SESSION_STARTED, (data: { beamerMode?: string; speedMode?: string }) => {
        resetForNewSession(data.beamerMode, data.speedMode);
      });
      socket.on(QUIZ_EVENTS.BOSS_STATE, (data: BossState) => {
        const prevHp = prevBossHpRef.current;
        const prevTimerEnd = prevBossTimerEndRef.current;
        prevBossHpRef.current = data.hp;
        prevBossTimerEndRef.current = data.timerEnd;
        if (prevHp !== null && data.hp < prevHp) {
          setBossAnimTrigger({ type: "attack", value: prevHp - data.hp, key: Date.now() });
        } else if (prevTimerEnd !== null && data.timerEnd < prevTimerEnd - 5000) {
          setBossAnimTrigger({ type: "steal", value: Math.round((prevTimerEnd - data.timerEnd) / 1000), key: Date.now() });
        }
        setBossState(data);
        setBeamerMode("BOSS");
      });
      socket.on(QUIZ_EVENTS.SHIELD_STATE, (data: ShieldState) => {
        if (prevShieldHpRef.current) {
          const preHp = prevShieldHpRef.current;
          prevShieldHpRef.current = null;
          setShieldAnimTrigger({ preHp, postHp: [data.teams[0].hp, data.teams[1].hp], key: Date.now() });
        }
        setShieldState(data);
        setBeamerMode("TEAM_SHIELD");
      });

      socket.on(QUIZ_EVENTS.TIMER_SYNC, ({ remainingSecs }: { remainingSecs: number }) => setTimeLeft(remainingSecs));
      socket.on(QUIZ_EVENTS.RESPONSE_COUNT, (data: { answered: number; total: number }) => setResponseCount(data));

      socket.on(QUIZ_EVENTS.ANSWER_REVEAL, ({ correctAnswerIds, hiddenReveal: hr }: { correctAnswerIds: string[]; hiddenReveal?: { id: string; text: string } }) => {
        clearTimer();
        setCorrectIds(correctAnswerIds);
        if (hr) setHiddenReveal(hr);
        // Save shield HP before SHIELD_STATE arrives with updated values
        if (shieldStateRef.current) {
          prevShieldHpRef.current = [shieldStateRef.current.teams[0].hp, shieldStateRef.current.teams[1].hp];
        }
        setPhase("revealed");
      });

      socket.on(QUIZ_EVENTS.SCOREBOARD, ({ topN }: { topN: TopScore[] }) => {
        setTopScores(topN);
      });

      socket.on(QUIZ_EVENTS.END, (data: { topScores: TopScore[]; winType?: string; winner?: string; bossTimeRemainingMs?: number; bossTotalMs?: number; bossHpRemaining?: number; bossMaxHp?: number; shieldFinal?: { name: string; hp: number; maxHp: number }[] }) => {
        clearTimer();
        if (data.topScores) setTopScores(data.topScores);
        if (data.winType === "boss") {
          setBossResult({
            winner: data.winner as "class" | "boss",
            bossTimeRemainingMs: data.bossTimeRemainingMs,
            bossTotalMs: data.bossTotalMs,
            bossHpRemaining: data.bossHpRemaining,
            bossMaxHp: data.bossMaxHp,
          });
        }
        if (data.winType === "shield" && data.winner && data.shieldFinal) {
          setShieldResult({ winner: data.winner, shieldFinal: data.shieldFinal });
        }
        setPhase("scoreboard");
      });
    });

    return () => {
      clearTimer();
      socketRef.current?.disconnect();
    };
  }, [lobbyId, token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key !== " " && e.key !== "Enter" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const socket = socketRef.current;
      if (!socket) return;
      const p = phaseRef.current;
      const sm = speedModeRef.current;
      const av = answersVisibleRef.current;
      if (p === "question") {
        if (sm === "BLITZ" && !av) {
          socket.emit(QUIZ_EVENTS.SHOW_ANSWERS);
        } else {
          socket.emit(QUIZ_EVENTS.REVEAL_ANSWER);
        }
      } else if (p === "revealed") {
        socket.emit(QUIZ_EVENTS.NEXT_QUESTION);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Render ───────────────────────────────────────────────────────────────

  if (reconnecting) {
    return (
      <FullScreen bg="bg-gray-900">
        <div className="w-12 h-12 border-4 border-white/30 border-t-white rounded-full animate-spin mb-4" />
        <p className="text-white/60 text-xl">Verbindung unterbrochen – wird neu verbunden…</p>
      </FullScreen>
    );
  }

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
    if (bossResult) {
      const classWon = bossResult.winner === "class";
      const timeUsedMs = (bossResult.bossTotalMs ?? 0) - (bossResult.bossTimeRemainingMs ?? 0);
      return (
        <div className={`flex flex-col min-h-screen ${classWon ? "bg-gray-900" : "bg-gray-950"} text-white p-8 gap-8`}>
          {/* Hero */}
          <div className="flex flex-col items-center gap-4 pt-4">
            <p className="text-8xl">{classWon ? "⚔️" : "💀"}</p>
            <h1 className={`text-6xl font-black text-center leading-tight ${classWon ? "text-yellow-400" : "text-red-500"}`}>
              {classWon ? "BOSS BESIEGT!" : "DER BOSS\nTRIUMPHIERT"}
            </h1>
            <p className="text-xl text-white/60 text-center mt-1">
              {classWon
                ? "Die Klasse hat zusammengekämpft und gewonnen!"
                : "Der Boss war diesmal zu mächtig... Beim nächsten Mal!"}
            </p>
            {/* Stats */}
            {classWon && bossResult.bossTotalMs != null && (
              <div className="bg-yellow-400/10 border border-yellow-400/30 rounded-2xl px-8 py-4 text-center mt-2">
                <p className="text-yellow-300/70 text-sm font-semibold uppercase tracking-wider mb-1">Gebrauchte Zeit</p>
                <p className="text-yellow-300 text-3xl font-black tabular-nums">
                  {formatTimer(timeUsedMs)}
                  <span className="text-lg text-yellow-300/50 font-normal"> / {formatTimer(bossResult.bossTotalMs)}</span>
                </p>
                {bossResult.bossTimeRemainingMs != null && (
                  <p className="text-yellow-300/60 text-sm mt-1">{formatTimer(bossResult.bossTimeRemainingMs)} Restzeit übrig</p>
                )}
              </div>
            )}
            {!classWon && bossResult.bossMaxHp != null && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-2xl px-8 py-4 text-center mt-2 w-full max-w-sm">
                <p className="text-red-300/70 text-sm font-semibold uppercase tracking-wider mb-2">Boss-HP beim Sieg</p>
                <div className="w-full bg-gray-700 rounded-full h-4 mb-2">
                  <div className="bg-red-500 h-4 rounded-full" style={{ width: `${Math.round(((bossResult.bossHpRemaining ?? 0) / Math.max(bossResult.bossMaxHp, 1)) * 100)}%` }} />
                </div>
                <p className="text-red-300 text-2xl font-black">{bossResult.bossHpRemaining} <span className="text-red-300/50 font-normal text-lg">/ {bossResult.bossMaxHp} HP</span></p>
              </div>
            )}
          </div>
          {/* Scoreboard */}
          <div className="flex flex-col items-center gap-3 w-full max-w-lg mx-auto">
            <p className="text-white/40 text-sm font-semibold uppercase tracking-wider">Bestenliste</p>
            {topScores.map((s) => (
              <div key={s.rank} className={`flex items-center gap-4 px-6 py-3 rounded-2xl w-full ${s.rank === 1 ? "bg-yellow-400 text-gray-900" : s.rank === 2 ? "bg-gray-300 text-gray-900" : s.rank === 3 ? "bg-amber-600 text-white" : "bg-white/10 text-white"}`}>
                <span className="text-xl font-bold w-8 text-center">{s.rank}.</span>
                <span className="flex-1 text-xl font-semibold">{s.displayName}</span>
                <span className="text-xl font-bold">{s.score}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    if (shieldResult) {
      const winnerColor = shieldResult.winner === "Team Grün" ? "#22c55e" : "#f97316";
      return (
        <div className="flex flex-col min-h-screen bg-gray-900 text-white p-8 gap-8">
          {/* Hero */}
          <div className="flex flex-col items-center gap-4 pt-4">
            <p className="text-8xl">🛡️</p>
            <h1 className="text-6xl font-black text-center" style={{ color: winnerColor }}>
              {shieldResult.winner.toUpperCase()}
            </h1>
            <p className="text-2xl font-bold text-white/70">hat gewonnen!</p>
            {/* Shield bars */}
            <div className="w-full max-w-md mt-4 space-y-4">
              {shieldResult.shieldFinal.map((t) => {
                const color = t.name === "Team Grün" ? "#22c55e" : "#f97316";
                const isWinner = t.name === shieldResult.winner;
                return (
                  <div key={t.name} className={`rounded-2xl px-5 py-4 ${isWinner ? "bg-white/10" : "bg-white/5"}`} style={isWinner ? { outline: `2px solid ${color}` } : undefined}>
                    <div className="flex items-center justify-between mb-2" style={{ color }}>
                      <span className="font-bold text-lg">{t.name} {isWinner ? "🏆" : ""}</span>
                      <span className="font-black text-xl tabular-nums">{t.hp} <span className="text-sm font-normal opacity-60">/ {t.maxHp}</span></span>
                    </div>
                    <div className="w-full bg-gray-700 rounded-full h-3">
                      <div className="h-3 rounded-full transition-all" style={{ width: `${Math.max(0, Math.round((t.hp / Math.max(t.maxHp, 1)) * 100))}%`, backgroundColor: color }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {/* Scoreboard */}
          <div className="flex flex-col items-center gap-3 w-full max-w-lg mx-auto">
            <p className="text-white/40 text-sm font-semibold uppercase tracking-wider">Bestenliste</p>
            {topScores.map((s) => (
              <div key={s.rank} className={`flex items-center gap-4 px-6 py-3 rounded-2xl w-full ${s.rank === 1 ? "bg-yellow-400 text-gray-900" : s.rank === 2 ? "bg-gray-300 text-gray-900" : s.rank === 3 ? "bg-amber-600 text-white" : "bg-white/10 text-white"}`}>
                <span className="text-xl font-bold w-8 text-center">{s.rank}.</span>
                <span className="flex-1 text-xl font-semibold">{s.displayName}</span>
                <span className="text-xl font-bold">{s.score}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

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
      {/* Flickering beamer effect — each button has its own independent pattern */}
      {beamerMode === "BOSS" && (
        <style>{`
          @keyframes fly-btt {
            0%   { transform: translate(-50%, 40vh) scale(0.5); opacity: 0; }
            12%  { transform: translate(-50%, 28vh) scale(1);   opacity: 1; }
            88%  { transform: translate(-50%, -28vh) scale(1);  opacity: 1; }
            100% { transform: translate(-50%, -40vh) scale(0.5); opacity: 0; }
          }
          @keyframes fly-ttb {
            0%   { transform: translate(-50%, -40vh) scale(0.5); opacity: 0; }
            12%  { transform: translate(-50%, -28vh) scale(1);   opacity: 1; }
            88%  { transform: translate(-50%, 28vh) scale(1);    opacity: 1; }
            100% { transform: translate(-50%, 40vh) scale(0.5);  opacity: 0; }
          }
        `}</style>
      )}
      {ability === "FLICKERING_BEAMER" && !isRevealed && (
        <style>{`
          @keyframes flicker0 {
            0%{opacity:1} 5%{opacity:.3} 8%{opacity:1} 13%{opacity:.5} 16%{opacity:1}
            35%{opacity:1} 37%{opacity:0} 70%{opacity:0} 73%{opacity:.7} 76%{opacity:0} 80%{opacity:1}
            100%{opacity:1}
          }
          @keyframes flicker1 {
            0%{opacity:1} 18%{opacity:1} 20%{opacity:0} 56%{opacity:0} 59%{opacity:.6} 62%{opacity:.1}
            65%{opacity:1} 75%{opacity:1} 77%{opacity:0} 85%{opacity:0} 88%{opacity:1}
            100%{opacity:1}
          }
          @keyframes flicker2 {
            0%{opacity:1} 5%{opacity:0} 30%{opacity:0} 33%{opacity:.8} 37%{opacity:1}
            60%{opacity:1} 62%{opacity:0} 90%{opacity:0} 93%{opacity:.4} 96%{opacity:0}
            100%{opacity:1}
          }
          @keyframes flicker3 {
            0%{opacity:.7} 3%{opacity:.1} 7%{opacity:1} 11%{opacity:.4} 15%{opacity:1}
            25%{opacity:1} 27%{opacity:0} 58%{opacity:0} 61%{opacity:1}
            80%{opacity:1} 82%{opacity:0} 91%{opacity:0} 93%{opacity:1}
            100%{opacity:1}
          }
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
          <img src="/ch/troodos.png" alt="Troodos" className="h-24 w-auto object-contain select-none shrink-0 pointer-events-none" draggable={false} />
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
            {ability && ability !== "NONE" ? (
              <div className="mt-2 inline-flex items-center gap-1.5 bg-yellow-500/20 border border-yellow-500/40 rounded-lg px-2.5 py-1">
                <span className="text-yellow-400 text-sm">⚡</span>
                <span className="text-xs text-yellow-300 font-bold">{abilityLabel(ability)}</span>
              </div>
            ) : (
              <div className="mt-2 h-[26px]" />
            )}
          </div>
          <div className="text-center min-w-[80px]">
            <p className="text-xs text-white/50 mb-0.5">Zeit</p>
            <p className={`text-2xl font-black tabular-nums ${(bossState.timerEnd - nowTick) < 60000 ? "text-red-400 animate-pulse" : "text-white"}`}>
              {formatTimer(Math.max(0, bossState.timerEnd - nowTick))}
            </p>
          </div>
        </div>
      )}

      {/* Team shield — large dominant display with attack animation */}
      {beamerMode === "TEAM_SHIELD" && shieldState && (
        <ShieldBattle teams={shieldState.teams} animTrigger={shieldAnimTrigger} />
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
      <div className="flex-1 flex flex-col items-center justify-center gap-2">
        <p className="text-4xl font-bold text-center leading-tight max-w-4xl">{question.text}</p>
        <p className="text-lg text-white/40 font-medium">{questionTypeHint(question.answerType)}</p>
      </div>

      {/* BLITZ lock overlay — shown while answers are hidden */}
      {speedMode === "BLITZ" && !isRevealed && !answersVisible && (
        <div className="text-center py-4">
          <p className="text-white/50 text-2xl font-semibold">🔒 Antworten noch verborgen</p>
        </div>
      )}

      {/* Dino group — BOSS mode */}
      {beamerMode === "BOSS" && (
        <div className="flex items-end justify-center gap-3">
          <img src="/ch/trizea.png" alt="Trizea" className="h-14 w-auto object-contain select-none pointer-events-none" draggable={false} />
          <img src="/ch/parus.png" alt="Parus" className="h-20 w-auto object-contain select-none pointer-events-none" draggable={false} />
          <img src="/ch/edo_solo.png" alt="Edo" className="h-14 w-auto object-contain select-none pointer-events-none" draggable={false} />
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
                  ${ability === "MOVING_BUTTONS" && !isRevealed ? "wobble-ability" : ""}
                `}
                style={
                  ability === "FLICKERING_BEAMER" && !isRevealed
                    ? { animation: `flicker${i % 4} ${[3.5, 5.0, 4.2, 6.0][i % 4]}s ${[0, 1.2, 2.5, 0.7][i % 4]}s infinite` }
                    : ability === "MOVING_BUTTONS" && !isRevealed
                    ? { animationDelay: `${i * 0.15}s` }
                    : undefined
                }
              >
                <span className={`text-5xl ${wrong ? "grayscale opacity-40" : ""}`}>{color.shape}</span>
                {isHidden && !isRevealed ? (
                  <span className="text-3xl font-bold">?</span>
                ) : (
                  <span
                    className="text-2xl font-bold text-center leading-tight"
                    style={isMirror ? { transform: "scaleX(-1)", display: "inline-block" } : undefined}
                  >
                    {isHidden && isRevealed ? hiddenReveal?.text ?? a.text : a.text}
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

      {/* Boss battle projectile */}
      {bossAnimTrigger && (
        <div
          className="absolute top-1/2 left-1/2 flex items-center gap-3 bg-gray-950/90 rounded-full px-6 py-3 shadow-2xl pointer-events-none z-20 whitespace-nowrap"
          style={{ animation: `${bossAnimTrigger.type === "attack" ? "fly-btt" : "fly-ttb"} 900ms ease-in-out forwards` }}
        >
          <span className="text-4xl">{bossAnimTrigger.type === "attack" ? "⚔️" : "⏳"}</span>
          <span className={`font-black text-5xl ${bossAnimTrigger.type === "attack" ? "text-yellow-400" : "text-red-400"}`}>
            {bossAnimTrigger.type === "attack" ? `-${bossAnimTrigger.value} HP` : `-${bossAnimTrigger.value}s`}
          </span>
        </div>
      )}

      {/* Keyboard shortcut hint */}
      <div className="absolute bottom-4 right-5 flex items-center gap-1.5 opacity-20 hover:opacity-60 transition-opacity pointer-events-none select-none">
        <kbd className="bg-white/20 border border-white/30 rounded px-2 py-0.5 text-xs font-mono text-white">Leertaste</kbd>
        <span className="text-white/70 text-xs">
          {isRevealed ? "→ Nächste Frage" : speedMode === "BLITZ" && !answersVisible ? "→ Antworten zeigen" : "→ Auflösen"}
        </span>
      </div>
    </div>
  );
}

function formatTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function questionTypeHint(answerType: string): string {
  switch (answerType) {
    case "MULTIPLE_CHOICE": return "Mehrere richtige Antworten – Auswahl bestätigen!";
    case "YES_NO": return "Ja oder Nein?";
    default: return "Eine richtige Antwort";
  }
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

const SHIELD_COLORS = ["#22c55e", "#f97316"] as const;

function ShieldBattle({
  teams,
  animTrigger,
}: {
  teams: ShieldTeam[];
  animTrigger: { preHp: [number, number]; postHp: [number, number]; key: number } | null;
}) {
  const [overrideHp, setOverrideHp] = useState<[number, number] | null>(null);
  const [proj, setProj] = useState<{ dir: 0 | 1; damage: number } | null>(null);
  const [hitTeam, setHitTeam] = useState<0 | 1 | null>(null);

  const displayHp: [number, number] = overrideHp ?? [teams[0]?.hp ?? 0, teams[1]?.hp ?? 0];

  useEffect(() => {
    if (!animTrigger) return;
    const { preHp, postHp } = animTrigger;
    const dmgTo1 = Math.max(0, preHp[1] - postHp[1]); // team0's correct answers → team1 takes this
    const dmgTo0 = Math.max(0, preHp[0] - postHp[0]); // team1's correct answers → team0 takes this

    setOverrideHp([...preHp]);
    setProj(null);
    setHitTeam(null);

    const ids: ReturnType<typeof setTimeout>[] = [];
    let t = 350;

    if (dmgTo1 > 0) {
      ids.push(setTimeout(() => setProj({ dir: 0, damage: dmgTo1 }), t));
      t += 800;
      ids.push(setTimeout(() => { setProj(null); setHitTeam(1); setOverrideHp([preHp[0], postHp[1]]); }, t));
      t += 550;
      ids.push(setTimeout(() => setHitTeam(null), t));
      t += 350;
    }

    if (dmgTo0 > 0) {
      ids.push(setTimeout(() => setProj({ dir: 1, damage: dmgTo0 }), t));
      t += 800;
      ids.push(setTimeout(() => { setProj(null); setHitTeam(0); setOverrideHp([postHp[0], postHp[1]]); }, t));
      t += 550;
      ids.push(setTimeout(() => { setHitTeam(null); setOverrideHp(null); }, t));
    } else {
      ids.push(setTimeout(() => setOverrideHp(null), t));
    }

    return () => ids.forEach(clearTimeout);
  }, [animTrigger?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative flex rounded-2xl overflow-hidden" style={{ minHeight: 180, background: "rgba(0,0,0,0.35)" }}>
      <style>{`
        @keyframes fly-ltr {
          0%   { transform: translate(-180px, -50%) scale(0.5); opacity: 0; }
          12%  { transform: translate(-110px, -50%) scale(1);   opacity: 1; }
          88%  { transform: translate( 110px, -50%) scale(1);   opacity: 1; }
          100% { transform: translate( 180px, -50%) scale(0.5); opacity: 0; }
        }
        @keyframes fly-rtl {
          0%   { transform: translate( 180px, -50%) scale(0.5); opacity: 0; }
          12%  { transform: translate( 110px, -50%) scale(1);   opacity: 1; }
          88%  { transform: translate(-110px, -50%) scale(1);   opacity: 1; }
          100% { transform: translate(-180px, -50%) scale(0.5); opacity: 0; }
        }
        @keyframes shield-bash {
          0%,100% { transform: translateX(0); }
          20%     { transform: translateX(10px); }
          40%     { transform: translateX(-8px); }
          60%     { transform: translateX(5px); }
          80%     { transform: translateX(-3px); }
        }
      `}</style>

      {[0, 1].map((i) => {
        const t = teams[i];
        const color = SHIELD_COLORS[i];
        const hp = displayHp[i];
        const pct = Math.max(0, Math.round((hp / Math.max(t?.maxHp ?? 1, 1)) * 100));
        const isHit = hitTeam === i;
        return (
          <div
            key={i}
            className="flex-1 flex flex-col items-center justify-center py-5 px-6 transition-[background,box-shadow] duration-200"
            style={{
              background: isHit ? `${color}35` : `${color}14`,
              boxShadow: isHit ? `inset 0 0 50px ${color}50` : "none",
              animation: isHit ? "shield-bash 0.45s ease-out" : "none",
            }}
          >
            <img
              src={i === 0 ? "/ch/edo_solo.png" : "/ch/parus.png"}
              alt={i === 0 ? "Edo" : "Parus"}
              className="h-20 w-auto object-contain select-none mb-1 pointer-events-none"
              draggable={false}
            />
            <p className="font-black text-base uppercase tracking-widest mb-1" style={{ color }}>{t?.name}</p>
            <p
              className="font-black tabular-nums leading-none"
              style={{ color, fontSize: "5rem", textShadow: `0 0 40px ${color}90` }}
            >
              {hp}
            </p>
            <p className="text-white/25 text-xs mt-0.5">/ {t?.maxHp} HP</p>
            <div className="w-full bg-gray-700/50 rounded-full mt-3" style={{ height: 10 }}>
              <div
                className="rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, height: 10, backgroundColor: color, boxShadow: `0 0 8px ${color}` }}
              />
            </div>
          </div>
        );
      })}

      {/* Center line */}
      <div className="absolute inset-y-0 left-1/2 w-px bg-white/10 -translate-x-1/2 pointer-events-none" />

      {/* Projectile */}
      {proj ? (
        <div
          className="absolute top-1/2 left-1/2 flex items-center gap-3 bg-gray-950/90 rounded-full px-6 py-3 shadow-2xl pointer-events-none z-10 whitespace-nowrap"
          style={{ animation: `${proj.dir === 0 ? "fly-ltr" : "fly-rtl"} 800ms ease-in-out forwards` }}
        >
          <span className="text-4xl">⚔️</span>
          <span className="font-black text-white text-5xl">-{proj.damage}</span>
        </div>
      ) : (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white/15 font-black text-3xl pointer-events-none select-none">VS</div>
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
