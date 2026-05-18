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
    await advanceToNextQuestion(io, session, sessionManager);
  });

  socket.on(QUIZ_EVENTS.REVEAL_ANSWER, async () => {
    const sessionId = getTeacherSession(socket, sessionManager);
    if (!sessionId) return;
    const session = sessionManager.getById(sessionId);
    if (!session) return;
    if (session.questionTimerHandle) {
      clearTimeout(session.questionTimerHandle);
      session.questionTimerHandle = null;
    }
    await revealAnswer(io, session, sessionManager);
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

    const topScores = sessionManager.getTopScores(session, 10);
    io.to(sessionId).emit(QUIZ_EVENTS.END, { topScores });

    await prisma.quizSession.update({
      where: { id: sessionId },
      data: { status: "ENDED", endedAt: new Date() },
    });

    sessionManager.endSession(sessionId);
  });
}

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

  const nextIndex = session.currentQuestionIndex + 1;
  if (nextIndex >= quiz.questions.length) return;

  // Reset per-participant answer state
  for (const p of session.participants.values()) {
    p.answeredCurrentQuestion = false;
    p.currentAnswerIds = [];
  }

  const question = quiz.questions[nextIndex];
  session.currentQuestionIndex = nextIndex;

  session.questionTimerEnd = question.timeLimitSecs
    ? Date.now() + question.timeLimitSecs * 1000
    : null;

  await prisma.quizSession.update({
    where: { id: session.sessionId },
    data: { currentQuestionIndex: nextIndex, status: "ACTIVE", startedAt: nextIndex === 0 ? new Date() : undefined },
  });

  const fullPayload = {
    id: question.id,
    text: question.text,
    answerType: question.answerType,
    answers: question.answers.map((a) => ({ id: a.id, text: a.text, sortOrder: a.sortOrder })),
    timeLimitSecs: question.timeLimitSecs,
    index: nextIndex,
    total: quiz.questions.length,
  };

  // Students: text only for AUTONOMOUS; buzzer-only (no text) for BEAMER
  const studentPayload = {
    ...fullPayload,
    text: session.gameMode === "AUTONOMOUS" ? question.text : undefined,
    answers: question.answers.map((a) => ({
      id: a.id,
      text: session.gameMode === "AUTONOMOUS" ? a.text : undefined,
      sortOrder: a.sortOrder,
    })),
  };
  io.to(`${session.sessionId}:students`).emit(QUIZ_EVENTS.QUESTION, studentPayload);
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.QUESTION, fullPayload);

  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.QUESTION, fullPayload);
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.RESPONSE_COUNT, { answered: 0, total: session.participants.size });
  }

  // Auto-advance timer (AUTONOMOUS mode or BEAMER with timer)
  if (session.questionTimerEnd) {
    const delay = question.timeLimitSecs! * 1000;
    session.questionTimerHandle = setTimeout(async () => {
      const current = sessionManager.getById(session.sessionId);
      if (!current || current.currentQuestionIndex !== nextIndex) return;
      current.questionTimerHandle = null;
      await revealAnswer(io, current, sessionManager);
    }, delay);
  }
}

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

  // Award points to participants who answered correctly
  for (const p of session.participants.values()) {
    if (!p.answeredCurrentQuestion) continue;
    const correct =
      q.answerType === "MULTIPLE_CHOICE"
        ? correctIds.every((id) => p.currentAnswerIds.includes(id)) &&
          p.currentAnswerIds.every((id) => correctIds.includes(id))
        : p.currentAnswerIds.length === 1 && correctIds.includes(p.currentAnswerIds[0]);

    if (correct) {
      const timeBonus = session.questionTimerEnd
        ? Math.max(0.5, (session.questionTimerEnd - Date.now()) / ((q.timeLimitSecs ?? 30) * 1000))
        : 1;
      p.score += Math.round(q.points * timeBonus);
    }

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

  // Scoreboard
  const topScores = sessionManager.getTopScores(session, 10);
  io.to(session.sessionId).emit(QUIZ_EVENTS.SCOREBOARD, { topN: topScores });

  // AUTONOMOUS mode: auto-advance to next question or end session
  if (session.gameMode === "AUTONOMOUS") {
    const totalQuestions = await prisma.question.count({ where: { quizId: session.quizId } });
    const isLastQuestion = session.currentQuestionIndex >= totalQuestions - 1;

    session.questionTimerHandle = setTimeout(async () => {
      const current = sessionManager.getById(session.sessionId);
      if (!current) return;
      current.questionTimerHandle = null;

      if (isLastQuestion) {
        const finalTopScores = sessionManager.getTopScores(current, 10);
        io.to(current.sessionId).emit(QUIZ_EVENTS.END, { topScores: finalTopScores });
        await prisma.quizSession.update({
          where: { id: current.sessionId },
          data: { status: "ENDED", endedAt: new Date() },
        });
        sessionManager.endSession(current.sessionId);
      } else {
        await advanceToNextQuestion(io, current, sessionManager);
      }
    }, 4000); // 4 seconds for students to see the result before advancing
  }
}

function getTeacherSession(socket: Socket, sessionManager: SessionManager): string | null {
  for (const room of socket.rooms) {
    const session = sessionManager.getById(room);
    if (session && session.teacherSocketId === socket.id) return room;
  }
  return null;
}
