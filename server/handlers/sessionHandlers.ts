import type { Server, Socket } from "socket.io";
import { prisma } from "../../src/lib/db/prisma";
import { verifyModuleToken } from "../../src/lib/auth/moduleToken";
import { QUIZ_EVENTS } from "../../src/lib/socket/events";
import type { SessionManager } from "../sessionManager";

const MODULE_SECRET = process.env.QUIZZL_MODULE_SECRET ?? "";

export function registerSessionHandlers(io: Server, socket: Socket, sessionManager: SessionManager) {
  // Student joins a quiz session
  socket.on(QUIZ_EVENTS.JOIN, async (data: { lobbyId: string; token: string }, ack?: (r: { ok: boolean; error?: string; gameMode?: string }) => void) => {
    const payload = verifyModuleToken(data.token, MODULE_SECRET);
    if (!payload || payload.role !== "student") {
      ack?.({ ok: false, error: "Ungültiger Token" });
      return;
    }

    let session = sessionManager.getByLobby(data.lobbyId);
    if (!session) {
      const dbSession = await prisma.quizSession.findFirst({
        where: { lobbyId: data.lobbyId, status: { not: "ENDED" } },
        orderBy: { createdAt: "desc" },
      });
      if (!dbSession) {
        ack?.({ ok: false, error: "Keine aktive Session für diesen Raum" });
        return;
      }
      session = sessionManager.createSession({
        sessionId: dbSession.id,
        lobbyId: dbSession.lobbyId,
        quizId: dbSession.quizId,
        teacherId: dbSession.teacherId,
        teacherSocketId: null,
        beamerSocketId: null,
        gameMode: dbSession.gameMode as "AUTONOMOUS" | "BEAMER",
        currentQuestionIndex: dbSession.currentQuestionIndex,
        questionTimerEnd: null,
      });
    }

    sessionManager.addParticipant(session.sessionId, {
      socketId: socket.id,
      participantId: payload.sub,
      displayName: payload.firstName ?? "Anonym",
      score: 0,
      answeredCurrentQuestion: false,
      currentAnswerIds: [],
      revealSent: false,
      joinedAt: new Date(),
    });

    socket.join(session.sessionId);
    socket.join(`${session.sessionId}:students`);

    // Notify teacher
    if (session.teacherSocketId) {
      io.to(session.teacherSocketId).emit(QUIZ_EVENTS.PLAYER_JOINED, {
        participantId: payload.sub,
        displayName: payload.firstName ?? "Anonym",
      });
    }

    ack?.({ ok: true, gameMode: session.gameMode });

    // Send current question if session is already active
    if (session.currentQuestionIndex >= 0) {
      await sendCurrentQuestion(io, socket.id, session, sessionManager);
    }
  });

  // Teacher joins to control the session
  socket.on("quiz:teacherJoin", async (data: { lobbyId: string; token: string }, ack?: (r: { ok: boolean; sessionId?: string; gameMode?: string; error?: string }) => void) => {
    const payload = verifyModuleToken(data.token, MODULE_SECRET);
    if (!payload || payload.role !== "teacher") {
      ack?.({ ok: false, error: "Ungültiger Token" });
      return;
    }

    let session = sessionManager.getByLobby(data.lobbyId);

    // If no session yet, look it up from DB (session was created via REST)
    if (!session) {
      const dbSession = await prisma.quizSession.findFirst({
        where: { lobbyId: data.lobbyId, status: { not: "ENDED" } },
        orderBy: { createdAt: "desc" },
      });
      if (!dbSession) {
        ack?.({ ok: false, error: "Keine Session gefunden" });
        return;
      }
      session = sessionManager.createSession({
        sessionId: dbSession.id,
        lobbyId: dbSession.lobbyId,
        quizId: dbSession.quizId,
        teacherId: dbSession.teacherId,
        teacherSocketId: null,
        beamerSocketId: null,
        gameMode: dbSession.gameMode as "AUTONOMOUS" | "BEAMER",
        currentQuestionIndex: dbSession.currentQuestionIndex,
        questionTimerEnd: null,
      });
    }

    sessionManager.setTeacherSocket(session.sessionId, socket.id);
    socket.join(session.sessionId);
    socket.join(`${session.sessionId}:teacher`);

    ack?.({ ok: true, sessionId: session.sessionId, gameMode: session.gameMode });

    // If session is already active, send the current question to the teacher
    if (session.currentQuestionIndex >= 0) {
      await sendCurrentQuestion(io, socket.id, session, sessionManager);
    }
  });

  // Beamer joins
  socket.on(QUIZ_EVENTS.BEAMER_JOIN, async (data: { sessionId: string; token: string }, ack?: (r: { ok: boolean; error?: string }) => void) => {
    const payload = verifyModuleToken(data.token, MODULE_SECRET);
    if (!payload || payload.role !== "teacher") {
      ack?.({ ok: false, error: "Ungültiger Token" });
      return;
    }

    const session = sessionManager.getById(data.sessionId);
    if (!session) {
      ack?.({ ok: false, error: "Session nicht gefunden" });
      return;
    }

    sessionManager.setBeamerSocket(session.sessionId, socket.id);
    socket.join(session.sessionId);
    socket.join(`${session.sessionId}:beamer`);

    ack?.({ ok: true });
  });
}

async function sendCurrentQuestion(io: Server, socketId: string, session: import("../sessionManager").LiveSession, _sessionManager: SessionManager) {
  if (session.currentQuestionIndex < 0) return;

  const quiz = await prisma.quiz.findUnique({
    where: { id: session.quizId },
    include: {
      questions: {
        orderBy: { sortOrder: "asc" },
        include: { answers: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });

  const question = quiz?.questions[session.currentQuestionIndex];
  if (!question) return;

  const remainingSecs = session.questionTimerEnd
    ? Math.max(0, Math.round((session.questionTimerEnd - Date.now()) / 1000))
    : null;

  io.to(socketId).emit(QUIZ_EVENTS.QUESTION, {
    id: question.id,
    text: session.gameMode === "AUTONOMOUS" ? question.text : undefined,
    answerType: question.answerType,
    answers: question.answers.map((a) => ({
      id: a.id,
      text: session.gameMode === "AUTONOMOUS" ? a.text : undefined,
      sortOrder: a.sortOrder,
    })),
    timeLimitSecs: question.timeLimitSecs,
    remainingSecs,
    index: session.currentQuestionIndex,
    total: quiz?.questions.length ?? 0,
  });
}
