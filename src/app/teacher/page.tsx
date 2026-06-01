"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { QUIZ_EVENTS } from "@/lib/socket/events";
import * as XLSX from "xlsx";
import { InfoTooltip } from "@/components/InfoTooltip";

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuizSummary {
  id: string; title: string; description: string | null; visibility: string;
  _count: { questions: number };
}

interface AnswerInput { text: string; isCorrect: boolean; sortOrder: number; }
interface QuestionInput {
  id?: string; text: string; answerType: "SINGLE_CHOICE" | "MULTIPLE_CHOICE" | "YES_NO";
  timeLimitSecs: number | null; points: number; answers: AnswerInput[];
  explanation?: string | null;
}
interface AnswerData { id: string; text: string; isCorrect: boolean; sortOrder: number; }
interface QuestionData {
  id: string; text: string; answerType: string; timeLimitSecs: number | null; points: number;
  answers: AnswerData[]; explanation?: string | null;
}
interface FullQuiz {
  id: string; title: string; description: string | null; visibility: string;
  questions: QuestionData[];
}
interface Participant { participantId: string; displayName: string; }
interface SocketQuestion {
  id: string; text: string; answerType: string;
  answers: { id: string; text: string; sortOrder: number }[];
  timeLimitSecs: number | null; index: number; total: number;
}
interface AnswerDist { answerId: string; count: number; isCorrect: boolean; }
interface TopScore { rank: number; displayName: string; score: number; }

type GameMode = "AUTONOMOUS" | "BEAMER";
type BeamerMode = "STANDARD" | "TEAM_SHIELD" | "BOSS";
type SpeedMode = "NORMAL" | "BLITZ" | "SUPER_BLITZ";

interface BossStateData {
  hp: number; maxHp: number; timerEnd: number;
  ability: string | null; wrongCount: number; threshold: number;
}
interface ShieldStateData { teams: { name: string; hp: number; maxHp: number }[] }

interface AnswerRecord {
  questionId: string;
  questionIndex: number;
  absoluteIndex: number;
  answerIds: string[];
  isCorrect: boolean | null;
  timeTakenSecs: number | null;
}
interface PlayerStats {
  participantId: string;
  displayName: string;
  score: number;
  currentQuestionIndex: number;
  answeredCurrentQuestion: boolean;
  correctCount: number;
  wrongCount: number;
  history: AnswerRecord[];
}

interface QuestionStat {
  questionIndex: number;
  text: string;
  totalPlayed: number;       // entries recorded (answered + timed-out)
  answeredCount: number;     // actually submitted an answer
  correctCount: number;
  topWrongAnswers: { text: string; count: number }[];
}

const BEAMER_STYLES = [
  { bg: "bg-red-500",    text: "text-white",     symbol: "▲" },
  { bg: "bg-blue-500",   text: "text-white",     symbol: "●" },
  { bg: "bg-yellow-400", text: "text-gray-900",  symbol: "■" },
  { bg: "bg-green-500",  text: "text-white",     symbol: "◆" },
] as const;

// 1.5 words/s reading speed + 5s thinking buffer, +2s per correct answer for MULTIPLE_CHOICE
// rounded to nearest 5, clamped 10–60s
function suggestTimer(questionText: string, answers: { text: string; isCorrect?: boolean }[], answerType?: string): number {
  const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  const total = words(questionText) + answers.reduce((sum, a) => sum + words(a.text), 0);
  const correctCount = answerType === "MULTIPLE_CHOICE" ? answers.filter((a) => a.isCorrect).length : 0;
  const raw = Math.ceil(total / 1.5) + 8 + correctCount * 2;
  return Math.max(10, Math.min(60, Math.round(raw / 5) * 5));
}

type Phase =
  | "loading" | "error"
  | "quiz-list" | "quiz-editor" | "import" | "bulk-import"
  | "lobby"
  | "active" | "ended";

interface BulkItem {
  filename: string;
  title: string;
  questions: ParsedQuestion[];
  selected: boolean;
  expanded: boolean;
  error?: string;
}

// ─── Kahoot import parser ──────────────────────────────────────────────────────

interface ParsedQuestion {
  text: string;
  answerType: "SINGLE_CHOICE" | "MULTIPLE_CHOICE" | "YES_NO";
  timeLimitSecs: number;
  points: number;
  answers: { text: string; isCorrect: boolean; sortOrder: number }[];
}

function parseKahootXlsx(buffer: ArrayBuffer): ParsedQuestion[] {
  const wb = XLSX.read(buffer, { type: "array" });

  // Results export: has "RawReportData Data" sheet — no header row, fixed column layout:
  // [0] question-key, [1] question text, [2-7] answer options, [8] correct answer texts (CSV), [9] time limit
  const rawSheet = wb.SheetNames.find((n) => n.toLowerCase().includes("rawreport"));
  if (rawSheet) return parseFromRawReport(wb.Sheets[rawSheet]);

  // Quiz definition export: first sheet has a header row containing "Question"
  const ws = wb.Sheets[wb.SheetNames[0]];
  return parseFromDefinition(ws);
}

function parseFromRawReport(ws: XLSX.WorkSheet): ParsedQuestion[] {
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }) as string[][];
  const seen = new Set<string>();
  const questions: ParsedQuestion[] = [];

  for (const row of rows) {
    const key = String(row[0] ?? "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const text = String(row[1] ?? "").trim();
    if (!text) continue;

    // Answer option texts in columns 2–7
    const answerTexts = [row[2], row[3], row[4], row[5], row[6], row[7]]
      .map((c) => String(c ?? "").trim())
      .filter((t) => t !== "");
    if (answerTexts.length < 2) continue;

    // Correct answers: comma-separated answer texts in column 8
    const correctSet = new Set(
      String(row[8] ?? "").split(",").map((s) => s.trim()).filter(Boolean)
    );

    const timeLimitSecs = parseInt(String(row[9] ?? ""), 10) || 20;

    const answers = answerTexts.map((t, i) => ({
      text: t, isCorrect: correctSet.has(t), sortOrder: i,
    }));

    const isYesNo = answerTexts.length === 2 &&
      /^(ja|nein|yes|no|wahr|falsch|true|false)$/i.test(answerTexts[0]) &&
      /^(ja|nein|yes|no|wahr|falsch|true|false)$/i.test(answerTexts[1]);

    const correctCount = answers.filter((a) => a.isCorrect).length;
    const answerType: ParsedQuestion["answerType"] = isYesNo
      ? "YES_NO" : correctCount > 1 ? "MULTIPLE_CHOICE" : "SINGLE_CHOICE";

    questions.push({ text, answerType, timeLimitSecs, points: 100, answers });
  }
  return questions;
}

function parseFromDefinition(ws: XLSX.WorkSheet): ParsedQuestion[] {
  // Quiz definition export has a header row with "Question", "Answer 1–4",
  // "Time limit (sec)", "Correct answer(s)" (numeric index 1–4 or CSV)
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, defval: "" }) as string[][];

  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i].some((c) => String(c).toLowerCase().includes("question"))) {
      headerIdx = i; break;
    }
  }
  if (headerIdx === -1) throw new Error("Kein unterstütztes Kahoot-Format erkannt (weder Ergebnis-Report noch Quiz-Definition)");

  const headers = rows[headerIdx].map((c) => String(c).toLowerCase());
  const col = (kws: string[]) => headers.findIndex((h) => kws.some((k) => h.includes(k)));

  const qCol      = col(["question"]);
  const a1Col     = col(["answer 1"]);
  const a2Col     = col(["answer 2"]);
  const a3Col     = col(["answer 3"]);
  const a4Col     = col(["answer 4"]);
  const timeCol   = col(["time limit", "time"]);
  const correctCol = col(["correct answer"]);
  const typeCol   = col(["question type", "type"]);

  if (qCol === -1 || a1Col === -1 || correctCol === -1)
    throw new Error("Pflicht-Spalten (Question, Answer 1, Correct answer) nicht gefunden");

  const questions: ParsedQuestion[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const text = String(row[qCol] ?? "").trim();
    if (!text) continue;

    const qType = typeCol !== -1 ? String(row[typeCol] ?? "").toLowerCase() : "quiz";
    if (qType && !["quiz", "true or false", ""].includes(qType)) continue;

    const rawCorrect = String(row[correctCol] ?? "").trim();
    const correctNums = rawCorrect.split(/[,;]/).map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));

    const rawAnswers = [a1Col, a2Col, a3Col, a4Col]
      .filter((c) => c !== -1)
      .map((c, idx) => ({ text: String(row[c] ?? "").trim(), idx: idx + 1 }))
      .filter((a) => a.text !== "");
    if (rawAnswers.length < 2) continue;

    const isYesNo = qType === "true or false" ||
      (rawAnswers.length === 2 && /^(yes|no|ja|nein|wahr|falsch|true|false)$/i.test(rawAnswers[0].text));

    const answerType: ParsedQuestion["answerType"] = isYesNo
      ? "YES_NO" : correctNums.length > 1 ? "MULTIPLE_CHOICE" : "SINGLE_CHOICE";

    questions.push({
      text, answerType, points: 100,
      timeLimitSecs: timeCol !== -1 ? (parseInt(String(row[timeCol] ?? ""), 10) || 20) : 20,
      answers: rawAnswers.map((a, sortOrder) => ({ text: a.text, isCorrect: correctNums.includes(a.idx), sortOrder })),
    });
  }
  return questions;
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function TeacherPage() {
  return <Suspense><TeacherContent /></Suspense>;
}

function TeacherContent() {
  const searchParams = useSearchParams();
  const lobbyId = searchParams.get("lobbyId") ?? "";
  const token = searchParams.get("token") ?? "";

  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState("");

  // Quiz list state
  const [ownQuizzes, setOwnQuizzes] = useState<QuizSummary[]>([]);
  const [publicQuizzes, setPublicQuizzes] = useState<QuizSummary[]>([]);
  const [listTab, setListTab] = useState<"own" | "public">("own");

  // Quiz editor state
  const [editingQuiz, setEditingQuiz] = useState<FullQuiz | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editVisibility, setEditVisibility] = useState<"PRIVATE" | "SCHOOL" | "PUBLIC">("PRIVATE");
  const [editQuestions, setEditQuestions] = useState<QuestionInput[]>([]);
  const [savingQuiz, setSavingQuiz] = useState(false);

  // Import state
  const [importTitle, setImportTitle] = useState("");
  const [importError, setImportError] = useState("");
  const [bulkItems, setBulkItems] = useState<BulkItem[]>([]);
  const [bulkSaving, setBulkSaving] = useState(false);

  // Visibility change
  const [visConfirm, setVisConfirm] = useState<{ quizId: string; quizTitle: string; newVis: "PRIVATE" | "SCHOOL" | "PUBLIC" } | null>(null);

  // Quiz selection
  const [selectedQuiz, setSelectedQuiz] = useState<QuizSummary | null>(null);
  const [gameMode, setGameMode] = useState<GameMode>("AUTONOMOUS");
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Lobby state
  const [participants, setParticipants] = useState<Participant[]>([]);

  // Active session state
  const [currentQ, setCurrentQ] = useState<SocketQuestion | null>(null);
  const [responseCount, setResponseCount] = useState<{ answered: number; total: number } | null>(null);
  const [distribution, setDistribution] = useState<AnswerDist[] | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [animLocked, setAnimLocked] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("quizzl_autoAdvance") !== null
      ? localStorage.getItem("quizzl_autoAdvance") === "true"
      : true
  );
  const [rememberSetting, setRememberSetting] = useState<boolean>(() =>
    typeof window !== "undefined" && localStorage.getItem("quizzl_autoAdvance") !== null
  );
  const [autoCountdown, setAutoCountdown] = useState<number | null>(null);
  const [topScores, setTopScores] = useState<TopScore[]>([]);
  // Sub-mode state (populated from teacherJoin ack)
  const [beamerMode, setBeamerMode] = useState<BeamerMode>("STANDARD");
  const [speedMode, setSpeedMode] = useState<SpeedMode>("NORMAL");
  const [answersVisible, setAnswersVisible] = useState(false);
  const [pendingEnd, setPendingEnd] = useState(false);
  const [bossState, setBossState] = useState<BossStateData | null>(null);
  // Analytics
  const [playerStats, setPlayerStats] = useState<PlayerStats[]>([]);
  const [showStats, setShowStats] = useState(false);
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [showQuestionStats, setShowQuestionStats] = useState(false);
  const [expandedQuestion, setExpandedQuestion] = useState<number | null>(null);
  const [quizData, setQuizData] = useState<FullQuiz | null>(null);

  // "New game" panel state (shown on ended screen)
  const [nextQuizId, setNextQuizId] = useState<string | null>(null);
  const [nextBeamerMode, setNextBeamerMode] = useState<BeamerMode>("STANDARD");
  const [nextSpeedMode, setNextSpeedMode] = useState<SpeedMode>("NORMAL");
  const [nextBossTimerMins, setNextBossTimerMins] = useState(15);
  const [shieldState, setShieldState] = useState<ShieldStateData | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const [socketConnected, setSocketConnected] = useState(true);
  const [paused, setPaused] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const hasTeacherJoinedRef = useRef(false);
  const currentQIndexRef = useRef<number | null>(null);

  // Refs for keyboard/postMessage handler (avoids stale closures)
  const phaseRef = useRef<Phase>("loading");
  const revealedRef = useRef(false);
  const animLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoCountdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const beamerModeRef = useRef<BeamerMode>("STANDARD");
  const autoAdvanceRef = useRef<boolean>(true);
  const speedModeRef = useRef<SpeedMode>("NORMAL");
  const answersVisibleRef = useRef(false);
  const pendingEndRef = useRef(false);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { revealedRef.current = revealed; }, [revealed]);
  useEffect(() => { speedModeRef.current = speedMode; }, [speedMode]);
  useEffect(() => { answersVisibleRef.current = answersVisible; }, [answersVisible]);
  useEffect(() => { pendingEndRef.current = pendingEnd; }, [pendingEnd]);
  useEffect(() => { beamerModeRef.current = beamerMode; }, [beamerMode]);
  useEffect(() => { autoAdvanceRef.current = autoAdvance; }, [autoAdvance]);
  useEffect(() => {
    if (rememberSetting) localStorage.setItem("quizzl_autoAdvance", String(autoAdvance));
    else localStorage.removeItem("quizzl_autoAdvance");
  }, [autoAdvance, rememberSetting]);

  const fetchQuizzes = useCallback(async () => {
    const [own, pub] = await Promise.all([
      fetch("/api/quizzes?scope=own", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/quizzes?scope=public", { credentials: "include" }).then((r) => r.json()),
    ]);
    setOwnQuizzes(Array.isArray(own) ? own : []);
    setPublicQuizzes(Array.isArray(pub) ? pub : []);
  }, []);

  // Fetch full quiz data (question + answer texts) whenever the active quiz is known
  useEffect(() => {
    if (!selectedQuiz?.id) return;
    fetch(`/api/quizzes/${selectedQuiz.id}`, { credentials: "include" })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setQuizData(data); });
  }, [selectedQuiz?.id]);

  const applyVisibilityChange = async (quizId: string, newVis: "PRIVATE" | "SCHOOL" | "PUBLIC") => {
    await fetch(`/api/quizzes/${quizId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: newVis }),
      credentials: "include",
    });
    setOwnQuizzes((prev) => prev.map((q) => q.id === quizId ? { ...q, visibility: newVis } : q));
    setVisConfirm(null);
  };

  const handleVisibilityChange = (quizId: string, quizTitle: string, newVis: "PRIVATE" | "SCHOOL" | "PUBLIC") => {
    if (newVis === "PUBLIC") {
      setVisConfirm({ quizId, quizTitle, newVis });
    } else {
      applyVisibilityChange(quizId, newVis);
    }
  };

  // Auth + initial state detection
  // lobbyId is optional: when empty this is standalone (hub /quizzl page), no session check needed
  useEffect(() => {
    if (!token) { setError("Fehlende Parameter"); setPhase("error"); return; }

    fetch("/api/auth/module-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "include",
    }).then(async (res) => {
      if (!res.ok) { setError("Authentifizierung fehlgeschlagen"); setPhase("error"); return; }

      if (!lobbyId) {
        // Standalone mode: just show quiz management
        await fetchQuizzes();
        setPhase("quiz-list");
        return;
      }

      // Check for existing active session (retry up to 3× with 500ms delay for race condition)
      let activeSession = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const activeRes = await fetch(`/api/sessions/active?lobbyId=${encodeURIComponent(lobbyId)}`, { credentials: "include" });
        activeSession = await activeRes.json();
        if (activeSession?.id) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }

      if (activeSession?.id) {
        setSessionId(activeSession.id);
        sessionIdRef.current = activeSession.id;
        if (activeSession.quiz?.title) {
          setSelectedQuiz({ id: activeSession.quizId, title: activeSession.quiz.title, description: null, visibility: "", _count: { questions: 0 } });
        }
        connectSocket(activeSession.id, activeSession.currentQuestionIndex >= 0 ? "active" : "lobby");
      } else {
        await fetchQuizzes();
        setPhase("quiz-list");
      }
    });

    return () => { socketRef.current?.disconnect(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const questionStats = useMemo<QuestionStat[]>(() => {
    if (!quizData || playerStats.length === 0) return [];
    return quizData.questions.map((q, idx) => {
      const allEntries = playerStats.flatMap((p) => p.history.filter((r) => r.questionIndex === idx));
      if (allEntries.length === 0) return null;
      const answeredEntries = allEntries.filter((r) => r.answerIds.length > 0);
      const correctCount = allEntries.filter((r) => r.isCorrect === true).length;
      const wrongEntries = answeredEntries.filter((r) => r.isCorrect === false);

      const wrongCounts = new Map<string, number>();
      for (const entry of wrongEntries) {
        for (const id of entry.answerIds) {
          const ans = q.answers.find((a) => a.id === id);
          if (ans && !ans.isCorrect) wrongCounts.set(id, (wrongCounts.get(id) ?? 0) + 1);
        }
      }
      const topWrongAnswers = Array.from(wrongCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, count]) => ({ text: q.answers.find((a) => a.id === id)?.text ?? "?", count }));

      return {
        questionIndex: idx,
        text: q.text,
        totalPlayed: allEntries.length,
        answeredCount: answeredEntries.length,
        correctCount,
        topWrongAnswers,
      } as QuestionStat;
    }).filter((qs): qs is QuestionStat => qs !== null);
  }, [playerStats, quizData]);

  const cancelAutoCountdown = useCallback(() => {
    if (autoCountdownIntervalRef.current) { clearInterval(autoCountdownIntervalRef.current); autoCountdownIntervalRef.current = null; }
    setAutoCountdown(null);
  }, []);

  const startAutoCountdown = useCallback(() => {
    cancelAutoCountdown();
    setAutoCountdown(5);
    autoCountdownIntervalRef.current = setInterval(() => {
      setAutoCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(autoCountdownIntervalRef.current!);
          autoCountdownIntervalRef.current = null;
          socketRef.current?.emit(QUIZ_EVENTS.NEXT_QUESTION);
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  }, [cancelAutoCountdown]);

  const startAutoCountdownRef = useRef(startAutoCountdown);
  useEffect(() => { startAutoCountdownRef.current = startAutoCountdown; }, [startAutoCountdown]);

  const connectSocket = useCallback((sid: string, initialPhase: "lobby" | "active") => {
    if (socketRef.current) socketRef.current.disconnect();
    sessionIdRef.current = sid;

    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || window.location.origin;
    const socket = io(socketUrl, { withCredentials: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      setSocketConnected(true);
      socket.emit("quiz:teacherJoin", { lobbyId, token }, (ack: { ok: boolean; sessionId?: string; gameMode?: string; beamerMode?: string; speedMode?: string; bossTimerSeconds?: number; participants?: { participantId: string; displayName: string }[]; error?: string }) => {
        if (!ack.ok) {
          if (!hasTeacherJoinedRef.current) { setError(ack.error ?? "Socket-Verbindung fehlgeschlagen"); setPhase("error"); }
          return;
        }
        const isReconnect = hasTeacherJoinedRef.current;
        hasTeacherJoinedRef.current = true;
        if (!isReconnect) {
          if (ack.gameMode === "BEAMER" || ack.gameMode === "AUTONOMOUS") setGameMode(ack.gameMode);
          setBeamerMode((ack.beamerMode as BeamerMode | undefined) ?? "STANDARD");
          setSpeedMode((ack.speedMode as SpeedMode | undefined) ?? "NORMAL");
          setBossState(null);
          setShieldState(null);
          setPendingEnd(false);
          if (ack.participants?.length) setParticipants(ack.participants);
          setPhase(initialPhase);
        }
      });
    });

    socket.on("disconnect", () => setSocketConnected(false));

    socket.on(QUIZ_EVENTS.PAUSE, () => {
      setPaused(true);
      if (autoCountdownIntervalRef.current) {
        clearInterval(autoCountdownIntervalRef.current);
        autoCountdownIntervalRef.current = null;
      }
      setAutoCountdown(null);
    });
    socket.on(QUIZ_EVENTS.RESUME, () => setPaused(false));
    socket.on(QUIZ_EVENTS.PLAYER_JOINED, (p: Participant) => setParticipants((prev) => [...prev.filter((x) => x.participantId !== p.participantId), p]));
    socket.on(QUIZ_EVENTS.PLAYER_LEFT, ({ participantId }: { participantId: string }) => setParticipants((prev) => prev.filter((x) => x.participantId !== participantId)));

    socket.on(QUIZ_EVENTS.QUESTION, (data: SocketQuestion) => {
      const isNewQuestion = data.index !== currentQIndexRef.current;
      currentQIndexRef.current = data.index;
      setCurrentQ(data);
      if (isNewQuestion) {
        setDistribution(null);
        setResponseCount({ answered: 0, total: participants.length });
        setRevealed(false);
        setAnswersVisible(false);
        if (animLockTimerRef.current) { clearTimeout(animLockTimerRef.current); animLockTimerRef.current = null; }
        setAnimLocked(false);
        if (autoCountdownIntervalRef.current) { clearInterval(autoCountdownIntervalRef.current); autoCountdownIntervalRef.current = null; }
        setAutoCountdown(null);
      }
      setPhase("active");
    });

    socket.on(QUIZ_EVENTS.ANSWERS_VISIBLE, () => setAnswersVisible(true));
    socket.on(QUIZ_EVENTS.BOSS_STATE, (data: BossStateData) => setBossState(data));
    socket.on(QUIZ_EVENTS.SHIELD_STATE, (data: ShieldStateData) => setShieldState(data));

    socket.on(QUIZ_EVENTS.RESPONSE_COUNT, (data: { answered: number; total: number }) => setResponseCount(data));
    socket.on(QUIZ_EVENTS.ANSWER_DIST, ({ distribution: d }: { distribution: AnswerDist[] }) => {
      setDistribution(d);
      setRevealed(true);
      if (animLockTimerRef.current) clearTimeout(animLockTimerRef.current);
      const lockMs = beamerModeRef.current === "TEAM_SHIELD" ? 7000 : beamerModeRef.current === "BOSS" ? 6000 : 0;
      if (lockMs > 0) {
        setAnimLocked(true);
        animLockTimerRef.current = setTimeout(() => {
          animLockTimerRef.current = null;
          setAnimLocked(false);
          if (autoAdvanceRef.current) startAutoCountdownRef.current();
        }, lockMs);
      } else {
        if (autoAdvanceRef.current) startAutoCountdownRef.current();
      }
    });
    socket.on(QUIZ_EVENTS.STATS_UPDATE, ({ participants }: { participants: PlayerStats[] }) => setPlayerStats(participants));

    socket.on(QUIZ_EVENTS.SCOREBOARD, ({ topN }: { topN: TopScore[] }) => setTopScores(topN));
    socket.on(QUIZ_EVENTS.END, ({ topScores: ts }: { topScores: TopScore[] }) => {
      if (ts) setTopScores(ts);
      setPhase("ended");
    });
    socket.on(QUIZ_EVENTS.PENDING_END, () => setPendingEnd(true));
  }, [lobbyId, token, participants.length]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const nextQuestion = () => socketRef.current?.emit(QUIZ_EVENTS.NEXT_QUESTION);
  const revealAnswer = () => socketRef.current?.emit(QUIZ_EVENTS.REVEAL_ANSWER);
  const showAnswers = () => socketRef.current?.emit(QUIZ_EVENTS.SHOW_ANSWERS);
  const endSession = () => {
    if (confirm("Session wirklich beenden?")) {
      socketRef.current?.emit(QUIZ_EVENTS.END_SESSION);
    }
  };

  // Boss timer tick
  useEffect(() => {
    if (beamerMode !== "BOSS" || !bossState) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [beamerMode, bossState]);

  // When the game ends, pre-fill new-game panel with current settings and refresh quiz list
  useEffect(() => {
    if (phase !== "ended") return;
    setNextBeamerMode(beamerMode);
    setNextSpeedMode(speedMode);
    setNextQuizId(null);
    fetchQuizzes();
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Forward spacebar / pause commands from the hub parent window
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "KEYBOARD_CMD") {
        if (phaseRef.current !== "active") return;
        if (revealedRef.current && !animLockTimerRef.current) {
          socketRef.current?.emit(QUIZ_EVENTS.NEXT_QUESTION);
        } else if (speedModeRef.current === "BLITZ" && !answersVisibleRef.current) {
          socketRef.current?.emit(QUIZ_EVENTS.SHOW_ANSWERS);
        } else {
          socketRef.current?.emit(QUIZ_EVENTS.REVEAL_ANSWER);
        }
      } else if (e.data?.type === "PAUSE_CMD") {
        socketRef.current?.emit(QUIZ_EVENTS.PAUSE);
      } else if (e.data?.type === "RESUME_CMD") {
        socketRef.current?.emit(QUIZ_EVENTS.RESUME);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openBeamer = () => {
    if (!lobbyId) return;
    window.open(`/beamer/${lobbyId}?token=${encodeURIComponent(token)}`, "_blank");
  };

  // ─── Quiz Editor ─────────────────────────────────────────────────────────

  const openEditor = async (quizId: string | null) => {
    if (quizId) {
      const res = await fetch(`/api/quizzes/${quizId}`, { credentials: "include" });
      const data: FullQuiz = await res.json();
      setEditingQuiz(data);
      setEditTitle(data.title);
      setEditDesc(data.description ?? "");
      setEditVisibility(data.visibility as "PRIVATE" | "SCHOOL" | "PUBLIC");
      setEditQuestions(data.questions.map((q) => ({
        id: q.id, text: q.text, answerType: q.answerType as QuestionInput["answerType"],
        timeLimitSecs: q.timeLimitSecs, points: q.points, explanation: q.explanation ?? null,
        answers: q.answers.map((a) => ({ text: a.text, isCorrect: a.isCorrect, sortOrder: a.sortOrder })),
      })));
    } else {
      setEditingQuiz(null);
      setEditTitle("");
      setEditDesc("");
      setEditVisibility("PRIVATE");
      setEditQuestions([]);
    }
    setPhase("quiz-editor");
  };

  const saveQuiz = async () => {
    setSavingQuiz(true);
    try {
      let quizId = editingQuiz?.id;
      if (!quizId) {
        const res = await fetch("/api/quizzes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: editTitle, description: editDesc.trim() || undefined, visibility: editVisibility }),
          credentials: "include",
        });
        const data = await res.json();
        quizId = data.id;
      } else {
        await fetch(`/api/quizzes/${quizId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: editTitle, description: editDesc.trim() || undefined, visibility: editVisibility }),
          credentials: "include",
        });
      }
      if (!quizId) return;

      // Sync questions: delete removed, update existing, create new
      const existingIds = editingQuiz?.questions.map((q) => q.id) ?? [];
      const currentIds = editQuestions.filter((q) => q.id).map((q) => q.id!);
      const removedIds = existingIds.filter((id) => !currentIds.includes(id));

      for (const id of removedIds) {
        await fetch(`/api/quizzes/${quizId}/questions/${id}`, { method: "DELETE", credentials: "include" });
      }
      for (const [i, q] of editQuestions.entries()) {
        const body = { ...q, sortOrder: i };
        if (q.id) {
          await fetch(`/api/quizzes/${quizId}/questions/${q.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "include",
          });
        } else {
          const res = await fetch(`/api/quizzes/${quizId}/questions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "include",
          });
          const created = await res.json();
          editQuestions[i].id = created.id;
        }
      }

      await fetchQuizzes();
      setPhase("quiz-list");
    } finally {
      setSavingQuiz(false);
    }
  };

  const addQuestion = () => {
    setEditQuestions((prev) => [
      ...prev,
      {
        text: "",
        answerType: "SINGLE_CHOICE",
        timeLimitSecs: 10,
        points: 100,
        answers: [
          { text: "", isCorrect: true, sortOrder: 0 },
          { text: "", isCorrect: false, sortOrder: 1 },
        ],
      },
    ]);
  };

  const removeQuestion = (i: number) => setEditQuestions((prev) => prev.filter((_, idx) => idx !== i));

  const updateQuestion = (i: number, patch: Partial<QuestionInput>) =>
    setEditQuestions((prev) => prev.map((q, idx) => {
      if (idx !== i) return q;
      const updated = { ...q, ...patch };
      // Auto-recalculate timer when text changes (unless it's a manual timer edit)
      if (("text" in patch) && !("timeLimitSecs" in patch)) {
        updated.timeLimitSecs = suggestTimer(updated.text, updated.answers, updated.answerType);
      }
      return updated;
    }));

  const updateAnswer = (qi: number, ai: number, patch: Partial<AnswerInput>) =>
    setEditQuestions((prev) => prev.map((q, idx) => {
      if (idx !== qi) return q;
      const answers = q.answers.map((a, aidx) => aidx === ai ? { ...a, ...patch } : a);
      // Auto-recalculate timer when answer text changes
      const timeLimitSecs = ("text" in patch) ? suggestTimer(q.text, answers, q.answerType) : q.timeLimitSecs;
      return { ...q, answers, timeLimitSecs };
    }));

  const addAnswer = (qi: number) =>
    setEditQuestions((prev) => prev.map((q, idx) =>
      idx !== qi ? q : { ...q, answers: [...q.answers, { text: "", isCorrect: false, sortOrder: q.answers.length }] }
    ));

  const removeAnswer = (qi: number, ai: number) =>
    setEditQuestions((prev) => prev.map((q, idx) =>
      idx !== qi ? q : { ...q, answers: q.answers.filter((_, aidx) => aidx !== ai) }
    ));

  // ─── Import ───────────────────────────────────────────────────────────────

  const openImport = () => {
    setImportTitle("");
    setImportError("");
    setPhase("import");
  };

  const handleImportFiles = (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => /\.(xlsx|xls)$/i.test(f.name));
    if (arr.length === 0) { setImportError("Keine .xlsx-Dateien gefunden."); return; }
    setImportError("");

    if (arr.length === 1) {
      // Single file → pre-fill editor
      arr[0].arrayBuffer().then((buf) => {
        try {
          const qs = parseKahootXlsx(buf);
          if (qs.length === 0) { setImportError("Keine Fragen erkannt."); return; }
          const title = importTitle.trim() || arr[0].name.replace(/\.(xlsx|xls)$/i, "");
          setEditingQuiz(null); setEditTitle(title); setEditDesc("");
          setEditVisibility("PRIVATE"); setEditQuestions(qs);
          setPhase("quiz-editor");
        } catch (e) { setImportError(e instanceof Error ? e.message : "Fehler beim Lesen der Datei"); }
      });
      return;
    }

    // Multiple files → bulk overview
    Promise.all(arr.map((f) =>
      f.arrayBuffer().then((buf) => {
        try {
          const qs = parseKahootXlsx(buf);
          return { filename: f.name, title: f.name.replace(/\.(xlsx|xls)$/i, ""), questions: qs, selected: qs.length > 0, expanded: false, error: qs.length === 0 ? "Keine Fragen erkannt" : undefined } as BulkItem;
        } catch (e) {
          return { filename: f.name, title: f.name.replace(/\.(xlsx|xls)$/i, ""), questions: [], selected: false, expanded: false, error: e instanceof Error ? e.message : "Fehler" } as BulkItem;
        }
      })
    )).then((items) => { setBulkItems(items); setPhase("bulk-import"); });
  };

  const saveBulk = async () => {
    const toSave = bulkItems.filter((it) => it.selected && it.questions.length > 0);
    if (toSave.length === 0) return;
    setBulkSaving(true);
    try {
      for (const item of toSave) {
        const res = await fetch("/api/quizzes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: item.title, visibility: "PRIVATE" }),
          credentials: "include",
        });
        const { id: quizId } = await res.json();
        for (const [i, q] of item.questions.entries()) {
          await fetch(`/api/quizzes/${quizId}/questions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...q, sortOrder: i }),
            credentials: "include",
          });
        }
      }
      await fetchQuizzes();
      setPhase("quiz-list");
    } finally { setBulkSaving(false); }
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  if (phase === "loading") return <Layout><div className="flex items-center justify-center flex-1"><Spinner /></div></Layout>;
  if (phase === "error") return <Layout><div className="flex items-center justify-center flex-1"><p className="text-red-500 font-medium">{error}</p></div></Layout>;

  // ── QUIZ LIST ──
  if (phase === "quiz-list") {
    const list = listTab === "own" ? ownQuizzes : publicQuizzes;
    const isStandalone = !lobbyId;
    return (
      <Layout>
        <header className="flex items-center justify-between px-4 py-3 border-b">
          {isStandalone
            ? <img src="/logo.png" alt="Quizzl" className="h-48 w-auto object-contain" />
            : <h1 className="font-bold text-lg">Quizzl</h1>
          }
          <div className="flex gap-2">
            <button onClick={openImport} className="text-sm border border-gray-300 text-gray-600 px-3 py-1.5 rounded-lg hover:bg-gray-50">
              ↑ Import
            </button>
            <button onClick={() => openEditor(null)} className="text-sm bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700">
              + Neu
            </button>
          </div>
        </header>
        <div className="flex border-b">
          {(["own", "public"] as const).map((t) => (
            <button key={t} onClick={() => setListTab(t)}
              className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${listTab === t ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              {t === "own" ? "Meine Quizzls" : "Entdecken"}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto divide-y">
          {list.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-12">
              {listTab === "own" ? "Noch keine Quizzls. Erstell dein erstes Quizzl!" : "Keine öffentlichen Quizzls gefunden."}
            </p>
          )}
          {list.map((q) => (
            <div key={q.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{q.title}</p>
                <p className="text-xs text-gray-400">{q._count.questions} Fragen</p>
              </div>
              <div className="flex gap-2 shrink-0 items-center">
                {listTab === "own" && (
                  <select
                    value={q.visibility}
                    onChange={(e) => handleVisibilityChange(q.id, q.title, e.target.value as "PRIVATE" | "SCHOOL" | "PUBLIC")}
                    className="text-xs border rounded px-1.5 py-1 text-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white"
                  >
                    <option value="PRIVATE">Privat</option>
                    <option value="SCHOOL">Meine Schule</option>
                    <option value="PUBLIC">Öffentlich</option>
                  </select>
                )}
                {listTab === "own" && (
                  <button onClick={() => openEditor(q.id)} className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 border rounded">
                    Bearbeiten
                  </button>
                )}
                {isStandalone ? (
                  <button
                    onClick={() => window.parent.postMessage({ type: "START_ROOM", quizId: q.id }, "*")}
                    className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700">
                    ▶ Raum starten
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setSelectedQuiz(q);
                      window.parent.postMessage({ type: "QUIZ_SELECTED", quizId: q.id }, "*");
                    }}
                    className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded hover:bg-indigo-700">
                    Auswählen
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {visConfirm && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4">
              <div>
                <p className="font-bold text-gray-900 text-base">Quizzl öffentlich machen?</p>
                <p className="text-sm text-gray-500 mt-1 leading-snug">„{visConfirm.quizTitle}"</p>
              </div>
              <ul className="text-sm text-gray-600 space-y-1.5">
                <li className="flex gap-2"><span className="text-amber-500 shrink-0">⚠</span> Das Quizzl ist für <strong>alle Lehrer</strong> auf der Plattform sichtbar und durchsuchbar.</li>
                <li className="flex gap-2"><span className="text-amber-500 shrink-0">⚠</span> Andere Lehrer können es <strong>ansehen und als Kopie übernehmen</strong>.</li>
                <li className="flex gap-2"><span className="text-gray-400 shrink-0">ℹ</span> Du kannst die Sichtbarkeit jederzeit wieder auf Privat zurückstellen.</li>
              </ul>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setVisConfirm(null)}
                  className="flex-1 py-2 border rounded-xl text-sm font-medium text-gray-600 hover:bg-gray-50"
                >
                  Abbrechen
                </button>
                <button
                  onClick={() => applyVisibilityChange(visConfirm.quizId, visConfirm.newVis)}
                  className="flex-1 py-2 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700"
                >
                  Ja, öffentlich machen
                </button>
              </div>
            </div>
          </div>
        )}
      </Layout>
    );
  }

  // ── IMPORT ──
  if (phase === "import") {
    return (
      <Layout>
        <header className="flex items-center gap-3 px-4 py-3 border-b">
          <button onClick={() => setPhase("quiz-list")} className="text-gray-500 hover:text-gray-800">←</button>
          <h1 className="font-bold text-lg flex-1">Quizzl importieren</h1>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Titel (optional — wird sonst aus Dateiname übernommen)</label>
            <input value={importTitle} onChange={(e) => setImportTitle(e.target.value)} maxLength={200}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="Quizzl-Titel" />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-2">Kahoot-Export (.xlsx) auswählen</label>
            <label
              className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-gray-300 rounded-xl p-10 cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30 transition-colors"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) handleImportFiles(e.dataTransfer.files); }}
            >
              <span className="text-3xl">📂</span>
              <span className="text-sm text-gray-600 font-medium">Dateien hierher ziehen</span>
              <span className="text-xs text-gray-400">oder klicken zum Auswählen (.xlsx)</span>
              <input type="file" accept=".xlsx,.xls" multiple className="hidden"
                onChange={(e) => { if (e.target.files?.length) handleImportFiles(e.target.files); }} />
            </label>
            <p className="text-xs text-gray-400 mt-2 text-center">Eine Datei → Editor zum Bearbeiten. Mehrere Dateien → Massenimport-Übersicht.</p>
          </div>

          {importError && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-600">{importError}</div>
          )}
        </div>
      </Layout>
    );
  }

  // ── BULK IMPORT ──
  if (phase === "bulk-import") {
    const selectedCount = bulkItems.filter((it) => it.selected).length;
    const allSelected = bulkItems.every((it) => it.selected || it.error);
    return (
      <Layout>
        <header className="flex items-center gap-3 px-4 py-3 border-b">
          <button onClick={() => setPhase("import")} className="text-gray-500 hover:text-gray-800">←</button>
          <h1 className="font-bold text-lg flex-1">Massenimport</h1>
          <button
            onClick={() => setBulkItems((prev) => prev.map((it) => ({ ...it, selected: it.error ? false : !allSelected })))}
            className="text-xs text-indigo-600 hover:underline"
          >
            {allSelected ? "Alle abwählen" : "Alle auswählen"}
          </button>
        </header>

        <div className="flex-1 overflow-y-auto divide-y">
          {bulkItems.map((item, idx) => (
            <div key={idx} className={`px-4 py-3 ${item.error ? "opacity-50" : ""}`}>
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={item.selected}
                  disabled={!!item.error}
                  onChange={(e) => setBulkItems((prev) => prev.map((it, i) => i === idx ? { ...it, selected: e.target.checked } : it))}
                  className="mt-1 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  {item.error ? (
                    <p className="text-sm font-medium text-red-500">{item.filename}</p>
                  ) : (
                    <input
                      value={item.title}
                      onChange={(e) => setBulkItems((prev) => prev.map((it, i) => i === idx ? { ...it, title: e.target.value } : it))}
                      className="w-full text-sm font-medium border-0 border-b border-transparent hover:border-gray-300 focus:border-indigo-400 focus:outline-none bg-transparent pb-0.5"
                    />
                  )}
                  <div className="flex items-center gap-2 mt-0.5">
                    {item.error ? (
                      <p className="text-xs text-red-400">{item.error}</p>
                    ) : (
                      <>
                        <span className="text-xs text-gray-400">{item.questions.length} Fragen</span>
                        <button
                          onClick={() => setBulkItems((prev) => prev.map((it, i) => i === idx ? { ...it, expanded: !it.expanded } : it))}
                          className="text-xs text-indigo-500 hover:underline"
                        >
                          {item.expanded ? "▲ einklappen" : "▼ anzeigen"}
                        </button>
                      </>
                    )}
                  </div>
                  {item.expanded && (
                    <ol className="mt-2 space-y-2 pl-1">
                      {item.questions.map((q, qi) => (
                        <li key={qi}>
                          <p className="text-xs text-gray-600 leading-snug font-medium">
                            <span className="text-gray-300 mr-1">{qi + 1}.</span>{q.text}
                          </p>
                          <ul className="mt-1 space-y-0.5 pl-4">
                            {q.answers.map((a, ai) => (
                              <li key={ai} className="flex items-baseline gap-1.5 text-xs text-gray-400">
                                <span className={`shrink-0 font-bold ${a.isCorrect ? "text-emerald-500" : "text-gray-300"}`}>
                                  {a.isCorrect ? "✓" : "–"}
                                </span>
                                {a.text}
                              </li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="px-4 pb-4 pt-2 border-t">
          <button
            onClick={saveBulk}
            disabled={selectedCount === 0 || bulkSaving}
            className="w-full py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-40 transition-colors"
          >
            {bulkSaving ? "Importieren..." : `${selectedCount} Quizzl${selectedCount !== 1 ? "s" : ""} importieren`}
          </button>
        </div>
      </Layout>
    );
  }

  // ── QUIZ EDITOR ──
  if (phase === "quiz-editor") {
    return (
      <Layout>
        <header className="flex items-center gap-3 px-4 py-3 border-b">
          <button onClick={() => setPhase("quiz-list")} className="text-gray-500 hover:text-gray-800">←</button>
          <h1 className="font-bold text-lg flex-1">{editingQuiz ? "Quizzl bearbeiten" : "Neues Quizzl"}</h1>
          <button onClick={saveQuiz} disabled={!editTitle.trim() || savingQuiz}
            className="text-sm bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700 disabled:opacity-50">
            {savingQuiz ? "Speichern..." : "Speichern"}
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
          {/* Metadata */}
          <section className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Titel</label>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={200}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Quizzl-Titel" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Beschreibung (optional)</label>
              <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} rows={2} maxLength={1000}
                className="w-full border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500"
                placeholder="Kurze Beschreibung" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Sichtbarkeit</label>
              <select value={editVisibility} onChange={(e) => setEditVisibility(e.target.value as typeof editVisibility)}
                className="border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="PRIVATE">Privat</option>
                <option value="SCHOOL">Meine Schule</option>
                <option value="PUBLIC">Öffentlich</option>
              </select>
            </div>
          </section>

          {/* Questions */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-sm">Fragen ({editQuestions.length})</h2>
              <button onClick={addQuestion} className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg font-medium">
                + Frage hinzufügen
              </button>
            </div>
            <div className="space-y-4">
              {editQuestions.map((q, qi) => (
                <div key={qi} className="border rounded-xl p-4 space-y-3 bg-gray-50">
                  <div className="flex items-start gap-2">
                    <span className="text-xs text-gray-400 mt-2 w-6 text-center">{qi + 1}.</span>
                    <div className="flex-1 space-y-2">
                      <textarea value={q.text} onChange={(e) => updateQuestion(qi, { text: e.target.value })}
                        rows={2} className="w-full border rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                        placeholder="Fragetext" />
                      <textarea value={q.explanation ?? ""} onChange={(e) => updateQuestion(qi, { explanation: e.target.value || null })}
                        rows={2} className="w-full border rounded-lg px-3 py-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white text-gray-600"
                        placeholder="Erklärung (optional) – wird nach der Auflösung angezeigt" />
                      <div className="flex gap-2 flex-wrap">
                        <select value={q.answerType} onChange={(e) => {
                          const at = e.target.value as QuestionInput["answerType"];
                          const answers = at === "YES_NO"
                            ? [{ text: "Ja", isCorrect: true, sortOrder: 0 }, { text: "Nein", isCorrect: false, sortOrder: 1 }]
                            : q.answers;
                          updateQuestion(qi, { answerType: at, answers });
                        }} className="border rounded px-2 py-1 text-xs focus:outline-none">
                          <option value="SINGLE_CHOICE">Single Choice</option>
                          <option value="MULTIPLE_CHOICE">Multiple Choice</option>
                          <option value="YES_NO">Ja / Nein</option>
                        </select>
                        <div className="flex items-center gap-1">
                          <label className="text-xs text-gray-500">Timer (s)</label>
                          <input type="number" value={q.timeLimitSecs ?? ""} min={5} max={120}
                            onChange={(e) => updateQuestion(qi, { timeLimitSecs: e.target.value ? Number(e.target.value) : null })}
                            className="border rounded px-2 py-1 text-xs w-16 focus:outline-none"
                            placeholder="–" />
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-xs text-gray-500">Punkte</label>
                          <input type="number" value={q.points} min={1} max={10000}
                            onChange={(e) => updateQuestion(qi, { points: Number(e.target.value) })}
                            className="border rounded px-2 py-1 text-xs w-16 focus:outline-none" />
                        </div>
                      </div>
                    </div>
                    <button onClick={() => removeQuestion(qi)} className="text-gray-300 hover:text-red-500 text-lg mt-1">×</button>
                  </div>

                  {/* Answers */}
                  <div className="pl-6 space-y-1">
                    {q.answers.map((a, ai) => (
                      <div key={ai} className="flex items-center gap-2">
                        <input type={q.answerType === "MULTIPLE_CHOICE" ? "checkbox" : "radio"}
                          name={`q${qi}-correct`} checked={a.isCorrect}
                          onChange={(e) => {
                            if (q.answerType === "MULTIPLE_CHOICE") {
                              updateAnswer(qi, ai, { isCorrect: e.target.checked });
                            } else {
                              setEditQuestions((prev) => prev.map((pq, pqi) =>
                                pqi !== qi ? pq : {
                                  ...pq,
                                  answers: pq.answers.map((pa, pai) => ({ ...pa, isCorrect: pai === ai })),
                                }
                              ));
                            }
                          }} className="cursor-pointer" />
                        <input value={a.text} onChange={(e) => updateAnswer(qi, ai, { text: e.target.value })}
                          disabled={q.answerType === "YES_NO"}
                          className="flex-1 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:bg-gray-100"
                          placeholder={`Antwort ${ai + 1}`} />
                        {q.answerType !== "YES_NO" && q.answers.length > 2 && (
                          <button onClick={() => removeAnswer(qi, ai)} className="text-gray-300 hover:text-red-500">×</button>
                        )}
                      </div>
                    ))}
                    {q.answerType !== "YES_NO" && q.answers.length < 4 && (
                      <button onClick={() => addAnswer(qi)} className="text-xs text-indigo-600 hover:underline mt-1">
                        + Antwort
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </Layout>
    );
  }

  // ── SESSION START ──
  // ── LOBBY (WAITING ROOM) ──
  if (phase === "lobby") {
    return (
      <Layout reconnecting={!socketConnected}>
        <header className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <h1 className="font-bold">{selectedQuiz?.title}</h1>
            <p className="text-xs text-gray-400">{gameMode === "AUTONOMOUS" ? "Autonomes Spiel" : "Zusammenspiel"} · Warte auf Schüler</p>
          </div>
          {gameMode === "BEAMER" && (
            <div className="flex items-center gap-1.5">
              <button onClick={openBeamer} className="text-xs border border-indigo-300 text-indigo-600 px-3 py-1.5 rounded-lg hover:bg-indigo-50">
                Beamer öffnen ↗
              </button>
              <InfoTooltip
                text="Öffnet die Beamer-Ansicht in einem neuen Tab. Solange dieser Tab offen ist, sehen die Schüler nur die Buzzer-Buttons. Schließt man den Tab, werden Fragen und Antworten direkt auf den Schülergeräten angezeigt."
                position="above"
              />
            </div>
          )}
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <p className="text-xs text-gray-400 uppercase font-medium mb-2">{participants.length} Teilnehmer</p>
          {participants.length === 0 && <p className="text-gray-400 text-sm">Warte auf Schüler...</p>}
          <div className="space-y-1">
            {participants.map((p) => (
              <div key={p.participantId} className="flex items-center gap-2 py-1.5 px-2 bg-gray-50 rounded-lg">
                <span className="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-bold">
                  {p.displayName.charAt(0).toUpperCase()}
                </span>
                <span className="text-sm">{p.displayName}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="px-4 pb-4">
          <button onClick={nextQuestion}
            className="w-full py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors">
            Erste Frage →
          </button>
        </div>
      </Layout>
    );
  }

  // ── ACTIVE SESSION ──
  if (phase === "active") {
    return (
      <Layout reconnecting={!socketConnected} paused={paused}>
        <header className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <p className="text-xs text-gray-400">
              {gameMode === "AUTONOMOUS"
                ? "Quizzl läuft autonom"
                : currentQ ? `Frage ${currentQ.index + 1}/${currentQ.total}` : "Session aktiv"}
            </p>
            {gameMode !== "AUTONOMOUS" && responseCount && (
              <p className="text-sm font-medium">{responseCount.answered}/{responseCount.total} geantwortet</p>
            )}
          </div>
          {gameMode === "BEAMER" && (
            <div className="flex items-center gap-1.5">
              <button onClick={openBeamer} className="text-xs border border-indigo-300 text-indigo-600 px-2 py-1 rounded hover:bg-indigo-50">
                Beamer ↗
              </button>
              <InfoTooltip
                text="Öffnet die Beamer-Ansicht in einem neuen Tab. Solange dieser Tab offen ist, sehen die Schüler nur die Buzzer-Buttons. Schließt man den Tab, werden Fragen und Antworten direkt auf den Schülergeräten angezeigt."
                position="above"
              />
            </div>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {currentQ && gameMode !== "AUTONOMOUS" && (
            <div>
              <p className="font-semibold text-sm leading-snug mb-3">{currentQ.text}</p>

              {/* BEAMER: Antwortoptionen als farbige Kacheln */}
              {gameMode === "BEAMER" && (
                <div className="grid grid-cols-2 gap-2 mb-3">
                  {currentQ.answers.map((a) => {
                    const style = BEAMER_STYLES[a.sortOrder] ?? BEAMER_STYLES[0];
                    const d = distribution?.find((x) => x.answerId === a.id);
                    const isGrayed = revealed && !d?.isCorrect;
                    return (
                      <div
                        key={a.id}
                        className={`rounded-xl p-2.5 transition-colors ${isGrayed ? "bg-gray-200 text-gray-400" : `${style.bg} ${style.text}`} ${revealed && d?.isCorrect ? "ring-2 ring-white ring-offset-1 ring-offset-gray-100" : ""}`}
                      >
                        <span className="text-base leading-none block">{style.symbol}</span>
                        <span className="text-xs leading-tight block mt-1 line-clamp-2">{a.text}</span>
                        {revealed && d && (
                          <span className="text-xs font-bold block mt-1 opacity-90">{d.count} ×</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Response progress */}
              {responseCount && (
                <div className="w-full bg-gray-100 rounded-full h-2 mb-4">
                  <div
                    className="bg-indigo-500 h-2 rounded-full transition-all"
                    style={{ width: `${Math.round((responseCount.answered / Math.max(responseCount.total, 1)) * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Boss state panel */}
          {beamerMode === "BOSS" && bossState && (
            <div className="rounded-xl border border-orange-200 bg-orange-50 px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between text-xs font-semibold text-orange-700">
                <span>Boss-HP: {bossState.hp}/{bossState.maxHp}</span>
                <span>⏱ {formatBossTimer(bossState.timerEnd - nowTick)}</span>
              </div>
              <div className="w-full bg-orange-200 rounded-full h-2">
                <div className="bg-orange-500 h-2 rounded-full transition-all" style={{ width: `${Math.max(0, Math.round((bossState.hp / Math.max(bossState.maxHp, 1)) * 100))}%` }} />
              </div>
              {bossState.ability && bossState.ability !== "NONE" && (
                <p className="text-xs text-orange-600 font-medium">Fähigkeit: {bossState.ability.replace(/_/g, " ")}</p>
              )}
              <p className="text-xs text-orange-500">Falsch: {bossState.wrongCount}/{bossState.threshold} bis Angriff</p>
            </div>
          )}

          {/* Shield state panel */}
          {beamerMode === "TEAM_SHIELD" && shieldState && (
            <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-3 py-2.5 space-y-1.5">
              {shieldState.teams.map((t) => (
                <div key={t.name}>
                  <div className="flex items-center justify-between text-xs font-semibold mb-0.5" style={{ color: t.name === "Team Grün" ? "#15803d" : "#c2410c" }}>
                    <span>{t.name}</span><span>{t.hp}/{t.maxHp}</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div className="h-1.5 rounded-full transition-all" style={{ width: `${Math.max(0, Math.round((t.hp / Math.max(t.maxHp, 1)) * 100))}%`, backgroundColor: t.name === "Team Grün" ? "#22c55e" : "#f97316" }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Top scores after reveal */}
          {revealed && topScores.length > 0 && (
            <div>
              <p className="text-xs text-gray-400 uppercase font-medium mb-2">Top 5</p>
              <div className="space-y-1">
                {topScores.slice(0, 5).map((s) => (
                  <div key={s.rank} className="flex items-center gap-2 text-sm">
                    <span className="text-gray-400 w-4">{s.rank}.</span>
                    <span className="flex-1">{s.displayName}</span>
                    <span className="font-semibold">{s.score}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Question analytics panel */}
          {questionStats.length > 0 && (
            <div>
              <button
                onClick={() => setShowQuestionStats((v) => !v)}
                className="flex items-center justify-between w-full text-xs text-gray-400 uppercase font-medium mb-2"
              >
                <span>Fragen ({questionStats.length})</span>
                <span>{showQuestionStats ? "▲" : "▼"}</span>
              </button>
              {showQuestionStats && (
                <div className="space-y-0.5">
                  {questionStats.map((qs) => {
                    const isExpanded = expandedQuestion === qs.questionIndex;
                    const correctPct = qs.answeredCount > 0
                      ? Math.round((qs.correctCount / qs.answeredCount) * 100)
                      : 0;
                    const unanswered = qs.totalPlayed - qs.answeredCount;
                    return (
                      <div key={qs.questionIndex}>
                        <button
                          onClick={() => setExpandedQuestion(isExpanded ? null : qs.questionIndex)}
                          className="flex items-center gap-2 w-full px-2 py-1.5 bg-gray-50 rounded-lg text-left hover:bg-gray-100"
                        >
                          <span className="text-xs text-indigo-500 font-semibold w-5 shrink-0">F{qs.questionIndex + 1}</span>
                          <span className="flex-1 text-xs truncate text-gray-600">{qs.text}</span>
                          <span className="text-xs text-emerald-600 font-medium shrink-0">{qs.correctCount}✓</span>
                          <span className="text-xs text-red-400 mr-1 shrink-0">{qs.answeredCount - qs.correctCount}✗</span>
                          <span className="text-gray-300 text-xs">{isExpanded ? "▲" : "▼"}</span>
                        </button>
                        {isExpanded && (
                          <div className="pl-6 py-1.5 space-y-1.5">
                            <div className="flex gap-3 text-xs text-gray-500">
                              <span>{qs.answeredCount}/{qs.totalPlayed} geantwortet</span>
                              <span className="text-emerald-600 font-medium">{correctPct}% richtig</span>
                              {unanswered > 0 && <span className="text-gray-400">{unanswered}× keine Antwort</span>}
                            </div>
                            {/* Correct rate bar */}
                            <div className="w-full bg-gray-100 rounded-full h-1.5">
                              <div
                                className="bg-emerald-500 h-1.5 rounded-full transition-all"
                                style={{ width: `${correctPct}%` }}
                              />
                            </div>
                            {qs.topWrongAnswers.length > 0 && (
                              <div className="space-y-0.5">
                                <p className="text-xs text-gray-400 font-medium">Häufigste Fehlantworten:</p>
                                {qs.topWrongAnswers.map((wa, i) => (
                                  <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                                    <span className="shrink-0 text-red-400 font-bold w-5 text-right">{wa.count}×</span>
                                    <span className="flex-1 truncate text-gray-600">{wa.text}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {qs.correctCount === qs.answeredCount && qs.answeredCount > 0 && (
                              <p className="text-xs text-emerald-500 font-medium">Alle richtig!</p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Player analytics panel */}
          {playerStats.length > 0 && (
            <div>
              <button
                onClick={() => setShowStats((v) => !v)}
                className="flex items-center justify-between w-full text-xs text-gray-400 uppercase font-medium mb-2"
              >
                <span>Spieler ({playerStats.filter((p) => p.answeredCurrentQuestion).length}/{playerStats.length})</span>
                <span>{showStats ? "▲" : "▼"}</span>
              </button>
              {showStats && (
                <div className="space-y-0.5">
                  {playerStats.map((p) => {
                    const isExpanded = expandedPlayer === p.participantId;
                    return (
                      <div key={p.participantId}>
                        <button
                          onClick={() => setExpandedPlayer(isExpanded ? null : p.participantId)}
                          className="flex items-center gap-2 w-full px-2 py-1.5 bg-gray-50 rounded-lg text-left hover:bg-gray-100"
                        >
                          {gameMode === "AUTONOMOUS" ? (
                            <span className="text-xs text-indigo-500 font-semibold w-8 shrink-0">
                              F{p.currentQuestionIndex + 1}
                            </span>
                          ) : (
                            <span className={`text-xs w-4 shrink-0 ${p.answeredCurrentQuestion ? "text-emerald-500" : "text-gray-300"}`}>
                              {p.answeredCurrentQuestion ? "✓" : "–"}
                            </span>
                          )}
                          <span className="flex-1 text-sm truncate">{p.displayName}</span>
                          <span className="text-xs text-emerald-600 font-medium">{p.correctCount}✓</span>
                          <span className="text-xs text-red-400 mr-1">{p.wrongCount}✗</span>
                          <span className="text-gray-300 text-xs">{isExpanded ? "▲" : "▼"}</span>
                        </button>
                        {isExpanded && (
                          <div className="pl-6 py-1 space-y-0.5">
                            {p.history.length === 0 && (
                              <p className="text-xs text-gray-300 py-1">Noch keine Antworten</p>
                            )}
                            {p.history.map((rec) => {
                              const qDef = quizData?.questions[rec.questionIndex];
                              const answerLabels = rec.answerIds.map((id) => {
                                const a = qDef?.answers.find((a) => a.id === id);
                                return a ? a.text : "?";
                              }).join(", ");
                              return (
                                <div key={rec.absoluteIndex} className="flex items-center gap-2 text-xs text-gray-500 py-0.5">
                                  <span className="shrink-0 text-gray-300 w-5">F{rec.questionIndex + 1}</span>
                                  <span className="flex-1 truncate text-gray-600">{answerLabels || "–"}</span>
                                  <span className={`shrink-0 font-semibold ${rec.isCorrect === true ? "text-emerald-500" : rec.isCorrect === false ? "text-red-400" : "text-gray-300"}`}>
                                    {rec.isCorrect === true ? "✓" : rec.isCorrect === false ? "✗" : "?"}
                                  </span>
                                  {rec.timeTakenSecs !== null && (
                                    <span className="shrink-0 text-gray-300">{rec.timeTakenSecs.toFixed(1)}s</span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-4 pb-4 flex flex-col gap-2">
          {gameMode === "BEAMER" ? (
            <>
              {!revealed ? (
                speedMode === "BLITZ" && !answersVisible ? (
                  <button onClick={showAnswers} className="w-full py-2.5 bg-violet-600 text-white font-semibold rounded-xl hover:bg-violet-700 transition-colors">
                    Antworten zeigen
                  </button>
                ) : (
                  <button onClick={revealAnswer} className="w-full py-2.5 bg-orange-500 text-white font-semibold rounded-xl hover:bg-orange-600 transition-colors">
                    Antwort aufdecken
                  </button>
                )
              ) : pendingEnd ? (
                <button onClick={() => { cancelAutoCountdown(); nextQuestion(); }} disabled={animLocked} className="w-full py-2.5 bg-emerald-600 text-white font-semibold rounded-xl hover:bg-emerald-700 disabled:opacity-40 transition-colors">
                  {autoCountdown !== null ? `Ergebnis in ${autoCountdown}… →` : "Ergebnis anzeigen →"}
                </button>
              ) : (
                <button onClick={() => { cancelAutoCountdown(); nextQuestion(); }} disabled={animLocked} className="w-full py-2.5 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-40 transition-colors">
                  {autoCountdown !== null ? `Nächste Frage in ${autoCountdown}… →` : "Nächste Frage →"}
                </button>
              )}
              <div className="flex items-center gap-2 mt-1">
                <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-semibold">
                  <button
                    onClick={() => { setAutoAdvance(false); cancelAutoCountdown(); }}
                    className={`px-3 py-1.5 transition-colors ${!autoAdvance ? "bg-gray-800 text-white" : "text-gray-400 hover:text-gray-600"}`}
                  >Manuell</button>
                  <button
                    onClick={() => setAutoAdvance(true)}
                    className={`px-3 py-1.5 transition-colors ${autoAdvance ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-gray-600"}`}
                  >Auto</button>
                </div>
                <label className="flex items-center gap-1 text-xs text-gray-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={rememberSetting}
                    onChange={(e) => setRememberSetting(e.target.checked)}
                    className="rounded"
                  />
                  merken
                </label>
              </div>
            </>
          ) : (
            <p className="text-center text-xs text-gray-400 py-1">Quizzl läuft automatisch</p>
          )}
          <button onClick={endSession} className="w-full py-2 text-red-500 text-sm hover:bg-red-50 rounded-xl transition-colors">
            Session beenden
          </button>
        </div>
      </Layout>
    );
  }

  // ── ENDED ──
  if (phase === "ended") {
    const allQuizzes = [...ownQuizzes, ...publicQuizzes.filter((q) => !ownQuizzes.find((o) => o.id === q.id))];
    const canStartNext = nextQuizId !== null;
    const startNextGame = () => {
      if (!nextQuizId) return;
      window.parent.postMessage({
        type: "RESTART_WITH_CONFIG",
        config: {
          quizId: nextQuizId,
          gameMode: "BEAMER",
          beamerMode: nextBeamerMode,
          speedMode: nextSpeedMode,
          ...(nextBeamerMode === "BOSS" ? { bossTimerSeconds: nextBossTimerMins * 60 } : {}),
        },
      }, "*");
    };
    return (
      <Layout>
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <h2 className="text-xl font-bold text-center">Quizzl beendet!</h2>
          {topScores.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-gray-400 uppercase font-medium">Endstand</p>
              {topScores.map((s) => (
                <div key={s.rank} className={`flex items-center gap-3 px-3 py-2 rounded-xl ${s.rank === 1 ? "bg-yellow-50 border border-yellow-200" : "bg-gray-50"}`}>
                  <span className="text-gray-400 w-5 text-sm">{s.rank}.</span>
                  <span className="flex-1 font-medium text-sm">{s.displayName}</span>
                  <span className="font-bold text-sm">{s.score}</span>
                </div>
              ))}
            </div>
          )}

          {gameMode === "BEAMER" && <div className="border-t pt-4 space-y-3">
            <p className="text-xs text-gray-500 uppercase font-medium">Neues Spiel starten</p>

            {/* Quiz picker */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Quiz auswählen</label>
              <select
                value={nextQuizId ?? ""}
                onChange={(e) => setNextQuizId(e.target.value || null)}
                className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">— Quiz wählen —</option>
                {ownQuizzes.length > 0 && (
                  <optgroup label="Meine Quizzls">
                    {ownQuizzes.map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
                  </optgroup>
                )}
                {publicQuizzes.filter((q) => !ownQuizzes.find((o) => o.id === q.id)).length > 0 && (
                  <optgroup label="Öffentlich">
                    {publicQuizzes.filter((q) => !ownQuizzes.find((o) => o.id === q.id)).map((q) => <option key={q.id} value={q.id}>{q.title}</option>)}
                  </optgroup>
                )}
              </select>
            </div>

            {/* Beamer mode */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Modus</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(["STANDARD", "TEAM_SHIELD", "BOSS"] as BeamerMode[]).map((m) => (
                  <button key={m} onClick={() => setNextBeamerMode(m)}
                    className={`py-1.5 rounded-lg text-xs font-semibold border transition-colors ${nextBeamerMode === m ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"}`}>
                    {m === "STANDARD" ? "Standard" : m === "TEAM_SHIELD" ? "Schild" : "Boss"}
                  </button>
                ))}
              </div>
            </div>

            {/* Speed mode */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Geschwindigkeit</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(["NORMAL", "BLITZ", "SUPER_BLITZ"] as SpeedMode[]).map((s) => (
                  <button key={s} onClick={() => setNextSpeedMode(s)}
                    className={`py-1.5 rounded-lg text-xs font-semibold border transition-colors ${nextSpeedMode === s ? "bg-violet-600 text-white border-violet-600" : "bg-white text-gray-600 border-gray-200 hover:border-violet-300"}`}>
                    {s === "NORMAL" ? "Normal" : s === "BLITZ" ? "Blitz" : "Super Blitz"}
                  </button>
                ))}
              </div>
            </div>

            {/* Boss timer (only for BOSS mode) */}
            {nextBeamerMode === "BOSS" && (
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-500 shrink-0">Boss-Timer (Min.)</label>
                <input type="number" min={5} max={60} value={nextBossTimerMins}
                  onChange={(e) => setNextBossTimerMins(Math.max(5, Math.min(60, Number(e.target.value))))}
                  className="w-16 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400" />
              </div>
            )}
          </div>}
        </div>

        {gameMode === "BEAMER" && (
          <div className="px-4 pb-4 pt-2 border-t">
            <button
              onClick={startNextGame}
              disabled={!canStartNext}
              className="w-full py-2.5 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              ▶ Neues Spiel starten
            </button>
          </div>
        )}
      </Layout>
    );
  }

  return null;
}

// ─── Shared layout ────────────────────────────────────────────────────────────

function Layout({ children, reconnecting, paused }: { children: React.ReactNode; reconnecting?: boolean; paused?: boolean }) {
  return (
    <div className="relative flex flex-col h-screen max-h-screen bg-white text-gray-900 overflow-hidden">
      {reconnecting && (
        <div className="absolute top-0 inset-x-0 z-50 flex items-center justify-center gap-2 bg-amber-500 py-1.5 text-xs font-semibold text-white">
          <div className="w-3 h-3 border-2 border-white/50 border-t-white rounded-full animate-spin" />
          Verbindung unterbrochen – wird neu verbunden…
        </div>
      )}
      {paused && (
        <div className="absolute top-0 inset-x-0 z-40 flex items-center justify-center gap-2 bg-indigo-600 py-1.5 text-xs font-semibold text-white">
          ⏸ Pausiert
        </div>
      )}
      <div className="px-4 pt-3 pb-1 shrink-0">
        <img src="/quizzl_logo.png" alt="Quizzl" className="h-9 w-auto select-none" draggable={false} />
      </div>
      {children}
    </div>
  );
}

function Spinner() {
  return <div className="w-8 h-8 border-4 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />;
}

function visLabel(v: string) {
  return v === "PRIVATE" ? "Privat" : v === "SCHOOL" ? "Schule" : "Öffentlich";
}

function formatBossTimer(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
