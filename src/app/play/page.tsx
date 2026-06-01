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
  fairZoneSecs?: number;
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
  timerFull?: number | null;
  fairZoneSecs?: number | null;
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
  | { status: "beamer"; socket: Socket; beamerMode: string; displayMode: "BEAMER" | "UNIBEAM" };

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
        socket.emit(QUIZ_EVENTS.JOIN, { lobbyId, token }, async (ack: { ok: boolean; gameMode?: string; beamerMode?: string; displayMode?: string; error?: string }) => {
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
            setReady({ status: "beamer", socket, beamerMode: ack.beamerMode ?? "STANDARD", displayMode: (ack.displayMode as "BEAMER" | "UNIBEAM") ?? "UNIBEAM" });
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

  return <BeamerPlay socket={init.socket} reconnecting={reconnecting} initialBeamerMode={init.beamerMode} initialDisplayMode={init.displayMode} />;
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
  const cardQ: CardQuestion = { text: q.text, answerType: q.answerType, index: qIndex, total: questions.length, timeLimitSecs: q.timeLimitSecs, timerFull: q.timeLimitSecs, fairZoneSecs: null };

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

function BeamerPlay({ socket, reconnecting, initialBeamerMode, initialDisplayMode }: { socket: Socket; reconnecting: boolean; initialBeamerMode: string; initialDisplayMode: "BEAMER" | "UNIBEAM" }) {
  type BeamerPhase = "waiting" | "question" | "answered" | "revealed" | "scoreboard" | "ended" | "paused";
  const [phase, setPhase] = useState<BeamerPhase>("waiting");
  const [question, setQuestion] = useState<BeamerQuestion | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [reveal, setReveal] = useState<RevealData | null>(null);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  const [finalScore, setFinalScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [barFullSecs, setBarFullSecs] = useState<number | null>(null);
  const [barFairZone, setBarFairZone] = useState<number | null>(null);
  const [answersUnlocked, setAnswersUnlocked] = useState(true);
  const [teamInfo, setTeamInfo] = useState<{ teamIndex: number; teamName: string } | null>(null);
  const [myTeamHp, setMyTeamHp] = useState<{ hp: number; maxHp: number } | null>(null);
  const [dancing, setDancing] = useState(false);
  const [bossMode, setBossMode] = useState(false);
  const [displayMode, setDisplayMode] = useState<"BEAMER" | "UNIBEAM">(initialDisplayMode);
  const teamInfoRef = useRef<{ teamIndex: number; teamName: string } | null>(null);
  useEffect(() => { teamInfoRef.current = teamInfo; }, [teamInfo]);
  const displayModeRef = useRef<"BEAMER" | "UNIBEAM">(initialDisplayMode);
  useEffect(() => { displayModeRef.current = displayMode; }, [displayMode]);

  // UNIBEAM boss + shield overlay state
  const [bossDisplayState, setBossDisplayState] = useState<{ hp: number; maxHp: number; timerEnd: number; timerFrozen?: boolean } | null>(null);
  const [bossHit, setBossHit] = useState(false);
  const [playerHit, setPlayerHit] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [bossChargeAnim, setBossChargeAnim] = useState<{ type: "attack" | "steal"; finalValue: number; progress: number; key: number } | null>(null);
  const [bossAnimTrigger, setBossAnimTrigger] = useState<{ type: "attack" | "steal"; value: number; key: number } | null>(null);
  const [bossStealChargeValue, setBossStealChargeValue] = useState<number | null>(null);
  const [fullShieldState, setFullShieldState] = useState<{ teams: { name: string; hp: number; maxHp: number }[] } | null>(null);
  const [shieldDisplayHp, setShieldDisplayHp] = useState<[number, number] | null>(null);
  const [shieldChargeVisible, setShieldChargeVisible] = useState<[boolean, boolean]>([false, false]);
  const [shieldChargeDmg, setShieldChargeDmg] = useState<[number, number]>([0, 0]);
  const [shieldChargeProgress, setShieldChargeProgress] = useState(0);
  const [shieldHitTeam, setShieldHitTeam] = useState<0 | 1 | null>(null);
  const [shieldAnimTrigger, setShieldAnimTrigger] = useState<{ preHp: [number, number]; postHp: [number, number]; key: number } | null>(null);
  const prevBossHpRef = useRef<number | null>(null);
  const prevBossTimerEndRef = useRef<number | null>(null);
  const prevShieldHpForRevealRef = useRef<[number, number] | null>(null);
  const fullShieldStateRef = useRef<{ teams: { name: string; hp: number; maxHp: number }[] } | null>(null);
  useEffect(() => { fullShieldStateRef.current = fullShieldState; }, [fullShieldState]);
  const pendingBossDisplayStateRef = useRef<{ hp: number; maxHp: number; timerEnd: number; timerFrozen?: boolean } | null>(null);
  const bossChargeRafRef = useRef<number | null>(null);
  const bossStealQueuedRef = useRef<number | null>(null);

  useEffect(() => {
    if (!bossDisplayState) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [!!bossDisplayState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Boss: charge orb grows (3 s) → projectile flies → impact bash
  useEffect(() => {
    if (!bossChargeAnim) return;
    if (bossChargeRafRef.current) cancelAnimationFrame(bossChargeRafRef.current);
    const CHARGE_MS = 3000;
    const startTime = Date.now();
    const { type, finalValue, key } = bossChargeAnim;
    const rafRef = { current: 0 };
    const tick = () => {
      const progress = Math.min(1, (Date.now() - startTime) / CHARGE_MS);
      setBossChargeAnim((prev) => prev?.key === key ? { ...prev, progress } : prev);
      if (progress < 1) { rafRef.current = requestAnimationFrame(tick); bossChargeRafRef.current = rafRef.current; }
      else { setBossChargeAnim(null); setBossAnimTrigger({ type, value: finalValue, key: key + 1 }); }
    };
    rafRef.current = requestAnimationFrame(tick);
    bossChargeRafRef.current = rafRef.current;
    return () => { cancelAnimationFrame(rafRef.current); };
  }, [bossChargeAnim?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!bossAnimTrigger) return;
    const hitId = setTimeout(() => { if (bossAnimTrigger.type === "attack") setBossHit(true); else setPlayerHit(true); }, 600);
    const endId = setTimeout(() => {
      setBossHit(false); setPlayerHit(false);
      if (bossAnimTrigger.type === "attack" && bossStealQueuedRef.current !== null) {
        const v = bossStealQueuedRef.current; bossStealQueuedRef.current = null;
        setBossStealChargeValue(null);
        setBossAnimTrigger({ type: "steal", value: v, key: Date.now() });
      } else {
        setBossAnimTrigger(null);
        if (pendingBossDisplayStateRef.current) { setBossDisplayState(pendingBossDisplayStateRef.current); pendingBossDisplayStateRef.current = null; }
      }
    }, 1100);
    return () => { clearTimeout(hitId); clearTimeout(endId); };
  }, [bossAnimTrigger?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shield: both charge orbs grow simultaneously, then flash-hit the damaged team bar
  useEffect(() => {
    if (!shieldAnimTrigger) return;
    const { preHp, postHp } = shieldAnimTrigger;
    const dmgTo1 = Math.max(0, preHp[1] - postHp[1]);
    const dmgTo0 = Math.max(0, preHp[0] - postHp[0]);
    setShieldDisplayHp([...preHp] as [number, number]);
    setShieldChargeVisible([dmgTo1 > 0, dmgTo0 > 0]);
    setShieldChargeDmg([dmgTo1, dmgTo0]);
    setShieldChargeProgress(0);
    setShieldHitTeam(null);
    const CHARGE_MS = 3000;
    const startTime = Date.now();
    const rafRef = { current: 0 };
    const ids: ReturnType<typeof setTimeout>[] = [];
    const tick = () => {
      const p = Math.min(1, (Date.now() - startTime) / CHARGE_MS);
      setShieldChargeProgress(p);
      if (p < 1) { rafRef.current = requestAnimationFrame(tick); return; }
      let t = 0;
      if (dmgTo1 > 0) {
        ids.push(setTimeout(() => { setShieldChargeVisible([false, dmgTo0 > 0]); setShieldHitTeam(1); setShieldDisplayHp([preHp[0], postHp[1]]); }, t));
        t += 550; ids.push(setTimeout(() => setShieldHitTeam(null), t)); t += 350;
      }
      if (dmgTo0 > 0) {
        ids.push(setTimeout(() => { setShieldChargeVisible([false, false]); setShieldHitTeam(0); setShieldDisplayHp([postHp[0], postHp[1]]); }, t));
        t += 550; ids.push(setTimeout(() => { setShieldHitTeam(null); setShieldDisplayHp(null); setShieldChargeProgress(0); }, t));
      } else {
        ids.push(setTimeout(() => { setShieldChargeVisible([false, false]); setShieldDisplayHp(null); setShieldChargeProgress(0); }, t));
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(rafRef.current); ids.forEach(clearTimeout); };
  }, [shieldAnimTrigger?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerEndRef = useRef<number | null>(null);
  const finalScoreRef = useRef(0);
  const prevPhaseRef = useRef<BeamerPhase>("waiting");
  const questionFairZoneRef = useRef<number | null>(null);
  const questionRef = useRef<BeamerQuestion | null>(null);
  useEffect(() => { questionRef.current = question; }, [question]);

  useEffect(() => { finalScoreRef.current = finalScore; }, [finalScore]);

  const [endResult, setEndResult] = useState<{
    winType?: string;
    winner?: string;
    bossTimeRemainingMs?: number;
    bossTotalMs?: number;
    bossHpRemaining?: number;
    bossMaxHp?: number;
    shieldFinal?: { name: string; hp: number; maxHp: number }[];
  } | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    timerEndRef.current = null;
  }, []);

  const startTimer = useCallback((secs: number) => {
    clearTimer();
    timerEndRef.current = Date.now() + secs * 1000;
    setTimeLeft(secs);
    timerRef.current = setInterval(() => {
      const end = timerEndRef.current;
      if (end === null) { clearTimer(); return; }
      const remaining = Math.max(0, Math.round((end - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining <= 0) clearTimer();
    }, 250);
  }, [clearTimer]);

  const applyQuestion = useCallback((data: BeamerQuestion) => {
    clearTimer();
    setQuestion(data);
    setReveal(null);
    const isBlitz = data.speedMode === "BLITZ";
    const visibleNow = data.answersVisibleAt != null;
    setAnswersUnlocked(!isBlitz || visibleNow);
    setDancing(data.bossAbility === "DANCING_BUZZERS");
    questionFairZoneRef.current = data.fairZoneSecs ?? null;
    if (data.timeLimitSecs) setBarFullSecs(data.timeLimitSecs);
    setBarFairZone(visibleNow ? (data.fairZoneSecs ?? null) : null);
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
    const onTimerSync = ({ remainingSecs }: { remainingSecs: number }) => {
      timerEndRef.current = Date.now() + remainingSecs * 1000;
      setTimeLeft(remainingSecs);
    };
    const onReveal = (data: RevealData) => {
      clearTimer();
      setReveal(data);
      setFinalScore(data.totalScore);
      setPhase("revealed");
      if (fullShieldStateRef.current) {
        prevShieldHpForRevealRef.current = [fullShieldStateRef.current.teams[0].hp, fullShieldStateRef.current.teams[1].hp];
      }
      setQuestion((q) => {
        if (q) window.parent.postMessage({ type: "PROGRESS", progress: (q.index + 1) / q.total, score: data.totalScore }, "*");
        return q;
      });
    };
    const onScoreboard = (data: { topN: TopScore[] }) => {
      setTopScores(data.topN);
      // In UNIBEAM mode students see the reveal screen; don't overwrite it with the
      // interim scoreboard — the QUESTION event will transition them to the next round.
      if (displayModeRef.current !== "UNIBEAM") setPhase("scoreboard");
    };
    const onEnd = (data: { topScores?: TopScore[]; winType?: string; winner?: string; bossTimeRemainingMs?: number; bossTotalMs?: number; bossHpRemaining?: number; bossMaxHp?: number; shieldFinal?: { name: string; hp: number; maxHp: number }[] }) => {
      clearTimer();
      if (data.topScores) setTopScores(data.topScores);
      setEndResult({ winType: data.winType, winner: data.winner, bossTimeRemainingMs: data.bossTimeRemainingMs, bossTotalMs: data.bossTotalMs, bossHpRemaining: data.bossHpRemaining, bossMaxHp: data.bossMaxHp, shieldFinal: data.shieldFinal });
      setPhase("ended");
      window.parent.postMessage({ type: "COMPLETE", score: finalScoreRef.current }, "*");
    };
    const onAnswersVisible = (data: { startsAt?: number; timeLimitSecs?: number | null }) => {
      setAnswersUnlocked(true);
      if (questionRef.current?.speedMode === "BLITZ" && data.timeLimitSecs) {
        startTimer(data.timeLimitSecs);
        setBarFullSecs(data.timeLimitSecs);
        setBarFairZone(questionFairZoneRef.current);
      }
    };
    const onTeamAssigned = (data: { teamIndex: number; teamName: string }) => setTeamInfo(data);
    const onShieldState = (data: { teams: { name: string; hp: number; maxHp: number }[] }) => {
      if (displayModeRef.current === "UNIBEAM") {
        const pre = prevShieldHpForRevealRef.current;
        if (pre) {
          prevShieldHpForRevealRef.current = null;
          const post: [number, number] = [data.teams[0].hp, data.teams[1].hp];
          if (pre[0] !== post[0] || pre[1] !== post[1]) {
            setShieldAnimTrigger({ preHp: pre, postHp: post, key: Date.now() });
          }
        }
        setFullShieldState(data);
      }
      const ti = teamInfoRef.current;
      if (ti !== null) {
        const myTeam = data.teams[ti.teamIndex];
        if (myTeam) setMyTeamHp({ hp: myTeam.hp, maxHp: myTeam.maxHp });
      }
    };
    const onBossState = (data: { hp: number; maxHp: number; timerEnd: number; timerFrozen?: boolean; ability?: string | null }) => {
      setBossMode(true);
      setDancing(data.ability === "DANCING_BUZZERS");
      if (displayModeRef.current === "UNIBEAM") {
        const prevHp = prevBossHpRef.current;
        const prevTimerEnd = prevBossTimerEndRef.current;
        prevBossHpRef.current = data.hp;
        prevBossTimerEndRef.current = data.timerEnd;
        const attackDmg = prevHp !== null && data.hp < prevHp ? prevHp - data.hp : 0;
        const stealSecs = prevTimerEnd !== null && data.timerEnd < prevTimerEnd - 5000 ? Math.round((prevTimerEnd - data.timerEnd) / 1000) : 0;
        if (attackDmg > 0 || stealSecs > 0) {
          pendingBossDisplayStateRef.current = { hp: data.hp, maxHp: data.maxHp, timerEnd: data.timerEnd, timerFrozen: data.timerFrozen };
          if (attackDmg > 0 && stealSecs > 0) {
            bossStealQueuedRef.current = stealSecs; setBossStealChargeValue(stealSecs);
            setBossChargeAnim({ type: "attack", finalValue: attackDmg, progress: 0, key: Date.now() });
          } else if (attackDmg > 0) {
            setBossChargeAnim({ type: "attack", finalValue: attackDmg, progress: 0, key: Date.now() });
          } else {
            setBossChargeAnim({ type: "steal", finalValue: stealSecs, progress: 0, key: Date.now() });
          }
        } else {
          setBossDisplayState({ hp: data.hp, maxHp: data.maxHp, timerEnd: data.timerEnd, timerFrozen: data.timerFrozen });
        }
      }
    };
    const onDisplayModeChanged = (data: { mode: "BEAMER" | "UNIBEAM"; question?: { text?: string; answers?: BeamerQuestion["answers"]; bossAbility?: string | null } }) => {
      setDisplayMode(data.mode);
      if (data.question) {
        setQuestion((q) => q ? { ...q, text: data.question!.text, answers: data.question!.answers ?? q.answers, bossAbility: data.question!.bossAbility ?? q.bossAbility } : q);
        setDancing(data.question.bossAbility === "DANCING_BUZZERS");
      }
    };
    const onPause = () => {
      setPhase((p) => { prevPhaseRef.current = p; return "paused"; });
      clearTimer();
    };
    const onResume = (data: { remainingSecs?: number | null }) => {
      if (data?.remainingSecs != null) startTimer(data.remainingSecs);
      setPhase(prevPhaseRef.current);
    };
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
    socket.on(QUIZ_EVENTS.DISPLAY_MODE_CHANGED, onDisplayModeChanged);
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
      socket.off(QUIZ_EVENTS.DISPLAY_MODE_CHANGED, onDisplayModeChanged);
      window.removeEventListener("message", onMessage);
    };
  }, [socket, applyQuestion, clearTimer, startTimer]);

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

  if (phase === "ended") {
    const scoreRow = (s: TopScore, i: number) => (
      <div key={s.rank} className={`flex items-center gap-3 px-4 py-3 ${s.rank === 1 ? "bg-yellow-400 text-gray-900" : s.rank === 2 ? "bg-gray-300 text-gray-900" : s.rank === 3 ? "bg-amber-600 text-white" : "bg-white/10 text-white"} ${i < topScores.length - 1 ? "border-b border-white/10" : ""}`}>
        <span className="text-sm font-black w-6 text-center">{s.rank}.</span>
        <span className="flex-1 text-sm font-semibold truncate">{s.displayName}</span>
        <span className="text-sm font-bold">{s.score}</span>
      </div>
    );
    const myScore = finalScore > 0 && (
      <div className="bg-white/10 rounded-2xl px-5 py-3 text-center">
        <p className="text-white/50 text-xs font-semibold uppercase tracking-wider mb-0.5">Deine Punkte</p>
        <p className="text-white text-4xl font-black">{finalScore}</p>
      </div>
    );

    if (endResult?.winType === "boss") {
      const classWon = endResult.winner === "class";
      const timeUsedMs = (endResult.bossTotalMs ?? 0) - (endResult.bossTimeRemainingMs ?? 0);
      return (
        <div className={`min-h-screen ${classWon ? "bg-gray-900" : "bg-gray-950"} flex flex-col items-center px-5 py-8 gap-5 text-white`}>
          {classWon ? (
            <div className="flex items-end justify-center -space-x-4">
              <img src="/ch/trizea.png" alt="Trizea" className="h-32 w-auto object-contain select-none pointer-events-none relative z-0" draggable={false} />
              <img src="/ch/parus.png" alt="Parus" className="h-44 w-auto object-contain select-none pointer-events-none relative z-10" draggable={false} />
              <img src="/ch/edo_solo.png" alt="Edo" className="h-32 w-auto object-contain select-none pointer-events-none relative z-0" draggable={false} />
            </div>
          ) : (
            <img src="/ch/troodos.png" alt="Troodos" className="h-44 w-auto object-contain select-none pointer-events-none" draggable={false} />
          )}
          <h1 className={`text-4xl font-black text-center leading-tight ${classWon ? "text-yellow-400" : "text-red-500"}`}>
            {classWon ? "TROODOS BESIEGT!" : "TROODOS\nTRIUMPHIERT"}
          </h1>
          {classWon && endResult.bossTotalMs != null && (
            <div className="bg-yellow-400/10 border border-yellow-400/30 rounded-2xl px-6 py-3 text-center w-full max-w-xs">
              <p className="text-yellow-300/70 text-xs font-semibold uppercase tracking-wider mb-1">Gebrauchte Zeit</p>
              <p className="text-yellow-300 text-2xl font-black tabular-nums">{fmtMs(timeUsedMs)} <span className="text-sm text-yellow-300/50 font-normal">/ {fmtMs(endResult.bossTotalMs)}</span></p>
            </div>
          )}
          {!classWon && endResult.bossMaxHp != null && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-2xl px-5 py-3 text-center w-full max-w-xs">
              <p className="text-red-300/70 text-xs font-semibold uppercase tracking-wider mb-2">Rätselkraft beim Sieg</p>
              <div className="w-full bg-gray-700 rounded-full h-3 mb-2">
                <div className="bg-red-500 h-3 rounded-full" style={{ width: `${Math.round(((endResult.bossHpRemaining ?? 0) / Math.max(endResult.bossMaxHp, 1)) * 100)}%` }} />
              </div>
              <p className="text-red-300 text-xl font-black">{endResult.bossHpRemaining} <span className="text-red-300/50 font-normal text-base">/ {endResult.bossMaxHp} RK</span></p>
            </div>
          )}
          {myScore}
          {topScores.length > 0 && (
            <div className="w-full max-w-xs overflow-hidden rounded-2xl">{topScores.map(scoreRow)}</div>
          )}
        </div>
      );
    }

    if (endResult?.winType === "shield" && endResult.shieldFinal) {
      const isDraw = endResult.winner === "draw";
      const winnerColor = endResult.winner === "Team Grün" ? "#22c55e" : "#f97316";
      return (
        <div className="min-h-screen bg-gray-900 flex flex-col items-center px-5 py-8 gap-5 text-white">
          {isDraw ? (
            <div className="flex items-end gap-4">
              <img src="/ch/edo_solo.png" alt="Team Grün" className="h-36 w-auto object-contain select-none pointer-events-none" draggable={false} />
              <img src="/ch/parus.png" alt="Team Orange" className="h-36 w-auto object-contain select-none pointer-events-none" draggable={false} />
            </div>
          ) : (
            <img src={endResult.winner === "Team Grün" ? "/ch/edo_solo.png" : "/ch/parus.png"} alt={endResult.winner} className="h-44 w-auto object-contain select-none pointer-events-none" draggable={false} />
          )}
          <h1 className="text-4xl font-black text-center" style={{ color: isDraw ? "#e2e8f0" : winnerColor }}>
            {isDraw ? "UNENTSCHIEDEN" : endResult.winner?.toUpperCase()}
          </h1>
          <p className="text-xl font-bold text-white/70">{isDraw ? "Beide Teams gleichauf!" : "hat gewonnen!"}</p>
          <div className="w-full max-w-xs space-y-3">
            {endResult.shieldFinal.map((t) => {
              const color = t.name === "Team Grün" ? "#22c55e" : "#f97316";
              const isWinner = !isDraw && t.name === endResult.winner;
              return (
                <div key={t.name} className="rounded-2xl px-4 py-3" style={isWinner || isDraw ? { outline: `2px solid ${color}`, background: `${color}18` } : { background: `${color}10` }}>
                  <div className="flex items-center justify-between mb-2" style={{ color }}>
                    <span className="font-bold">{t.name} {isWinner ? "🏆" : isDraw ? "🤝" : ""}</span>
                    <span className="font-black tabular-nums">{t.hp} <span className="text-xs font-normal opacity-60">/ {t.maxHp}</span></span>
                  </div>
                  <div className="w-full bg-gray-700 rounded-full h-2.5">
                    <div className="h-2.5 rounded-full" style={{ width: `${Math.max(0, Math.round((t.hp / Math.max(t.maxHp, 1)) * 100))}%`, backgroundColor: color }} />
                  </div>
                </div>
              );
            })}
          </div>
          {myScore}
          {topScores.length > 0 && (
            <div className="w-full max-w-xs overflow-hidden rounded-2xl">{topScores.map(scoreRow)}</div>
          )}
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gray-900 flex flex-col items-center px-5 py-10 gap-5 text-white">
        <img src="/quizzl_logo.png" alt="Quizzl" className="w-32 select-none" draggable={false} />
        <h2 className="text-2xl font-bold">Quiz beendet!</h2>
        {myScore}
        {topScores.length > 0 && (
          <div className="w-full max-w-xs overflow-hidden rounded-2xl">{topScores.map(scoreRow)}</div>
        )}
      </div>
    );
  }

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
      <GameCard question={cardQ} timeLeft={null} teamInfo={teamInfo} myTeamHp={myTeamHp} bossMode={bossMode}
        bossDisplayState={displayMode === "UNIBEAM" ? bossDisplayState : null}
        bossHit={displayMode === "UNIBEAM" ? bossHit : false}
        playerHit={displayMode === "UNIBEAM" ? playerHit : false}
        nowTick={nowTick}
        bossChargeAnim={displayMode === "UNIBEAM" ? bossChargeAnim : null}
        bossAnimTrigger={displayMode === "UNIBEAM" ? bossAnimTrigger : null}
        bossStealChargeValue={displayMode === "UNIBEAM" ? bossStealChargeValue : null}
        fullShieldState={displayMode === "UNIBEAM" ? fullShieldState : null}
        shieldDisplayHp={displayMode === "UNIBEAM" ? shieldDisplayHp : null}
        shieldChargeVisible={displayMode === "UNIBEAM" ? shieldChargeVisible : [false, false]}
        shieldChargeDmg={displayMode === "UNIBEAM" ? shieldChargeDmg : [0, 0]}
        shieldChargeProgress={displayMode === "UNIBEAM" ? shieldChargeProgress : 0}
        shieldHitTeam={displayMode === "UNIBEAM" ? shieldHitTeam : null}
      >
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
  const cardQ: CardQuestion = { text: question.text, answerType: question.answerType, index: question.index, total: question.total, timerFull: barFullSecs, fairZoneSecs: barFairZone };

  return (
    <GameCard question={cardQ} timeLeft={timeLeft} teamInfo={teamInfo} myTeamHp={myTeamHp} bossMode={bossMode}
      bossDisplayState={displayMode === "UNIBEAM" ? bossDisplayState : null}
      bossHit={displayMode === "UNIBEAM" ? bossHit : false}
      playerHit={displayMode === "UNIBEAM" ? playerHit : false}
      nowTick={nowTick}
      bossChargeAnim={displayMode === "UNIBEAM" ? bossChargeAnim : null}
      bossAnimTrigger={displayMode === "UNIBEAM" ? bossAnimTrigger : null}
      bossStealChargeValue={displayMode === "UNIBEAM" ? bossStealChargeValue : null}
      fullShieldState={displayMode === "UNIBEAM" ? fullShieldState : null}
      shieldDisplayHp={displayMode === "UNIBEAM" ? shieldDisplayHp : null}
      shieldChargeVisible={displayMode === "UNIBEAM" ? shieldChargeVisible : [false, false]}
      shieldChargeDmg={displayMode === "UNIBEAM" ? shieldChargeDmg : [0, 0]}
      shieldChargeProgress={displayMode === "UNIBEAM" ? shieldChargeProgress : 0}
      shieldHitTeam={displayMode === "UNIBEAM" ? shieldHitTeam : null}
    >
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
      ) : displayMode === "UNIBEAM" ? (
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
                  {a.text ?? color.shape}
                </button>
              );
            })}
          </div>
          {question.answerType === "MULTIPLE_CHOICE" && selectedIds.length > 0 && (
            <button onClick={submitMultiple} className="w-full py-3 bg-[#02512c] text-white font-bold text-sm rounded-xl active:scale-95 transition-transform">
              Antworten abgeben ({selectedIds.length})
            </button>
          )}
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

function TimerBar({ timeLeft, timeLimitSecs, fairZoneSecs }: {
  timeLeft: number;
  timeLimitSecs: number;
  fairZoneSecs?: number | null;
}) {
  const total = Math.max(timeLimitSecs, 1);
  const pct = Math.max(0, Math.min(100, (timeLeft / total) * 100));
  const fairPct = fairZoneSecs ? Math.min(100, (fairZoneSecs / total) * 100) : 0;
  const isUrgent = timeLeft <= 5;
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="relative flex-1 h-2.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`absolute left-0 top-0 h-full rounded-full ${isUrgent ? "bg-red-400" : "bg-indigo-400"}`}
          style={{ width: `${pct}%`, transition: "width 1s linear" }}
        />
        {fairPct > 0 && (
          <div className="absolute top-0 bottom-0 w-0.5 bg-white/60" style={{ left: `${fairPct}%` }} />
        )}
      </div>
      <span className={`font-black text-sm tabular-nums whitespace-nowrap ${isUrgent ? "text-red-600 animate-pulse" : "text-gray-500"}`}>
        {String(Math.floor(timeLeft / 60)).padStart(2, "0")}:{String(timeLeft % 60).padStart(2, "0")}
      </span>
    </div>
  );
}

function fmtMs(ms: number) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;
}

const TEAM_COLORS = ["#22c55e", "#f97316"] as const;

function GameCard({ children, question, timeLeft, teamInfo, myTeamHp, bossMode, bossDisplayState, bossHit, playerHit, nowTick, bossChargeAnim, bossAnimTrigger, bossStealChargeValue, fullShieldState, shieldDisplayHp, shieldChargeVisible, shieldChargeDmg, shieldChargeProgress, shieldHitTeam, showLogo }: {
  children: React.ReactNode;
  question?: CardQuestion | null;
  timeLeft?: number | null;
  teamInfo?: { teamIndex: number; teamName: string } | null;
  myTeamHp?: { hp: number; maxHp: number } | null;
  bossMode?: boolean;
  bossDisplayState?: { hp: number; maxHp: number; timerEnd: number; timerFrozen?: boolean } | null;
  bossHit?: boolean;
  playerHit?: boolean;
  nowTick?: number;
  bossChargeAnim?: { type: "attack" | "steal"; finalValue: number; progress: number; key: number } | null;
  bossAnimTrigger?: { type: "attack" | "steal"; value: number; key: number } | null;
  bossStealChargeValue?: number | null;
  fullShieldState?: { teams: { name: string; hp: number; maxHp: number }[] } | null;
  shieldDisplayHp?: [number, number] | null;
  shieldChargeVisible?: [boolean, boolean];
  shieldChargeDmg?: [number, number];
  shieldChargeProgress?: number;
  shieldHitTeam?: 0 | 1 | null;
  showLogo?: boolean;
}) {
  const teamColor = teamInfo?.teamIndex === 0 ? TEAM_COLORS[0] : TEAM_COLORS[1];
  const hasOverlay = !!(bossDisplayState || fullShieldState);
  const chargeScale = 0.1 + 0.9 * (bossChargeAnim?.progress ?? 0);
  const shieldChargeScale = 0.1 + 0.9 * (shieldChargeProgress ?? 0);
  return (
    <div className={`min-h-screen bg-gray-50 flex flex-col items-center px-4 py-4 ${hasOverlay ? "justify-start" : "justify-center"}`}>
      {/* Boss overlay (UNIBEAM only) */}
      {bossDisplayState && (() => {
        const timerMs = Math.max(0, bossDisplayState.timerEnd - (nowTick ?? Date.now()));
        const bossHpPct = Math.max(0, Math.round((bossDisplayState.hp / Math.max(bossDisplayState.maxHp, 1)) * 100));
        return (
          <>
            <style>{`
              @keyframes boss-bash{0%,100%{transform:translate(0,0)}20%{transform:translate(-4px,2px)}40%{transform:translate(4px,-2px)}60%{transform:translate(-2px,1px)}80%{transform:translate(2px,-1px)}}
              .boss-bash{animation:boss-bash 0.45s ease-out}
              @keyframes player-bash{0%,100%{transform:translate(0,0)}20%{transform:translate(0,8px)}40%{transform:translate(0,-5px)}60%{transform:translate(0,3px)}80%{transform:translate(0,-2px)}}
              .player-bash{animation:player-bash 0.45s ease-out}
              @keyframes charge-pulse{0%,100%{opacity:.85}50%{opacity:1}}
              @keyframes fly-up{0%{transform:translateX(-50%) translateY(50vh) scale(.5);opacity:0}12%{transform:translateX(-50%) translateY(35vh) scale(1);opacity:1}88%{transform:translateX(-50%) translateY(-8vh) scale(1);opacity:1}100%{transform:translateX(-50%) translateY(-18vh) scale(.5);opacity:0}}
              @keyframes fly-down{0%{transform:translateX(-50%) translateY(-15vh) scale(.5);opacity:0}12%{transform:translateX(-50%) translateY(-5vh) scale(1);opacity:1}88%{transform:translateX(-50%) translateY(8vh) scale(1);opacity:1}100%{transform:translateX(-50%) translateY(15vh) scale(.5);opacity:0}}
            `}</style>
            <div className={`w-full max-w-sm mb-2${bossHit ? " boss-bash" : ""}`}>
              <div className="flex items-center gap-3 bg-red-950 rounded-2xl px-3 py-2">
                <img src="/ch/troodos.png" alt="Troodos" className="h-14 w-auto object-contain select-none pointer-events-none shrink-0" draggable={false} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-black text-red-300">Troodos</span>
                    <span className={`text-xs font-mono font-bold tabular-nums ${timerMs < 60000 ? "text-red-400 animate-pulse" : "text-white/50"}`}>{fmtMs(timerMs)}</span>
                  </div>
                  <div className="w-full h-2 bg-red-900/60 rounded-full overflow-hidden">
                    <div className="h-2 bg-red-500 rounded-full transition-all duration-500" style={{ width: `${bossHpPct}%` }} />
                  </div>
                  <p className="text-[10px] text-white/30 mt-0.5">{bossDisplayState.hp} / {bossDisplayState.maxHp} Rätselkraft</p>
                </div>
              </div>
            </div>
            <div className={`w-full max-w-sm mb-2 flex items-end justify-center gap-1${playerHit ? " player-bash" : ""}`}>
              <img src="/ch/trizea.png" alt="Trizea" className="h-24 w-auto object-contain select-none pointer-events-none" draggable={false} />
              <img src="/ch/parus.png" alt="Parus" className="h-32 w-auto object-contain select-none pointer-events-none" draggable={false} />
              <img src="/ch/edo_solo.png" alt="Edo" className="h-24 w-auto object-contain select-none pointer-events-none" draggable={false} />
            </div>

            {/* Charge orb — attack (bottom) */}
            {bossChargeAnim?.type === "attack" && (
              <div className="fixed bottom-10 left-1/2 pointer-events-none z-50 whitespace-nowrap"
                style={{ animation: "charge-pulse .6s ease-in-out infinite", transform: `translateX(-50%) scale(${chargeScale})` }}>
                <div className="flex items-center gap-2 bg-gray-950/90 rounded-full px-5 py-2.5 shadow-2xl">
                  <span className="text-3xl">⚡</span>
                  <span className="font-black text-yellow-400 text-3xl tabular-nums">-{Math.round(bossChargeAnim.finalValue * bossChargeAnim.progress)} RK</span>
                </div>
              </div>
            )}
            {/* Charge orb — steal (near Troodos, top) */}
            {(bossChargeAnim?.type === "steal" || bossStealChargeValue !== null) && (
              <div className="fixed top-20 left-1/2 pointer-events-none z-50 whitespace-nowrap"
                style={{ animation: "charge-pulse .6s ease-in-out infinite", transform: `translateX(-50%) scale(${chargeScale})` }}>
                <div className="flex items-center gap-2 bg-gray-950/90 rounded-full px-5 py-2.5 shadow-2xl">
                  <span className="text-3xl">⏳</span>
                  <span className="font-black text-red-400 text-3xl tabular-nums">
                    -{bossChargeAnim?.type === "steal" ? Math.round(bossChargeAnim.finalValue * bossChargeAnim.progress) : bossStealChargeValue}s
                  </span>
                </div>
              </div>
            )}
            {/* Projectile */}
            {bossAnimTrigger && (
              <div className="fixed top-1/2 left-1/2 pointer-events-none z-50 whitespace-nowrap"
                style={{ animation: `${bossAnimTrigger.type === "attack" ? "fly-up" : "fly-down"} 900ms ease-in-out forwards` }}>
                <div className="flex items-center gap-2 bg-gray-950/90 rounded-full px-5 py-2.5 shadow-2xl">
                  <span className="text-3xl">{bossAnimTrigger.type === "attack" ? "⚡" : "⏳"}</span>
                  <span className={`font-black text-3xl tabular-nums ${bossAnimTrigger.type === "attack" ? "text-yellow-400" : "text-red-400"}`}>
                    {bossAnimTrigger.type === "attack" ? `-${bossAnimTrigger.value} RK` : `-${bossAnimTrigger.value}s`}
                  </span>
                </div>
              </div>
            )}
          </>
        );
      })()}

      {/* Team shield overlay (UNIBEAM only) */}
      {fullShieldState && (
        <div className="w-full max-w-sm mb-3 space-y-2 relative">
          <style>{`
            @keyframes shield-bash{0%,100%{transform:translateX(0)}20%{transform:translateX(8px)}40%{transform:translateX(-6px)}60%{transform:translateX(4px)}80%{transform:translateX(-2px)}}
            .shield-bash{animation:shield-bash .45s ease-out}
          `}</style>
          {fullShieldState.teams.map((team, idx) => {
            const color = TEAM_COLORS[idx] ?? TEAM_COLORS[0];
            const hp = (shieldDisplayHp ?? [fullShieldState.teams[0].hp, fullShieldState.teams[1].hp])[idx];
            const pct = Math.max(0, Math.round((hp / Math.max(team.maxHp, 1)) * 100));
            const isMyTeam = teamInfo?.teamIndex === idx;
            const isCharging = (shieldChargeVisible ?? [false, false])[idx];
            const dmgVal = (shieldChargeDmg ?? [0, 0])[idx];
            const isHit = shieldHitTeam === idx;
            return (
              <div key={team.name} className={isHit ? "shield-bash" : ""}>
                <div className="rounded-xl px-3 py-2" style={{
                  background: isHit ? `${color}35` : isCharging ? `${color}22` : `${color}14`,
                  outline: isMyTeam ? `2px solid ${color}` : `1px solid ${color}40`,
                  boxShadow: isHit ? `inset 0 0 20px ${color}50` : isCharging ? `inset 0 0 10px ${color}30` : "none",
                  transition: "background .2s, box-shadow .2s",
                }}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <img src={idx === 0 ? "/ch/edo_solo.png" : "/ch/parus.png"} className="h-6 w-auto object-contain select-none pointer-events-none" draggable={false} />
                      <span className="text-xs font-black" style={{ color }}>{team.name}{isMyTeam ? " ✦" : ""}</span>
                    </div>
                    <span className="text-xs font-bold tabular-nums" style={{ color }}>{hp} / {team.maxHp}</span>
                  </div>
                  <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: `${color}30` }}>
                    <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: color, boxShadow: isCharging ? `0 0 6px ${color}` : "none" }} />
                  </div>
                  {/* Charge orb for this team */}
                  {isCharging && dmgVal > 0 && (
                    <div className="mt-1.5 flex justify-center">
                      <div className="flex items-center gap-1.5 bg-gray-950/80 rounded-full px-3 py-1 whitespace-nowrap"
                        style={{ animation: "charge-pulse .6s ease-in-out infinite", transform: `scale(${shieldChargeScale})`, transformOrigin: "center" }}>
                        <span className="text-lg">⚡</span>
                        <span className="font-black text-white text-lg tabular-nums">-{Math.round(dmgVal * (shieldChargeProgress ?? 0))}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Dino group (boss BEAMER mode — no overlay) */}
      {bossMode && !bossDisplayState && (
        <div className="w-full max-w-sm mb-3 flex items-end justify-center gap-3">
          <img src="/ch/trizea.png" alt="Trizea" className="h-48 w-auto object-contain select-none pointer-events-none" draggable={false} />
          <img src="/ch/parus.png" alt="Parus" className="h-60 w-auto object-contain select-none pointer-events-none" draggable={false} />
          <img src="/ch/edo_solo.png" alt="Edo" className="h-48 w-auto object-contain select-none pointer-events-none" draggable={false} />
        </div>
      )}

      {showLogo && !teamInfo && !bossMode && (
        <img src="/quizzl_logo.png" alt="Quizzl" className="w-full max-w-sm mb-4 px-8 select-none" draggable={false} />
      )}
      <div className="w-full max-w-sm bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden flex flex-col min-h-[500px]" style={teamInfo ? { borderTop: `4px solid ${teamColor}` } : undefined}>
        {teamInfo && !fullShieldState && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100">
            <img
              src={teamInfo.teamIndex === 0 ? "/ch/edo_solo.png" : "/ch/parus.png"}
              alt={teamInfo.teamIndex === 0 ? "Edo" : "Parus"}
              className="h-10 w-auto object-contain select-none pointer-events-none"
              draggable={false}
            />
            <span className="font-black text-sm" style={{ color: teamColor }}>{teamInfo.teamName}</span>
            {myTeamHp !== null && myTeamHp !== undefined && (
              <div className="flex-1 flex flex-col items-end gap-0.5">
                <span className="text-xs font-bold" style={{ color: teamColor }}>⚔ {myTeamHp.hp} / {myTeamHp.maxHp}</span>
                <div className="w-16 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                  <div className="h-1.5 rounded-full transition-all duration-500" style={{ width: `${Math.max(0, Math.round((myTeamHp.hp / Math.max(myTeamHp.maxHp, 1)) * 100))}%`, backgroundColor: teamColor }} />
                </div>
              </div>
            )}
          </div>
        )}
        {question && (
          <div className="border-b border-gray-100">
            <div className="flex items-center justify-between px-5 py-3">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                Frage {question.index + 1}/{question.total}
              </span>
            </div>
            {timeLeft !== null && timeLeft !== undefined && question.timerFull != null && (
              <div className="px-5 pb-3">
                <TimerBar timeLeft={timeLeft} timeLimitSecs={question.timerFull} fairZoneSecs={question.fairZoneSecs} />
              </div>
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
          Du spielst im Team mit allen anderen gegen ihn.<br />
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
            className={`absolute flex items-center justify-center rounded-2xl font-bold shadow-lg active:scale-95 ${color.bg} ${color.text} ${selectedIds.includes(a.id) ? "ring-4 ring-white ring-offset-2 ring-offset-gray-50 scale-90" : ""}`}
            style={{
              width: `${DANCING_BUTTON_SIZE}px`,
              height: `${DANCING_BUTTON_SIZE}px`,
              left: `${pos.x}px`,
              top: `${pos.y}px`,
              transition: `left ${dur}s cubic-bezier(0.25,0.46,0.45,0.94), top ${dur}s cubic-bezier(0.34,1.56,0.64,1)`,
            }}
          >
            {a.text
              ? <span className="text-xs font-semibold text-center leading-tight px-1.5">{a.text}</span>
              : <span className="text-2xl">{color.shape}</span>
            }
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
