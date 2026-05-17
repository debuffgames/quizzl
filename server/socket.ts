import { createServer, IncomingMessage, ServerResponse } from "http";
import { Server } from "socket.io";
import { registerSessionHandlers } from "./handlers/sessionHandlers";
import { registerQuizHandlers } from "./handlers/quizHandlers";
import { registerResponseHandlers } from "./handlers/responseHandlers";
import { sessionManager } from "./sessionManager";
import { QUIZ_EVENTS } from "../src/lib/socket/events";

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

// Internal HTTP endpoint: POST /internal/sessions/:lobbyId/end
// Called by the Next.js app after marking a session ENDED in the DB.
httpServer.on("request", (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? "";
  const match = url.match(/^\/internal\/sessions\/([^/]+)\/end$/);
  if (req.method !== "POST" || !match) {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.headers.authorization !== `Bearer ${INTERNAL_SECRET}`) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const lobbyId = match[1];
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
