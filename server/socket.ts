import { createServer } from "http";
import { Server } from "socket.io";
import { registerSessionHandlers } from "./handlers/sessionHandlers";
import { registerQuizHandlers } from "./handlers/quizHandlers";
import { registerResponseHandlers } from "./handlers/responseHandlers";
import { sessionManager } from "./sessionManager";

const HUB_ORIGIN = process.env.HUB_ORIGIN ?? "http://localhost:3000";
const PORT = parseInt(process.env.SOCKET_PORT ?? "4001", 10);

const httpServer = createServer();

const io = new Server(httpServer, {
  cors: {
    origin: [HUB_ORIGIN, "http://localhost:3000", "http://localhost:3001"],
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
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
