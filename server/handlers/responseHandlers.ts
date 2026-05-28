import type { Server, Socket } from "socket.io";
import { QUIZ_EVENTS } from "../../src/lib/socket/events";
import type { SessionManager } from "../sessionManager";
import { emitStatsUpdate, revealAnswer } from "./quizHandlers";

export function registerResponseHandlers(io: Server, socket: Socket, sessionManager: SessionManager) {
  socket.on(QUIZ_EVENTS.SUBMIT_ANSWER, async (data: { questionId: string; answerIds: string[] }) => {
    const entry = sessionManager.getParticipantBySocket(socket.id);
    if (!entry) return;
    const { session, participant } = entry;

    // Only BEAMER mode uses socket-based answer submission
    if (session.gameMode === "AUTONOMOUS") return;
    if (participant.answeredCurrentQuestion) return;

    participant.answeredCurrentQuestion = true;
    participant.currentAnswerIds = data.answerIds;
    participant.answeredAt = Date.now();

    const timeTakenSecs = session.questionStartedAt !== null
      ? Math.max(0, (participant.answeredAt - session.questionStartedAt) / 1000)
      : null;

    participant.answerHistory.push({
      questionId: data.questionId,
      questionIndex: session.currentQuestionIndex,
      absoluteIndex: session.absoluteQuestionIndex,
      answerIds: data.answerIds,
      isCorrect: null,
      timeTakenSecs,
    });

    const count = sessionManager.getResponseCount(session);
    if (session.teacherSocketId) {
      io.to(session.teacherSocketId).emit(QUIZ_EVENTS.RESPONSE_COUNT, count);
    }
    io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.RESPONSE_COUNT, count);

    emitStatsUpdate(io, session);

    // Auto-reveal when all players have submitted
    if (count.answered === count.total && count.total > 0 && !session.answerRevealed) {
      if (session.questionTimerHandle) {
        clearTimeout(session.questionTimerHandle);
        session.questionTimerHandle = null;
      }
      await revealAnswer(io, session, sessionManager);
    }
  });

  // AUTONOMOUS: student reports per-question result (client-side evaluation)
  socket.on(QUIZ_EVENTS.STUDENT_PROGRESS, (data: { questionId: string; questionIndex: number; answerIds: string[]; isCorrect: boolean; timeTakenSecs: number | null }) => {
    const entry = sessionManager.getParticipantBySocket(socket.id);
    if (!entry) return;
    const { session, participant } = entry;
    if (session.gameMode !== "AUTONOMOUS") return;

    // Don't double-record the same question
    if (participant.answerHistory.find((r) => r.questionIndex === data.questionIndex)) return;

    participant.answerHistory.push({
      questionId: data.questionId,
      questionIndex: data.questionIndex,
      absoluteIndex: data.questionIndex, // for AUTONOMOUS, absoluteIndex = questionIndex (no looping)
      answerIds: data.answerIds,
      isCorrect: data.isCorrect,
      timeTakenSecs: data.timeTakenSecs,
    });

    emitStatsUpdate(io, session);
  });
}
