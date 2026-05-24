import { createServer, IncomingMessage, ServerResponse } from "http";
import { Server } from "socket.io";
import { registerSessionHandlers } from "./handlers/sessionHandlers";
import { registerQuizHandlers, advanceToNextQuestion } from "./handlers/quizHandlers";
import { registerResponseHandlers } from "./handlers/responseHandlers";
import { sessionManager } from "./sessionManager";
import { QUIZ_EVENTS } from "../src/lib/socket/events";
import { prisma } from "../src/lib/db/prisma";

const HUB_ORIGIN = process.env.HUB_ORIGIN ?? "http://localhost:3000";
const PORT = parseInt(process.env.SOCKET_PORT ?? "4001", 10);
const INTERNAL_SECRET = process.env.QUIZZL_MODULE_SECRET ?? "";

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: {
    origin: [HUB_ORIGIN, "http://localhost:3000", "http://localhost:3001"],
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
});

// Internal HTTP endpoints — only POST /internal/... are matched; everything else is left to Socket.io
httpServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "";
  if (req.method !== "POST" || !url.startsWith("/internal/sessions/")) return;

  const endMatch = url.match(/^\/internal\/sessions\/([^/]+)\/end$/);
  const startMatch = url.match(/^\/internal\/sessions\/([^/]+)\/start$/);

  if (!endMatch && !startMatch) return;

  if (req.headers.authorization !== `Bearer ${INTERNAL_SECRET}`) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  // POST /internal/sessions/:lobbyId/end
  if (endMatch) {
    const lobbyId = endMatch[1];
    const session = sessionManager.getByLobby(lobbyId);
    if (session) {
      if (session.questionTimerHandle) {
        clearTimeout(session.questionTimerHandle);
      }
      io.to(session.sessionId).emit(QUIZ_EVENTS.END, { reason: "hub_stopped" });
      sessionManager.endSession(session.sessionId);
      console.log(`[Quizzl] Session for lobby ${lobbyId} ended by hub`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /internal/sessions/:lobbyId/start — AUTONOMOUS auto-start first question
  if (startMatch) {
    const lobbyId = startMatch[1];
    console.log(`[Quizzl] Auto-start scheduled for lobby ${lobbyId}`);

    // Fire-and-forget: give students 3 seconds to connect, then start first question
    setTimeout(async () => {
      try {
        let session = sessionManager.getByLobby(lobbyId);
        if (!session) {
          // Students may not have joined yet — create session in RAM from DB
          const dbSession = await prisma.quizSession.findFirst({
            where: { lobbyId, status: { not: "ENDED" } },
            orderBy: { createdAt: "desc" },
          });
          if (!dbSession) {
            console.log(`[Quizzl] Auto-start: no DB session found for lobby ${lobbyId}`);
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
            beamerMode: (dbSession.beamerMode ?? "STANDARD") as "STANDARD" | "TEAM_SHIELD" | "BOSS",
            speedMode: (dbSession.speedMode ?? "NORMAL") as "NORMAL" | "BLITZ" | "SUPER_BLITZ",
            bossTimerSeconds: dbSession.bossTimerSeconds ?? null,
            currentQuestionIndex: dbSession.currentQuestionIndex,
            questionTimerEnd: null,
          });
        }
        if (session.currentQuestionIndex >= 0) {
          console.log(`[Quizzl] Auto-start: session already started for lobby ${lobbyId}`);
          return;
        }
        await advanceToNextQuestion(io, session, sessionManager);
        console.log(`[Quizzl] Auto-start: first question sent for lobby ${lobbyId}`);
      } catch (err) {
        console.error(`[Quizzl] Auto-start error for lobby ${lobbyId}:`, err);
      }
    }, 3000);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
});

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  registerSessionHandlers(io, socket, sessionManager);
  registerQuizHandlers(io, socket, sessionManager);
  registerResponseHandlers(io, socket, sessionManager);

  socket.on("disconnect", () => {
    console.log(`[Socket] Client disconnected: ${socket.id}`);
    sessionManager.removeParticipant(socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[Quizzl Socket] Listening on port ${PORT}`);
});
