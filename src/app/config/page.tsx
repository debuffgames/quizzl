"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface QuizSummary {
  id: string;
  title: string;
  _count: { questions: number };
}

type GameMode = "AUTONOMOUS" | "BEAMER";
type BeamerMode = "STANDARD" | "TEAM_SHIELD" | "BOSS";
type SpeedMode = "NORMAL" | "BLITZ" | "SUPER_BLITZ";

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
  const [beamerMode, setBeamerMode] = useState<BeamerMode>("STANDARD");
  const [speedMode, setSpeedMode] = useState<SpeedMode>("NORMAL");
  const [bossTimerMinutes, setBossTimerMinutes] = useState(15);

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
      const c = e.data.config ?? {};
      if (c.quizId) setQuizId(c.quizId);
      if (c.gameMode === "BEAMER" || c.gameMode === "AUTONOMOUS") setGameMode(c.gameMode);
      if (["STANDARD", "TEAM_SHIELD", "BOSS"].includes(c.beamerMode)) setBeamerMode(c.beamerMode);
      if (["NORMAL", "BLITZ", "SUPER_BLITZ"].includes(c.speedMode)) setSpeedMode(c.speedMode);
      if (typeof c.bossTimerSeconds === "number") setBossTimerMinutes(Math.round(c.bossTimerSeconds / 60));
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const emitConfig = useCallback((
    qId: string, gm: GameMode, bm: BeamerMode, sm: SpeedMode, bossMin: number,
  ) => {
    window.parent.postMessage({
      type: "CONFIG_CHANGED",
      config: {
        quizId: qId,
        gameMode: gm,
        beamerMode: bm,
        speedMode: sm,
        bossTimerSeconds: bossMin * 60,
      },
    }, "*");
  }, []);

  const handleQuizChange = (id: string) => {
    setQuizId(id);
    emitConfig(id, gameMode, beamerMode, speedMode, bossTimerMinutes);
  };
  const handleGameModeChange = (m: GameMode) => {
    setGameMode(m);
    emitConfig(quizId, m, beamerMode, speedMode, bossTimerMinutes);
  };
  const handleBeamerModeChange = (m: BeamerMode) => {
    setBeamerMode(m);
    emitConfig(quizId, gameMode, m, speedMode, bossTimerMinutes);
  };
  const handleSpeedModeChange = (m: SpeedMode) => {
    setSpeedMode(m);
    emitConfig(quizId, gameMode, beamerMode, m, bossTimerMinutes);
  };
  const handleBossTimerChange = (min: number) => {
    const clamped = Math.max(1, Math.min(60, min));
    setBossTimerMinutes(clamped);
    emitConfig(quizId, gameMode, beamerMode, speedMode, clamped);
  };

  const openEditor = () => window.parent.postMessage({ type: "OPEN_EDITOR" }, "*");

  const BEAMER_MODES: { value: BeamerMode; label: string }[] = [
    { value: "STANDARD", label: "Standard" },
    { value: "TEAM_SHIELD", label: "Team-Schild" },
    { value: "BOSS", label: "Bosskampf" },
  ];
  const SPEED_MODES: { value: SpeedMode; label: string; hint: string }[] = [
    { value: "NORMAL", label: "Normal", hint: "Volle Punkte" },
    { value: "BLITZ", label: "Blitz", hint: "Antworten erst nach Klick, Punkte sinken" },
    { value: "SUPER_BLITZ", label: "Super Blitz", hint: "Punkte sinken sofort" },
  ];

  return (
    <div className="flex flex-col gap-3 p-3 text-sm bg-white h-full">
      {/* Quiz dropdown */}
      <div>
        <label className="block text-xs font-medium text-gray-500 mb-1">Quizzl</label>
        {loading ? (
          <div className="h-9 rounded-lg bg-gray-100 animate-pulse" />
        ) : (
          <select
            value={quizId}
            onChange={(e) => handleQuizChange(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            <option value="">– Quizzl auswählen –</option>
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
              onClick={() => handleGameModeChange(m)}
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

      {/* Beamer sub-mode (only when BEAMER selected) */}
      {gameMode === "BEAMER" && (
        <>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Modus</label>
            <div className="flex gap-1.5">
              {BEAMER_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => handleBeamerModeChange(m.value)}
                  className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                    beamerMode === m.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 text-gray-500 hover:border-gray-400"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Geschwindigkeit</label>
            <div className="flex gap-1.5">
              {SPEED_MODES.map((m) => (
                <button
                  key={m.value}
                  title={m.hint}
                  onClick={() => handleSpeedModeChange(m.value)}
                  className={`flex-1 rounded-lg border py-1.5 text-xs font-medium transition-colors ${
                    speedMode === m.value
                      ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                      : "border-gray-200 text-gray-500 hover:border-gray-400"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Boss timer — only for Boss mode */}
          {beamerMode === "BOSS" && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">
                Bosskampf-Timer (Minuten)
              </label>
              <input
                type="number"
                min={1}
                max={60}
                value={bossTimerMinutes}
                onChange={(e) => handleBossTimerChange(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>
          )}
        </>
      )}

      {/* Edit button */}
      <button
        onClick={openEditor}
        className="w-full rounded-lg border border-gray-200 py-1.5 text-xs font-medium text-gray-500 hover:border-gray-400 hover:text-gray-700 transition-colors"
      >
        ✏ Quizzl erstellen / bearbeiten ↗
      </button>
    </div>
  );
}
