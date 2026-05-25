import type { Server, Socket } from "socket.io";
import { prisma } from "../../src/lib/db/prisma";
import { QUIZ_EVENTS, type BossAbility } from "../../src/lib/socket/events";
import type { SessionManager, LiveSession, LiveParticipant } from "../sessionManager";

export function registerQuizHandlers(io: Server, socket: Socket, sessionManager: SessionManager) {
  socket.on(QUIZ_EVENTS.NEXT_QUESTION, async () => {
    const sessionId = getTeacherSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;
    if (session.gameMode === "AUTONOMOUS") return;
    await advanceToNextQuestion(io, session, sessionManager);
  });

  socket.on(QUIZ_EVENTS.REVEAL_ANSWER, async () => {
    const sessionId = getTeacherSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;
    if (session.gameMode === "AUTONOMOUS") return;
    if (session.questionTimerHandle) {
      clearTimeout(session.questionTimerHandle);
      session.questionTimerHandle = null;
    }
    await revealAnswer(io, session, sessionManager);
  });

  // BLITZ: teacher reveals answer tiles and starts countdown
  socket.on(QUIZ_EVENTS.SHOW_ANSWERS, () => {
    const sessionId = getTeacherSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;
    if (session.speedMode !== "BLITZ") return;
    if (session.answersVisibleAt !== null) return; // already shown

    session.answersVisibleAt = Date.now();
    const msg = { startsAt: session.answersVisibleAt, timeLimitSecs: session.questionTimerEnd
      ? Math.round((session.questionTimerEnd - Date.now()) / 1000)
      : null };
    io.to(session.sessionId).emit(QUIZ_EVENTS.ANSWERS_VISIBLE, msg);
  });

  // AUTONOMOUS: student finished all questions, report final score
  socket.on(QUIZ_EVENTS.AUTONOMOUS_COMPLETE, ({ totalScore }: { totalScore: number }) => {
    const entry = sessionManager.getParticipantBySocket(socket.id);
    if (!entry || entry.session.gameMode !== "AUTONOMOUS") return;
    const { session, participant } = entry;
    participant.score = totalScore;

    const topScores = sessionManager.getTopScores(session, 10);
    if (session.teacherSocketId) {
      io.to(session.teacherSocketId).emit(QUIZ_EVENTS.SCOREBOARD, { topN: topScores });
    }
    io.to(session.sessionId).emit(QUIZ_EVENTS.SCOREBOARD, { topN: topScores });
  });

  socket.on(QUIZ_EVENTS.END_SESSION, async () => {
    const sessionId = getTeacherSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;

    if (session.questionTimerHandle) {
      clearTimeout(session.questionTimerHandle);
      session.questionTimerHandle = null;
    }

    await endSessionWithResult(io, session, sessionManager, {});
  });
}

// ─── advanceToNextQuestion ────────────────────────────────────────────────────

export async function advanceToNextQuestion(io: Server, session: LiveSession, sessionManager: SessionManager) {
  const quiz = await prisma.quiz.findUnique({
    where: { id: session.quizId },
    include: {
      questions: {
        orderBy: { sortOrder: "asc" },
        include: { answers: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });
  if (!quiz) return;

  const isFirstQuestion = session.currentQuestionIndex === -1;

  let nextIndex = session.currentQuestionIndex + 1;
  if (nextIndex >= quiz.questions.length) {
    if (session.beamerMode !== "STANDARD") {
      nextIndex = 0; // loop for TEAM_SHIELD and BOSS
    } else {
      return; // STANDARD: done
    }
  }

  // Reset per-question participant state
  for (const p of session.participants.values()) {
    p.answeredCurrentQuestion = false;
    p.currentAnswerIds = [];
    p.answeredAt = null;
    p.revealSent = false;
  }

  // One-time init on first question
  if (isFirstQuestion) {
    if (session.beamerMode === "TEAM_SHIELD") {
      const avgPoints = quiz.questions.reduce((s, q) => s + q.points, 0) / quiz.questions.length;
      initTeams(io, session, quiz.questions.length, avgPoints);
    }
    if (session.beamerMode === "BOSS") {
      const avgPoints = quiz.questions.reduce((s, q) => s + q.points, 0) / quiz.questions.length;
      initBoss(session, quiz.questions, avgPoints);
    }

    // Reconnect persistent beamer if one is waiting for this lobby
    const beamerSocketId = sessionManager.getLobbyBeamerSocket(session.lobbyId);
    if (beamerSocketId) {
      const beamerSocket = io.sockets.sockets.get(beamerSocketId);
      if (beamerSocket) {
        beamerSocket.join(session.sessionId);
        beamerSocket.join(`${session.sessionId}:beamer`);
        sessionManager.setBeamerSocket(session.sessionId, beamerSocketId);
        beamerSocket.emit(QUIZ_EVENTS.SESSION_STARTED, {
          beamerMode: session.beamerMode,
          speedMode: session.speedMode,
        });
      }
    }
  }

  const question = quiz.questions[nextIndex];
  session.currentQuestionIndex = nextIndex;

  // Boss ability for this question
  if (session.beamerMode === "BOSS") {
    session.currentBossAbility = pickBossAbility(question.answerType);
    session.hiddenAnswerId = null;
    if (session.currentBossAbility === "HIDDEN_ANSWER") {
      const randomIdx = Math.floor(Math.random() * question.answers.length);
      session.hiddenAnswerId = question.answers[randomIdx].id;
    }
  } else {
    session.currentBossAbility = null;
    session.hiddenAnswerId = null;
  }

  // HALF_TIME ability adjusts the effective timer
  let effectiveTimeLimitSecs = question.timeLimitSecs;
  if (session.currentBossAbility === "HALF_TIME" && effectiveTimeLimitSecs) {
    effectiveTimeLimitSecs = Math.ceil(effectiveTimeLimitSecs / 2);
  }

  session.questionTimerEnd = effectiveTimeLimitSecs
    ? Date.now() + effectiveTimeLimitSecs * 1000
    : null;

  // answersVisibleAt: SUPER_BLITZ = immediately; BLITZ = set by teacher; NORMAL = n/a (always visible)
  session.answersVisibleAt = session.speedMode === "SUPER_BLITZ" ? Date.now() : null;

  await prisma.quizSession.update({
    where: { id: session.sessionId },
    data: {
      currentQuestionIndex: nextIndex,
      status: "ACTIVE",
      startedAt: isFirstQuestion ? new Date() : undefined,
    },
  });

  // Build payloads
  const basePayload = {
    id: question.id,
    text: question.text,
    answerType: question.answerType,
    answers: question.answers.map((a) => ({ id: a.id, text: a.text, sortOrder: a.sortOrder })),
    timeLimitSecs: effectiveTimeLimitSecs,
    explanation: question.explanation ?? null,
    index: nextIndex,
    total: quiz.questions.length,
    speedMode: session.speedMode,
    answersVisibleAt: session.answersVisibleAt, // null=locked (BLITZ); epoch ms=visible now
    bossAbility: session.currentBossAbility,   // null if not BOSS mode
  };

  // Students: no text/answer text; hidden answer stays hidden (they don't need its ID)
  const studentPayload = {
    ...basePayload,
    text: undefined,
    answers: question.answers.map((a) => ({ id: a.id, text: undefined, sortOrder: a.sortOrder })),
    hiddenAnswerId: undefined,
  };

  // Beamer: full text; HIDDEN_ANSWER ability hides the answer text (not ID)
  const beamerPayload = {
    ...basePayload,
    answers: question.answers.map((a) => ({
      id: a.id,
      text: session.hiddenAnswerId === a.id ? null : a.text,
      sortOrder: a.sortOrder,
    })),
    hiddenAnswerId: session.hiddenAnswerId,
  };

  io.to(`${session.sessionId}:students`).emit(QUIZ_EVENTS.QUESTION, studentPayload);
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.QUESTION, beamerPayload);

  const initialCount = { answered: 0, total: session.participants.size };
  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.QUESTION, basePayload);
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.RESPONSE_COUNT, initialCount);
  }
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.RESPONSE_COUNT, initialCount);

  // Push current mode state to beamer + teacher
  if (session.beamerMode === "BOSS") sendBossState(io, session);
  if (session.beamerMode === "TEAM_SHIELD") sendShieldState(io, session);

  // SUPER_BLITZ: notify all that countdown starts now
  if (session.speedMode === "SUPER_BLITZ" && session.answersVisibleAt) {
    const visMsg = { startsAt: session.answersVisibleAt, timeLimitSecs: effectiveTimeLimitSecs };
    io.to(session.sessionId).emit(QUIZ_EVENTS.ANSWERS_VISIBLE, visMsg);
  }

  // Auto-reveal timer
  if (session.questionTimerEnd) {
    const delay = effectiveTimeLimitSecs! * 1000;
    session.questionTimerHandle = setTimeout(async () => {
      const current = sessionManager.getById(session.sessionId);
      if (!current || current.currentQuestionIndex !== nextIndex) return;
      current.questionTimerHandle = null;
      await revealAnswer(io, current, sessionManager);
    }, delay);
  }
}

// ─── revealAnswer ─────────────────────────────────────────────────────────────

async function revealAnswer(io: Server, session: LiveSession, sessionManager: SessionManager) {
  const allQuestions = await prisma.question.findMany({
    where: { quizId: session.quizId },
    orderBy: { sortOrder: "asc" },
    include: { answers: true },
    skip: session.currentQuestionIndex,
    take: 1,
  });
  const q = allQuestions[0];
  if (!q) return;

  const correctIds = q.answers.filter((a) => a.isCorrect).map((a) => a.id);
  let bossAttacked = false;

  for (const p of session.participants.values()) {
    if (!p.answeredCurrentQuestion) {
      // Unanswered = wrong for BOSS counter
      if (session.beamerMode === "BOSS") applyBossWrongAnswer(session);
      const clientSocket = io.sockets.sockets.get(p.socketId);
      if (clientSocket) {
        clientSocket.emit(QUIZ_EVENTS.ANSWER_REVEAL, { correctAnswerIds: correctIds, scoreGained: 0, totalScore: p.score });
      }
      continue;
    }

    const correct =
      q.answerType === "MULTIPLE_CHOICE"
        ? correctIds.every((id) => p.currentAnswerIds.includes(id)) &&
          p.currentAnswerIds.every((id) => correctIds.includes(id))
        : p.currentAnswerIds.length === 1 && correctIds.includes(p.currentAnswerIds[0]);

    let scoreGained = 0;
    if (correct) {
      const damage = calcDamage(session, q, p);
      p.score += damage;
      scoreGained = damage;

      if (session.beamerMode === "TEAM_SHIELD" && p.teamIndex !== null && session.teamShields) {
        const opp = (1 - p.teamIndex) as 0 | 1;
        session.teamShields[opp] = Math.max(0, session.teamShields[opp] - damage);
      }
      if (session.beamerMode === "BOSS" && session.bossHp !== null) {
        session.bossHp = Math.max(0, session.bossHp - damage);
      }
    } else {
      if (session.beamerMode === "BOSS") bossAttacked = applyBossWrongAnswer(session) || bossAttacked;
    }

    const clientSocket = io.sockets.sockets.get(p.socketId);
    if (clientSocket) {
      clientSocket.emit(QUIZ_EVENTS.ANSWER_REVEAL, { correctAnswerIds: correctIds, scoreGained, totalScore: p.score });
    }
  }

  // Distribution + beamer reveal
  const dist = q.answers.map((a) => ({
    answerId: a.id,
    count: Array.from(session.participants.values()).filter((p) => p.currentAnswerIds.includes(a.id)).length,
    isCorrect: a.isCorrect,
  }));
  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.ANSWER_DIST, { distribution: dist });
  }
  const hiddenReveal = session.hiddenAnswerId
    ? (() => { const a = q.answers.find((a) => a.id === session.hiddenAnswerId); return a ? { id: a.id, text: a.text } : undefined; })()
    : undefined;
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.ANSWER_REVEAL, { correctAnswerIds: correctIds, hiddenReveal });

  const topScores = sessionManager.getTopScores(session, 10);
  io.to(session.sessionId).emit(QUIZ_EVENTS.SCOREBOARD, { topN: topScores });

  // Push updated mode state
  if (session.beamerMode === "TEAM_SHIELD") sendShieldState(io, session);
  if (session.beamerMode === "BOSS") sendBossState(io, session);

  // Win/loss conditions
  if (session.beamerMode === "TEAM_SHIELD" && session.teamShields) {
    const loserIdx = session.teamShields.findIndex((hp) => hp <= 0);
    if (loserIdx >= 0) {
      const winner = loserIdx === 0 ? "Team Lila" : "Team Grün";
      await endSessionWithResult(io, session, sessionManager, {
        winner, winType: "shield",
        shieldFinal: [
          { name: "Team Grün", hp: session.teamShields[0], maxHp: session.teamShieldMax ?? 1 },
          { name: "Team Lila", hp: session.teamShields[1], maxHp: session.teamShieldMax ?? 1 },
        ],
      });
      return;
    }
  }

  if (session.beamerMode === "BOSS") {
    if (session.bossHp !== null && session.bossHp <= 0) {
      await endSessionWithResult(io, session, sessionManager, {
        winner: "class", winType: "boss",
        bossTimeRemainingMs: Math.max(0, (session.bossTimerEnd ?? 0) - Date.now()),
        bossTotalMs: (session.bossTimerSeconds ?? 900) * 1000,
      });
      return;
    }
    if (session.bossTimerEnd !== null && Date.now() >= session.bossTimerEnd) {
      await endSessionWithResult(io, session, sessionManager, {
        winner: "boss", winType: "boss",
        bossHpRemaining: session.bossHp ?? 0,
        bossMaxHp: session.bossMaxHp ?? 0,
      });
      return;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcDamage(
  session: LiveSession,
  q: { points: number; timeLimitSecs: number | null },
  p: LiveParticipant,
): number {
  if (session.speedMode === "NORMAL" || !session.answersVisibleAt || !p.answeredAt) {
    return q.points;
  }
  const timeLimitSecs = q.timeLimitSecs ?? 30;
  const elapsed = Math.max(0, (p.answeredAt - session.answersVisibleAt) / 1000);
  return Math.max(0, Math.round(q.points * (1 - elapsed / timeLimitSecs)));
}

function applyBossWrongAnswer(session: LiveSession): boolean {
  if (session.bossWrongCount === null) return false;
  session.bossWrongCount++;
  const threshold = Math.max(1, Math.ceil(session.participants.size / 4));
  if (session.bossWrongCount % threshold === 0 && session.bossTimerEnd !== null) {
    session.bossTimerEnd = Math.max(Date.now(), session.bossTimerEnd - 60_000);
    return true; // attacked
  }
  return false;
}

export function sendBossState(io: Server, session: LiveSession) {
  const state = {
    hp: session.bossHp,
    maxHp: session.bossMaxHp,
    timerEnd: session.bossTimerEnd,
    ability: session.currentBossAbility,
    wrongCount: session.bossWrongCount,
    threshold: Math.max(1, Math.ceil(session.participants.size / 4)),
  };
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.BOSS_STATE, state);
  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.BOSS_STATE, state);
  }
}

export function sendShieldState(io: Server, session: LiveSession) {
  const state = {
    teams: [
      { name: "Team Grün", hp: session.teamShields?.[0] ?? 0, maxHp: session.teamShieldMax ?? 1 },
      { name: "Team Lila", hp: session.teamShields?.[1] ?? 0, maxHp: session.teamShieldMax ?? 1 },
    ],
  };
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.SHIELD_STATE, state);
  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.SHIELD_STATE, state);
  }
}

function initTeams(io: Server, session: LiveSession, totalQuestions: number, avgPoints: number) {
  const ids = Array.from(session.participants.keys());
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const mid = Math.floor(ids.length / 2);
  ids.forEach((id, idx) => {
    const p = session.participants.get(id)!;
    p.teamIndex = idx < mid ? 0 : 1;
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) {
      sock.emit(QUIZ_EVENTS.TEAM_ASSIGNED, {
        teamIndex: p.teamIndex,
        teamName: p.teamIndex === 0 ? "Team Grün" : "Team Lila",
      });
    }
  });
  const teamSize = Math.max(1, mid);
  session.teamShieldMax = Math.max(10, Math.ceil(teamSize * avgPoints * totalQuestions * 0.5));
  session.teamShields = [session.teamShieldMax, session.teamShieldMax];
}

function initBoss(
  session: LiveSession,
  questions: { timeLimitSecs: number | null; points: number }[],
  avgPoints: number,
) {
  const bossTimerSecs = session.bossTimerSeconds ?? 900;
  const avgSecs = questions.reduce((s, q) => s + (q.timeLimitSecs ?? 30), 0) / questions.length;
  const questionsInTime = Math.round(bossTimerSecs / avgSecs);
  session.bossMaxHp = Math.max(10, Math.round(questionsInTime * session.participants.size * avgPoints * 0.5));
  session.bossHp = session.bossMaxHp;
  session.bossTimerEnd = Date.now() + bossTimerSecs * 1000;
  session.bossWrongCount = 0;
}

function pickBossAbility(answerType: string): BossAbility {
  const pool: BossAbility[] = [
    "NONE", "NONE",
    "HALF_TIME", "MIRROR_TEXT", /* "MOVING_BUTTONS", */ "FLICKERING_BEAMER", "DANCING_BUZZERS",
    ...(answerType === "SINGLE_CHOICE" ? (["HIDDEN_ANSWER"] as BossAbility[]) : []),
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

async function endSessionWithResult(
  io: Server,
  session: LiveSession,
  sessionManager: SessionManager,
  extra: Record<string, unknown>,
) {
  const topScores = sessionManager.getTopScores(session, 10);
  io.to(session.sessionId).emit(QUIZ_EVENTS.END, { topScores, ...extra });
  await prisma.quizSession.update({
    where: { id: session.sessionId },
    data: { status: "ENDED", endedAt: new Date() },
  });
  sessionManager.endSession(session.sessionId);
}

function getTeacherSession(socket: Socket, sessionManager: SessionManager): string | null {
  for (const room of socket.rooms) {
    const session = sessionManager.getById(room);
    if (session && session.teacherSocketId === socket.id) return room;
  }
  return null;
}
