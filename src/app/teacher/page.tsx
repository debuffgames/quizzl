"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useRef, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { io, Socket } from "socket.io-client";
import { QUIZ_EVENTS } from "@/lib/socket/events";

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuizSummary {
  id: string; title: string; description: string | null; visibility: string;
  _count: { questions: number };
}

interface AnswerInput { text: string; isCorrect: boolean; sortOrder: number; }
interface QuestionInput {
  id?: string; text: string; answerType: "SINGLE_CHOICE" | "MULTIPLE_CHOICE" | "YES_NO";
  timeLimitSecs: number | null; points: number; answers: AnswerInput[];
}
interface AnswerData { id: string; text: string; isCorrect: boolean; sortOrder: number; }
interface QuestionData {
  id: string; text: string; answerType: string; timeLimitSecs: number | null; points: number;
  answers: AnswerData[];
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
type Phase =
  | "loading" | "error"
  | "quiz-list" | "quiz-editor"
  | "lobby"
  | "active" | "ended";

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
  const [topScores, setTopScores] = useState<TopScore[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const fetchQuizzes = useCallback(async () => {
    const [own, pub] = await Promise.all([
      fetch("/api/quizzes?scope=own", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/quizzes?scope=public", { credentials: "include" }).then((r) => r.json()),
    ]);
    setOwnQuizzes(Array.isArray(own) ? own : []);
    setPublicQuizzes(Array.isArray(pub) ? pub : []);
  }, []);

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

      // Check for existing active session
      const activeRes = await fetch(`/api/sessions/active?lobbyId=${encodeURIComponent(lobbyId)}`, { credentials: "include" });
      const activeSession = await activeRes.json();

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

  const connectSocket = useCallback((sid: string, initialPhase: "lobby" | "active") => {
    if (socketRef.current) socketRef.current.disconnect();
    sessionIdRef.current = sid;

    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL || window.location.origin;
    const socket = io(socketUrl, { withCredentials: true });
    socketRef.current = socket;

    socket.on("connect", () => {
      socket.emit("quiz:teacherJoin", { lobbyId, token }, (ack: { ok: boolean; sessionId?: string; gameMode?: string; error?: string }) => {
        if (!ack.ok) { setError(ack.error ?? "Socket-Verbindung fehlgeschlagen"); setPhase("error"); return; }
        if (ack.gameMode === "BEAMER" || ack.gameMode === "AUTONOMOUS") setGameMode(ack.gameMode);
        setPhase(initialPhase);
      });
    });

    socket.on("connect_error", () => { setError("Verbindung zum Server fehlgeschlagen"); setPhase("error"); });

    socket.on(QUIZ_EVENTS.PLAYER_JOINED, (p: Participant) => setParticipants((prev) => [...prev.filter((x) => x.participantId !== p.participantId), p]));
    socket.on(QUIZ_EVENTS.PLAYER_LEFT, ({ participantId }: { participantId: string }) => setParticipants((prev) => prev.filter((x) => x.participantId !== participantId)));

    socket.on(QUIZ_EVENTS.QUESTION, (data: SocketQuestion) => {
      setCurrentQ(data);
      setDistribution(null);
      setResponseCount({ answered: 0, total: participants.length });
      setRevealed(false);
      setPhase("active");
    });

    socket.on(QUIZ_EVENTS.RESPONSE_COUNT, (data: { answered: number; total: number }) => setResponseCount(data));
    socket.on(QUIZ_EVENTS.ANSWER_DIST, ({ distribution: d }: { distribution: AnswerDist[] }) => { setDistribution(d); setRevealed(true); });

    socket.on(QUIZ_EVENTS.SCOREBOARD, ({ topN }: { topN: TopScore[] }) => setTopScores(topN));
    socket.on(QUIZ_EVENTS.END, ({ topScores: ts }: { topScores: TopScore[] }) => {
      if (ts) setTopScores(ts);
      setPhase("ended");
    });
  }, [lobbyId, token, participants.length]);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const nextQuestion = () => socketRef.current?.emit(QUIZ_EVENTS.NEXT_QUESTION);
  const revealAnswer = () => socketRef.current?.emit(QUIZ_EVENTS.REVEAL_ANSWER);
  const endSession = () => {
    if (confirm("Session wirklich beenden?")) {
      socketRef.current?.emit(QUIZ_EVENTS.END_SESSION);
    }
  };

  const openBeamer = () => {
    if (!sessionId) return;
    window.open(`/beamer/${sessionId}?token=${encodeURIComponent(token)}`, "_blank");
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
        timeLimitSecs: q.timeLimitSecs, points: q.points,
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
          body: JSON.stringify({ title: editTitle, description: editDesc || null, visibility: editVisibility }),
          credentials: "include",
        });
        const data = await res.json();
        quizId = data.id;
      } else {
        await fetch(`/api/quizzes/${quizId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: editTitle, description: editDesc || null, visibility: editVisibility }),
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
        timeLimitSecs: 30,
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
    setEditQuestions((prev) => prev.map((q, idx) => idx === i ? { ...q, ...patch } : q));

  const updateAnswer = (qi: number, ai: number, patch: Partial<AnswerInput>) =>
    setEditQuestions((prev) => prev.map((q, idx) =>
      idx !== qi ? q : { ...q, answers: q.answers.map((a, aidx) => aidx === ai ? { ...a, ...patch } : a) }
    ));

  const addAnswer = (qi: number) =>
    setEditQuestions((prev) => prev.map((q, idx) =>
      idx !== qi ? q : { ...q, answers: [...q.answers, { text: "", isCorrect: false, sortOrder: q.answers.length }] }
    ));

  const removeAnswer = (qi: number, ai: number) =>
    setEditQuestions((prev) => prev.map((q, idx) =>
      idx !== qi ? q : { ...q, answers: q.answers.filter((_, aidx) => aidx !== ai) }
    ));

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
            ? <img src="/quizl_edo.png" alt="Quizzl" className="h-12 w-auto object-contain" />
            : <h1 className="font-bold text-lg">Quizzl</h1>
          }
          <button onClick={() => openEditor(null)} className="text-sm bg-indigo-600 text-white px-3 py-1.5 rounded-lg hover:bg-indigo-700">
            + Neu
          </button>
        </header>
        <div className="flex border-b">
          {(["own", "public"] as const).map((t) => (
            <button key={t} onClick={() => setListTab(t)}
              className={`flex-1 py-2 text-sm font-medium border-b-2 transition-colors ${listTab === t ? "border-indigo-600 text-indigo-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              {t === "own" ? "Meine Quizze" : "Entdecken"}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto divide-y">
          {list.length === 0 && (
            <p className="text-gray-400 text-sm text-center py-12">
              {listTab === "own" ? "Noch keine Quizze. Erstelle dein erstes Quiz!" : "Keine öffentlichen Quizze gefunden."}
            </p>
          )}
          {list.map((q) => (
            <div key={q.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{q.title}</p>
                <p className="text-xs text-gray-400">{q._count.questions} Fragen · {visLabel(q.visibility)}</p>
              </div>
              <div className="flex gap-2 shrink-0">
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
      </Layout>
    );
  }

  // ── QUIZ EDITOR ──
  if (phase === "quiz-editor") {
    return (
      <Layout>
        <header className="flex items-center gap-3 px-4 py-3 border-b">
          <button onClick={() => setPhase("quiz-list")} className="text-gray-500 hover:text-gray-800">←</button>
          <h1 className="font-bold text-lg flex-1">{editingQuiz ? "Quiz bearbeiten" : "Neues Quiz"}</h1>
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
                placeholder="Quiz-Titel" />
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
      <Layout>
        <header className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <h1 className="font-bold">{selectedQuiz?.title}</h1>
            <p className="text-xs text-gray-400">{gameMode === "AUTONOMOUS" ? "Autonom" : "Beamer"} · Warte auf Schüler</p>
          </div>
          {gameMode === "BEAMER" && (
            <button onClick={openBeamer} className="text-xs border border-indigo-300 text-indigo-600 px-3 py-1.5 rounded-lg hover:bg-indigo-50">
              Beamer öffnen ↗
            </button>
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
    const maxCount = distribution ? Math.max(...distribution.map((d) => d.count), 1) : 1;
    return (
      <Layout>
        <header className="flex items-center justify-between px-4 py-3 border-b">
          <div>
            <p className="text-xs text-gray-400">
              {currentQ ? `Frage ${currentQ.index + 1}/${currentQ.total}` : "Session aktiv"}
            </p>
            {responseCount && (
              <p className="text-sm font-medium">{responseCount.answered}/{responseCount.total} geantwortet</p>
            )}
          </div>
          {gameMode === "BEAMER" && (
            <button onClick={openBeamer} className="text-xs border border-indigo-300 text-indigo-600 px-2 py-1 rounded hover:bg-indigo-50">
              Beamer ↗
            </button>
          )}
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {currentQ && (
            <div>
              <p className="font-semibold text-sm leading-snug mb-3">{currentQ.text}</p>
              {/* Response progress */}
              {responseCount && (
                <div className="w-full bg-gray-100 rounded-full h-2 mb-4">
                  <div
                    className="bg-indigo-500 h-2 rounded-full transition-all"
                    style={{ width: `${Math.round((responseCount.answered / Math.max(responseCount.total, 1)) * 100)}%` }}
                  />
                </div>
              )}
              {/* Answer distribution */}
              {distribution && (
                <div className="space-y-2">
                  {currentQ.answers.map((a) => {
                    const d = distribution.find((x) => x.answerId === a.id);
                    const count = d?.count ?? 0;
                    const pct = Math.round((count / maxCount) * 100);
                    return (
                      <div key={a.id} className={`rounded-lg overflow-hidden border ${d?.isCorrect ? "border-green-300" : "border-gray-200"}`}>
                        <div className="relative h-8 bg-gray-50">
                          <div
                            className={`absolute left-0 top-0 h-full transition-all duration-500 ${d?.isCorrect ? "bg-green-100" : "bg-gray-100"}`}
                            style={{ width: revealed ? `${pct}%` : "0%" }}
                          />
                          <div className="relative flex items-center h-full px-3 gap-2">
                            <span className="text-xs flex-1 truncate">{a.text}</span>
                            {revealed && <span className="text-xs font-semibold text-gray-600">{count}</span>}
                            {d?.isCorrect && <span className="text-green-600 text-xs">✓</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
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
        </div>

        <div className="px-4 pb-4 flex flex-col gap-2">
          {gameMode === "BEAMER" ? (
            <>
              {!revealed ? (
                <button onClick={revealAnswer} className="w-full py-2.5 bg-orange-500 text-white font-semibold rounded-xl hover:bg-orange-600 transition-colors">
                  Antwort aufdecken
                </button>
              ) : (
                <button onClick={nextQuestion} className="w-full py-2.5 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors">
                  Nächste Frage →
                </button>
              )}
            </>
          ) : (
            <p className="text-center text-xs text-gray-400 py-1">Quiz läuft automatisch</p>
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
    return (
      <Layout>
        <div className="flex-1 flex flex-col items-center justify-center px-6 gap-4">
          <h2 className="text-2xl font-bold">Quiz beendet!</h2>
          {topScores.length > 0 && (
            <div className="w-full max-w-sm space-y-2">
              <p className="text-xs text-gray-400 uppercase font-medium text-center mb-2">Endstand</p>
              {topScores.map((s) => (
                <div key={s.rank} className={`flex items-center gap-3 px-4 py-2 rounded-xl ${s.rank === 1 ? "bg-yellow-50 border border-yellow-200" : "bg-gray-50"}`}>
                  <span className="text-gray-400 w-5 text-sm">{s.rank}.</span>
                  <span className="flex-1 font-medium">{s.displayName}</span>
                  <span className="font-bold">{s.score}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Layout>
    );
  }

  return null;
}

// ─── Shared layout ────────────────────────────────────────────────────────────

function Layout({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col h-screen max-h-screen bg-white text-gray-900 overflow-hidden">{children}</div>;
}

function Spinner() {
  return <div className="w-8 h-8 border-4 border-indigo-300 border-t-indigo-600 rounded-full animate-spin" />;
}

function visLabel(v: string) {
  return v === "PRIVATE" ? "Privat" : v === "SCHOOL" ? "Schule" : "Öffentlich";
}
