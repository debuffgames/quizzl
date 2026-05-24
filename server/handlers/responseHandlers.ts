import type { Server, Socket } from "socket.io";
import { QUIZ_EVENTS } from "../../src/lib/socket/events";
import type { SessionManager } from "../sessionManager";

export function registerResponseHandlers(io: Server, socket: Socket, sessionManager: SessionManager) {
  socket.on(QUIZ_EVENTS.SUBMIT_ANSWER, (data: { questionId: string; answerIds: string[] }) => {
    const entry = sessionManager.getParticipantBySocket(socket.id);
    if (!entry) return;
    const { session, participant } = entry;

    // Only BEAMER mode uses socket-based answer submission
    if (session.gameMode === "AUTONOMOUS") return;
    if (participant.answeredCurrentQuestion) return;

    participant.answeredCurrentQuestion = true;
    participant.currentAnswerIds = data.answerIds;
    participant.answeredAt = Date.now();

    const count = sessionManager.getResponseCount(session);
    if (session.teacherSocketId) {
      io.to(session.teacherSocketId).emit(QUIZ_EVENTS.RESPONSE_COUNT, count);
    }
    io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.RESPONSE_COUNT, count);
  });
}
