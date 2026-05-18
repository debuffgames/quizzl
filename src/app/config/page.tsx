"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface QuizSummary {
  id: string;
  title: string;
  _count: { questions: number };
}

type GameMode = "AUTONOMOUS" | "BEAMER";

export default function ConfigPage() {
  return <Suspense><ConfigContent /></Suspense>;
}

function ConfigContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [quizId, setQuizId] = useState("");
  const [gameMode, setGameMode] = useState<GameMode>("AUTONOMOUS");
  // Auth + load quizzes
  useEffect(() => {
    if (!token) { setLoading(false); return; }
    fetch("/api/auth/module-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      credentials: "include",
    }).then(async (res) => {
      if (!res.ok) { setLoading(false); return; }
      const data = await fetch("/api/quizzes?scope=own", { credentials: "include" }).then(r => r.json());
      setQuizzes(Array.isArray(data) ? data : []);
      setLoading(false);
      window.parent.postMessage({ type: "CONFIG_READY" }, "*");
    }).catch(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Receive CONFIG_INIT from hub
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type !== "CONFIG_INIT") return;
      if (e.data.config?.quizId) setQuizId(e.data.config.quizId);
      if (e.data.config?.gameMode === "BEAMER" || e.data.config?.gameMode === "AUTONOMOUS") {
        setGameMode(e.data.config.gameMode);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const emit = useCallback((newQuizId: string, newMode: GameMode) => {
    window.parent.postMessage({ type: "CONFIG_CHANGED", config: { quizId: newQuizId, gameMode: newMode } }, "*");
  }, []);

  const handleQuizChange = (id: string) => {
    setQuizId(id);
    emit(id, gameMode);
  };

  const handleModeChange = (m: GameMode) => {
    setGameMode(m);
    emit(quizId, m);
  };

  const openEditor = () => {
    window.parent.postMessage({ type: "OPEN_EDITOR" }, "*");
  };

  return (
    <div className="flex flex-col gap-3 p-3 text-sm bg-white h-full">
      {/* Quiz dropdown */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Quiz</label>
        {loading ? (
          <div className="h-9 rounded-lg bg-gray-100 animate-pulse" />
        ) : (
          <select
            value={quizId}
            onChange={(e) => handleQuizChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="">– Quiz auswählen –</option>
            {quizzes.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title} ({q._count.questions} Fragen)
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Game mode toggle */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Spielmodus</label>
        <div className="flex gap-2">
          {(["AUTONOMOUS", "BEAMER"] as const).map((m) => (
            <button
              key={m}
              onClick={() => handleModeChange(m)}
              className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                gameMode === m
                  ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                  : "border-gray-200 text-gray-500 hover:border-gray-400"
              }`}
            >
              {m === "AUTONOMOUS" ? "Autonom" : "Beamer"}
            </button>
          ))}
        </div>
      </div>

      {/* Edit button */}
      <button
        onClick={openEditor}
        className="w-full rounded-lg border border-gray-200 py-1.5 text-xs font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
      >
        ✏ Quiz erstellen / bearbeiten ↗
      </button>
    </div>
  );
}
