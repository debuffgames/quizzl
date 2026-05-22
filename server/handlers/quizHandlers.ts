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
    if (session.gameMode === "AUTONOMOUS") return; // students manage their own pace
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
    // Send updated scoreboard to all students so end-screen shows live leaderboard
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

  for (const p of session.participants.values()) {
    p.answeredCurrentQuestion = false;
    p.currentAnswerIds = [];
    p.revealSent = false;
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
    explanation: question.explanation ?? null,
    index: nextIndex,
    total: quiz.questions.length,
  };

  // BEAMER: buzzer-only payload (no text) to students
  const studentPayload = {
    ...fullPayload,
    text: undefined,
    answers: question.answers.map((a) => ({ id: a.id, text: undefined, sortOrder: a.sortOrder })),
  };
  io.to(`${session.sessionId}:students`).emit(QUIZ_EVENTS.QUESTION, studentPayload);
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.QUESTION, fullPayload);

  const initialCount = { answered: 0, total: session.participants.size };
  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.QUESTION, fullPayload);
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.RESPONSE_COUNT, initialCount);
  }
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.RESPONSE_COUNT, initialCount);

  // Auto-advance timer for BEAMER mode
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

  // Send reveal to all BEAMER participants
  for (const p of session.participants.values()) {
    if (!p.answeredCurrentQuestion) {
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

    if (correct) {
      const timeBonus = session.questionTimerEnd
        ? Math.max(0.5, (session.questionTimerEnd - Date.now()) / ((q.timeLimitSecs ?? 30) * 1000))
        : 1;
      p.score += Math.round(q.points * timeBonus);
    }

    const clientSocket = io.sockets.sockets.get(p.socketId);
    if (clientSocket) {
      clientSocket.emit(QUIZ_EVENTS.ANSWER_REVEAL, {
        correctAnswerIds: correctIds,
        scoreGained: correct ? Math.round(q.points) : 0,
        totalScore: p.score,
      });
    }
  }

  const dist = q.answers.map((a) => ({
    answerId: a.id,
    count: Array.from(session.participants.values()).filter((p) => p.currentAnswerIds.includes(a.id)).length,
    isCorrect: a.isCorrect,
  }));

  if (session.teacherSocketId) {
    io.to(session.teacherSocketId).emit(QUIZ_EVENTS.ANSWER_DIST, { distribution: dist });
  }
  io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.ANSWER_REVEAL, { correctAnswerIds: correctIds });

  const topScores = sessionManager.getTopScores(session, 10);
  io.to(session.sessionId).emit(QUIZ_EVENTS.SCOREBOARD, { topN: topScores });
}

function getTeacherSession(socket: Socket, sessionManager: SessionManager): string | null {
  for (const room of socket.rooms) {
    const session = sessionManager.getById(room);
    if (session && session.teacherSocketId === socket.id) return room;
  }
  return null;
}
