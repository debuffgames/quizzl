import type { Server, Socket } from "socket.io";
import { prisma } from "../../src/lib/db/prisma";
import { QUIZ_EVENTS } from "../../src/lib/socket/events";
import type { SessionManager, LiveSession } from "../sessionManager";

export function registerQuizHandlers(io: Server, socket: Socket, sessionManager: SessionManager) {
  socket.on(QUIZ_EVENTS.NEXT_QUESTION, async () => {
    const sessionId = getTeacherSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;

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

    const nextIndex = session.currentQuestionIndex + 1;
    if (nextIndex >= quiz.questions.length) return; // no more questions

    // Reset per-participant answer state
    for (const p of session.participants.values()) {
      p.answeredCurrentQuestion = false;
      p.currentAnswerIds = [];
    }

    const question = quiz.questions[nextIndex];
    session.currentQuestionIndex = nextIndex;

    // Set timer
    session.questionTimerEnd = question.timeLimitSecs
      ? Date.now() + question.timeLimitSecs * 1000
      : null;

    // Persist index to DB
    await prisma.quizSession.update({
      where: { id: sessionId },
      data: { currentQuestionIndex: nextIndex, status: "ACTIVE", startedAt: nextIndex === 0 ? new Date() : undefined },
    });

    const questionPayload = {
      id: question.id,
      text: question.text,  // always sent (beamer and autonomous need text)
      answerType: question.answerType,
      answers: question.answers.map((a) => ({ id: a.id, text: a.text, sortOrder: a.sortOrder })),
      timeLimitSecs: question.timeLimitSecs,
      index: nextIndex,
      total: quiz.questions.length,
    };

    // Students: text only for AUTONOMOUS; buzzer-only (no text) for BEAMER
    const studentPayload = {
      ...questionPayload,
      text: session.gameMode === "AUTONOMOUS" ? question.text : undefined,
      answers: question.answers.map((a) => ({
        id: a.id,
        text: session.gameMode === "AUTONOMOUS" ? a.text : undefined,
        sortOrder: a.sortOrder,
      })),
    };
    io.to(`${sessionId}:students`).emit(QUIZ_EVENTS.QUESTION, studentPayload);

    // Beamer: full text
    io.to(`${sessionId}:beamer`).emit(QUIZ_EVENTS.QUESTION, questionPayload);

    // Teacher
    if (session.teacherSocketId) {
      io.to(session.teacherSocketId).emit(QUIZ_EVENTS.QUESTION, questionPayload);
      io.to(session.teacherSocketId).emit(QUIZ_EVENTS.RESPONSE_COUNT, { answered: 0, total: session.participants.size });
    }

    // Auto-advance timer (AUTONOMOUS mode or BEAMER with timer)
    if (session.questionTimerEnd) {
      const delay = question.timeLimitSecs! * 1000;
      setTimeout(async () => {
        const current = sessionManager.getById(sessionId);
        if (!current || current.currentQuestionIndex !== nextIndex) return;
        await revealAnswer(io, current, sessionManager);
      }, delay);
    }
  });

  socket.on(QUIZ_EVENTS.REVEAL_ANSWER, async () => {
    const sessionId = getTeacherSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;
    await revealAnswer(io, session, sessionManager);
  });

  socket.on(QUIZ_EVENTS.END_SESSION, async () => {
    const sessionId = getTeacherSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;

    const topScores = sessionManager.getTopScores(session, 10);
    io.to(sessionId).emit(QUIZ_EVENTS.END, { topScores });

    await prisma.quizSession.update({
      where: { id: sessionId },
      data: { status: "ENDED", endedAt: new Date() },
    });

    sessionManager.endSession(sessionId);
  });
}

async function revealAnswer(io: Server, session: LiveSession, _sessionManager: SessionManager) {
  const question = await prisma.question.findFirst({
    where: { quizId: session.quizId, sortOrder: session.currentQuestionIndex },
    include: { answers: true },
  });
  // Fallback: find by index order
  const allQuestions = await prisma.question.findMany({
    where: { quizId: session.quizId },
    orderBy: { sortOrder: "asc" },
    include: { answers: true },
    skip: session.currentQuestionIndex,
    take: 1,
  });
  const q = allQuestions[0] ?? question;
  if (!q) return;

  const correctIds = q.answers.filter((a) => a.isCorrect).map((a) => a.id);

  // Award points to participants who answered correctly
  for (const p of session.participants.values()) {
    if (!p.answeredCurrentQuestion) continue;
    const correct =
      q.answerType === "MULTIPLE_CHOICE"
        ? correctIds.every((id) => p.currentAnswerIds.includes(id)) &&
          p.currentAnswerIds.every((id) => correctIds.includes(id))
        : p.currentAnswerIds.length === 1 && correctIds.includes(p.currentAnswerIds[0]);

    if (correct) {
      // Time-bonus: faster = more points (max points * 1.0, min 0.5)
      const timeBonus = session.questionTimerEnd
        ? Math.max(0.5, (session.questionTimerEnd - Date.now()) / ((q.timeLimitSecs ?? 30) * 1000))
        : 1;
      p.score += Math.round(q.points * timeBonus);
    }

    // Notify individual student of their result
    const clientSocket = io.sockets.sockets.get(p.socketId);
    if (clientSocket) {
      const gained = correct ? Math.round(q.points) : 0;
      clientSocket.emit(QUIZ_EVENTS.ANSWER_REVEAL, {
        correctAnswerIds: correctIds,
        scoreGained: gained,
        totalScore: p.score,
      });
    }
  }

  // Answer distribution for teacher + beamer
  const dist = q.answers.map((a) => ({
    answerId: a.id,
    count: Array.from(session.participants.values()).filter((p) => p.currentAnswerIds.includes(a.id)).length,
    isCorrect: a.isCorrect,
  }));

  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.ANSWER_DIST, { distribution: dist });
  }
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.ANSWER_REVEAL, { correctAnswerIds: correctIds });

  // Scoreboard (top 10)
  const _sessionManagerRef = _sessionManager;
  const topScores = _sessionManagerRef.getTopScores(session, 10);
  io.to(session.sessionId).emit(QUIZ_EVENTS.SCOREBOARD, { topN: topScores });
}

function getTeacherSession(socket: Socket, sessionManager: SessionManager): string | null {
  // Teacher's socket is in the session room — find via room membership
  for (const room of socket.rooms) {
    const session = sessionManager.getById(room);
    if (session && session.teacherSocketId === socket.id) return room;
  }
  return null;
}
