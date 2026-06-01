import type { Server, Socket } from "socket.io";
import { prisma } from "../../src/lib/db/prisma";
import { QUIZ_EVENTS, type BossAbility } from "../../src/lib/socket/events";
import type { SessionManager, LiveSession, LiveParticipant } from "../sessionManager";

export function emitStatsUpdate(io: Server, session: LiveSession) {
  if (!session.teacherSocketId) return;
  const isAutonomous = session.gameMode === "AUTONOMOUS";
  const participants = Array.from(session.participants.values()).map((p) => ({
    participantId: p.participantId,
    displayName: p.displayName,
    score: p.score,
    currentQuestionIndex: isAutonomous ? p.answerHistory.length : session.currentQuestionIndex,
    answeredCurrentQuestion: p.answeredCurrentQuestion,
    correctCount: p.answerHistory.filter((r) => r.isCorrect === true).length,
    wrongCount: p.answerHistory.filter((r) => r.isCorrect === false).length,
    history: p.answerHistory,
  }));
  io.to(session.teacherSocketId).emit(QUIZ_EVENTS.STATS_UPDATE, { participants });
}

export function registerQuizHandlers(io: Server, socket: Socket, sessionManager: SessionManager) {
  socket.on(QUIZ_EVENTS.NEXT_QUESTION, async () => {
    const sessionId = getControllerSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;
    if (session.gameMode === "AUTONOMOUS") return;
    await advanceToNextQuestion(io, session, sessionManager);
  });

  socket.on(QUIZ_EVENTS.REVEAL_ANSWER, async () => {
    const sessionId = getControllerSession(socket, sessionManager);
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

  // BLITZ: teacher/beamer reveals answer tiles and starts countdown
  socket.on(QUIZ_EVENTS.SHOW_ANSWERS, () => {
    const sessionId = getControllerSession(socket, sessionManager);
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

  socket.on(QUIZ_EVENTS.PAUSE, () => {
    const sessionId = getControllerSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session || session.paused) return;

    session.paused = true;
    session.pausedAt = Date.now();

    if (session.questionTimerHandle) {
      clearTimeout(session.questionTimerHandle);
      session.questionTimerHandle = null;
    }

    io.to(session.sessionId).emit(QUIZ_EVENTS.PAUSE);
  });

  socket.on(QUIZ_EVENTS.RESUME, () => {
    const sessionId = getControllerSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session || !session.paused || !session.pausedAt) return;

    const pausedDuration = Date.now() - session.pausedAt;
    session.paused = false;
    session.pausedAt = null;

    // Shift all epoch-ms references forward by pause duration so timers resume correctly
    if (session.questionTimerEnd !== null) session.questionTimerEnd += pausedDuration;
    if (session.bossTimerEnd !== null) session.bossTimerEnd += pausedDuration;
    if (session.answersVisibleAt !== null) session.answersVisibleAt += pausedDuration;

    // Re-start auto-reveal timer if still pending
    if (session.questionTimerEnd !== null && !session.answerRevealed) {
      const remaining = session.questionTimerEnd - Date.now();
      if (remaining > 0) {
        const capturedIndex = session.currentQuestionIndex;
        session.questionTimerHandle = setTimeout(async () => {
          const current = sessionManager.getById(session.sessionId);
          if (!current || current.currentQuestionIndex !== capturedIndex || current.answerRevealed) return;
          current.questionTimerHandle = null;
          await revealAnswer(io, current, sessionManager);
        }, remaining);
      }
    }

    const remainingSecs = session.questionTimerEnd !== null
      ? Math.max(0, Math.round((session.questionTimerEnd - Date.now()) / 1000))
      : null;

    io.to(session.sessionId).emit(QUIZ_EVENTS.RESUME, { remainingSecs });
    if (remainingSecs !== null) {
      io.to(session.sessionId).emit(QUIZ_EVENTS.TIMER_SYNC, { remainingSecs });
    }
    if (session.beamerMode === "BOSS") sendBossState(io, session);
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
  // A win condition was deferred so the beamer animation could finish — resolve it now
  if (session.pendingEnd) {
    const pending = session.pendingEnd;
    session.pendingEnd = null;
    await endSessionWithResult(io, session, sessionManager, pending);
    return;
  }

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

  // Resume boss timer that was frozen during the reveal phase
  if (session.beamerMode === "BOSS" && session.bossTimerFrozenRemaining !== null) {
    session.bossTimerEnd = Date.now() + session.bossTimerFrozenRemaining;
    session.bossTimerFrozenRemaining = null;
  }

  const isFirstQuestion = session.currentQuestionIndex === -1;

  let nextIndex = session.currentQuestionIndex + 1;
  if (nextIndex >= quiz.questions.length) {
    if (session.beamerMode !== "STANDARD") {
      nextIndex = 0; // loop for TEAM_SHIELD and BOSS
    } else {
      return; // STANDARD: done
    }
  }

  session.answerRevealed = false;

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
  session.absoluteQuestionIndex = session.absoluteQuestionIndex < 0 ? 0 : session.absoluteQuestionIndex + 1;
  session.questionStartedAt = Date.now();

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
    fairZoneSecs: session.speedMode !== "NORMAL" ? calcFairZone(question, session.speedMode) : undefined,
  };

  // Students: UNIBEAM = full text (they are the display); BEAMER = buzzer-only (projector shows text)
  const studentPayload = session.displayMode === "UNIBEAM"
    ? {
        ...basePayload,
        bossAbility: session.currentBossAbility,  // full ability in UNIBEAM
      }
    : {
        ...basePayload,
        text: undefined,
        answers: question.answers.map((a) => ({ id: a.id, text: undefined, sortOrder: a.sortOrder })),
        hiddenAnswerId: undefined,
        bossAbility: session.currentBossAbility === "DANCING_BUZZERS" ? "DANCING_BUZZERS" : null,
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

  emitStatsUpdate(io, session);

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

export async function revealAnswer(io: Server, session: LiveSession, sessionManager: SessionManager) {
  if (session.answerRevealed) return;
  session.answerRevealed = true;

  const allQuestions = await prisma.question.findMany({
    where: { quizId: session.quizId },
    orderBy: { sortOrder: "asc" },
    include: { answers: true },
    skip: session.currentQuestionIndex,
    take: 1,
  });
  const q = allQuestions[0];
  if (!q) return;

  const allCorrectIds = q.answers.filter((a) => a.isCorrect).map((a) => a.id);
  // SINGLE_CHOICE / YES_NO: guard against bad data where multiple answers are marked correct
  const correctIds = q.answerType === "MULTIPLE_CHOICE" ? allCorrectIds : allCorrectIds.slice(0, 1);

  // Only participants who were present when this question started count toward averaged damage.
  // Late joiners (joinedAt > questionStartedAt) are excluded from the denominator so they don't
  // dilute the team's output — they start contributing fully from their first seen question.
  const questionStartedAt = session.questionStartedAt;
  const wasPresent = (p: LiveParticipant) =>
    questionStartedAt === null || p.joinedAt.getTime() <= questionStartedAt;
  const eligibleParticipants = Array.from(session.participants.values()).filter(wasPresent);
  const eligibleCount = eligibleParticipants.length;

  // Individual damage per eligible participant (0 = wrong or unanswered)
  const damages = new Map<string, number>();

  for (const p of session.participants.values()) {
    const present = wasPresent(p);

    if (!p.answeredCurrentQuestion) {
      // Unanswered = wrong for BOSS counter (eligible only)
      if (present && session.beamerMode === "BOSS") applyBossWrongAnswer(session, eligibleCount);
      if (present) damages.set(p.participantId, 0);
      // Record unanswered entry in history
      if (!p.answerHistory.find((r) => r.absoluteIndex === session.absoluteQuestionIndex)) {
        p.answerHistory.push({
          questionId: q.id,
          questionIndex: session.currentQuestionIndex,
          absoluteIndex: session.absoluteQuestionIndex,
          answerIds: [],
          isCorrect: false,
          timeTakenSecs: null,
        });
      } else {
        const entry = p.answerHistory.find((r) => r.absoluteIndex === session.absoluteQuestionIndex)!;
        entry.isCorrect = false;
      }
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
      const dmg = calcDamage(session, q, p);
      p.score += dmg;
      scoreGained = dmg;
      if (present) damages.set(p.participantId, dmg);
    } else {
      if (present && session.beamerMode === "BOSS") applyBossWrongAnswer(session, eligibleCount);
      if (present) damages.set(p.participantId, 0);
    }

    // Update isCorrect in this question's history entry
    const histEntry = p.answerHistory.find((r) => r.absoluteIndex === session.absoluteQuestionIndex);
    if (histEntry) histEntry.isCorrect = correct;

    const clientSocket = io.sockets.sockets.get(p.socketId);
    if (clientSocket) {
      clientSocket.emit(QUIZ_EVENTS.ANSWER_REVEAL, { correctAnswerIds: correctIds, scoreGained, totalScore: p.score });
    }
  }

  // Averaged shield damage — independent of team size
  if (session.beamerMode === "TEAM_SHIELD" && session.teamShields) {
    for (const teamIdx of [0, 1] as const) {
      const members = eligibleParticipants.filter((m) => m.teamIndex === teamIdx);
      if (members.length === 0) continue;
      const totalDmg = members.reduce((s, m) => s + (damages.get(m.participantId) ?? 0), 0);
      const avgDmg = Math.round(totalDmg / members.length);
      const opp = (1 - teamIdx) as 0 | 1;
      session.teamShields[opp] = Math.max(0, session.teamShields[opp] - avgDmg);
    }
  }

  // Averaged boss damage — independent of participant count
  if (session.beamerMode === "BOSS" && session.bossHp !== null && eligibleCount > 0) {
    const totalDmg = eligibleParticipants.reduce((s, m) => s + (damages.get(m.participantId) ?? 0), 0);
    const avgDmg = Math.round(totalDmg / eligibleCount);
    session.bossHp = Math.max(0, session.bossHp - avgDmg);
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
  const playerScores = Array.from(session.participants.values())
    .filter((p) => damages.has(p.participantId))
    .map((p) => ({ displayName: p.displayName, teamIndex: p.teamIndex, pointsScored: damages.get(p.participantId) ?? 0 }));
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.ANSWER_REVEAL, { correctAnswerIds: correctIds, hiddenReveal, playerScores });

  const topScores = sessionManager.getTopScores(session, 10);
  io.to(session.sessionId).emit(QUIZ_EVENTS.SCOREBOARD, { topN: topScores });

  // Freeze boss timer for the duration of the reveal phase
  if (session.beamerMode === "BOSS" && session.bossTimerEnd !== null && session.bossTimerFrozenRemaining === null) {
    session.bossTimerFrozenRemaining = Math.max(0, session.bossTimerEnd - Date.now());
  }

  // Push updated mode state
  if (session.beamerMode === "TEAM_SHIELD") sendShieldState(io, session);
  if (session.beamerMode === "BOSS") sendBossState(io, session);

  emitStatsUpdate(io, session);

  // Win/loss conditions — defer END so the beamer animation plays before the scoreboard appears
  if (session.beamerMode === "TEAM_SHIELD" && session.teamShields) {
    const loserIdx = session.teamShields.findIndex((hp) => hp <= 0);
    if (loserIdx >= 0) {
      const isDraw = session.teamShields[0] <= 0 && session.teamShields[1] <= 0;
      const winner = isDraw ? "draw" : (loserIdx === 0 ? "Team Orange" : "Team Grün");
      session.pendingEnd = {
        winner, winType: "shield",
        shieldFinal: [
          { name: "Team Grün", hp: session.teamShields[0], maxHp: session.teamShieldMax ?? 1 },
          { name: "Team Orange", hp: session.teamShields[1], maxHp: session.teamShieldMax ?? 1 },
        ],
      };
      if (session.teacherSocketId) {
        io.to(session.teacherSocketId).emit(QUIZ_EVENTS.PENDING_END);
      }
      return;
    }
  }

  if (session.beamerMode === "BOSS") {
    if (session.bossHp !== null && session.bossHp <= 0) {
      session.pendingEnd = {
        winner: "class", winType: "boss",
        bossTimeRemainingMs: Math.max(0, (session.bossTimerEnd ?? 0) - Date.now()),
        bossTotalMs: (session.bossTimerSeconds ?? 900) * 1000,
      };
      if (session.teacherSocketId) {
        io.to(session.teacherSocketId).emit(QUIZ_EVENTS.PENDING_END);
      }
      return;
    }
    if (session.bossTimerEnd !== null && Date.now() >= session.bossTimerEnd) {
      session.pendingEnd = {
        winner: "boss", winType: "boss",
        bossHpRemaining: session.bossHp ?? 0,
        bossMaxHp: session.bossMaxHp ?? 0,
      };
      if (session.teacherSocketId) {
        io.to(session.teacherSocketId).emit(QUIZ_EVENTS.PENDING_END);
      }
      return;
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fair zone: time at the start of a BLITZ/SUPER_BLITZ question where full points are awarded.
// BLITZ:       0.5s × number of answer options
// SUPER_BLITZ: same base + (reading-time estimate / 3)
export function calcFairZone(
  q: { text: string; answerType: string; answers: { text: string; isCorrect: boolean }[] },
  speedMode: string,
): number {
  const answerBase = 0.5 * q.answers.length;
  if (speedMode !== "SUPER_BLITZ") return answerBase;
  const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
  const totalWords = wordCount(q.text) + q.answers.reduce((sum, a) => sum + wordCount(a.text), 0);
  const correctCount = q.answerType === "MULTIPLE_CHOICE" ? q.answers.filter((a) => a.isCorrect).length : 0;
  const raw = Math.ceil(totalWords / 1.5) + 8 + correctCount * 2;
  return answerBase + raw / 3;
}

function calcDamage(
  session: LiveSession,
  q: { points: number; timeLimitSecs: number | null; text: string; answerType: string; answers: { text: string; isCorrect: boolean }[] },
  p: LiveParticipant,
): number {
  if (session.speedMode === "NORMAL" || !session.answersVisibleAt || !p.answeredAt) {
    return q.points;
  }
  const timeLimitSecs = q.timeLimitSecs ?? 30;
  const elapsed = Math.max(0, (p.answeredAt - session.answersVisibleAt) / 1000);
  const fairZone = calcFairZone(q, session.speedMode);
  const effectiveElapsed = Math.max(0, elapsed - fairZone);
  const effectiveWindow = Math.max(1, timeLimitSecs - fairZone);
  return Math.max(0, Math.round(q.points * (1 - effectiveElapsed / effectiveWindow)));
}

function applyBossWrongAnswer(session: LiveSession, eligibleCount: number): boolean {
  if (session.bossWrongCount === null) return false;
  session.bossWrongCount++;
  // Minimum threshold of 3 so even tiny groups don't get punished by every wrong answer
  const threshold = Math.max(3, Math.ceil(eligibleCount / 4));
  if (session.bossWrongCount % threshold === 0 && session.bossTimerEnd !== null) {
    // Flat 60 s penalty per attack
    session.bossTimerEnd = Math.max(Date.now(), session.bossTimerEnd - 60_000);
    return true; // attacked
  }
  return false;
}

export function sendBossState(io: Server, session: LiveSession) {
  const isFrozen = session.bossTimerFrozenRemaining !== null;
  const state = {
    hp: session.bossHp,
    maxHp: session.bossMaxHp,
    timerEnd: isFrozen ? Date.now() + session.bossTimerFrozenRemaining! : session.bossTimerEnd,
    timerFrozen: isFrozen,
    ability: session.currentBossAbility,
    wrongCount: session.bossWrongCount,
    threshold: Math.max(1, Math.ceil(session.participants.size / 4)),
    players: Array.from(session.participants.values()).map((p) => p.displayName),
  };
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.BOSS_STATE, state);
  io.to(`${session.sessionId}:students`).emit(QUIZ_EVENTS.BOSS_STATE, state);
  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.BOSS_STATE, state);
  }
}

export function sendShieldState(io: Server, session: LiveSession) {
  const participants = Array.from(session.participants.values());
  const state = {
    teams: [
      {
        name: "Team Grün",
        hp: session.teamShields?.[0] ?? 0,
        maxHp: session.teamShieldMax ?? 1,
        players: participants.filter((p) => p.teamIndex === 0).map((p) => p.displayName),
      },
      {
        name: "Team Orange",
        hp: session.teamShields?.[1] ?? 0,
        maxHp: session.teamShieldMax ?? 1,
        players: participants.filter((p) => p.teamIndex === 1).map((p) => p.displayName),
      },
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
        teamName: p.teamIndex === 0 ? "Team Grün" : "Team Orange",
      });
    }
  });
  // Fixed HP independent of team size — damage is averaged per question, not cumulative
  session.teamShieldMax = Math.max(10, Math.ceil(avgPoints * totalQuestions * 0.8));
  session.teamShields = [session.teamShieldMax, session.teamShieldMax];
}

function initBoss(
  session: LiveSession,
  questions: { timeLimitSecs: number | null; points: number }[],
  avgPoints: number,
) {
  const bossTimerSecs = session.bossTimerSeconds ?? 300;
  const avgSecs = questions.reduce((s, q) => s + (q.timeLimitSecs ?? 30), 0) / questions.length;
  const questionsInTime = Math.round(bossTimerSecs / avgSecs);
  // In BLITZ/SUPER_BLITZ average damage per correct answer is ~50% of full points
  const speedFactor = session.speedMode === "NORMAL" ? 1.0 : 0.5;
  // Fixed HP independent of participant count — damage is averaged per question, not cumulative
  session.bossMaxHp = Math.max(10, Math.round(questionsInTime * avgPoints * 1.0 * speedFactor));
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
  if (session.questionTimerHandle) {
    clearTimeout(session.questionTimerHandle);
    session.questionTimerHandle = null;
  }
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

// Accepts commands from either the teacher socket or the beamer socket
function getControllerSession(socket: Socket, sessionManager: SessionManager): string | null {
  for (const room of socket.rooms) {
    const session = sessionManager.getById(room);
    if (session && (session.teacherSocketId === socket.id || session.beamerSocketId === socket.id)) return room;
  }
  return null;
}
