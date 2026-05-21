import type { Server, Socket } from "socket.io";
import { prisma } from "../../src/lib/db/prisma";
import { QUIZ_EVENTS } from "../../src/lib/socket/events";
import type { SessionManager } from "../sessionManager";

export function registerResponseHandlers(io: Server, socket: Socket, sessionManager: SessionManager) {
  socket.on(QUIZ_EVENTS.SUBMIT_ANSWER, async (data: { questionId: string; answerIds: string[] }) => {
    const entry = sessionManager.getParticipantBySocket(socket.id);
    if (!entry) return;

    const { session, participant } = entry;

    // Only accept one submission per question
    if (participant.answeredCurrentQuestion) return;

    participant.answeredCurrentQuestion = true;
    participant.currentAnswerIds = data.answerIds;

    const count = sessionManager.getResponseCount(session);

    // Update teacher + beamer with live response count
    if (session.teacherSocketId) {
      io.to(session.teacherSocketId).emit(QUIZ_EVENTS.RESPONSE_COUNT, count);
    }
    io.to(`${session.sessionId}:beamer`).emit(QUIZ_EVENTS.RESPONSE_COUNT, count);

    // AUTONOMOUS: immediately reveal to this participant without waiting for the timer
    if (session.gameMode === "AUTONOMOUS") {
      const questions = await prisma.question.findMany({
        where: { quizId: session.quizId },
        orderBy: { sortOrder: "asc" },
        include: { answers: true },
        skip: session.currentQuestionIndex,
        take: 1,
      });
      const q = questions[0];
      if (!q) return;

      const correctIds = q.answers.filter((a) => a.isCorrect).map((a) => a.id);
      const correct =
        q.answerType === "MULTIPLE_CHOICE"
          ? correctIds.every((id) => data.answerIds.includes(id)) &&
            data.answerIds.every((id) => correctIds.includes(id))
          : data.answerIds.length === 1 && correctIds.includes(data.answerIds[0]);

      if (correct) {
        const timeBonus = session.questionTimerEnd
          ? Math.max(0.5, (session.questionTimerEnd - Date.now()) / ((q.timeLimitSecs ?? 30) * 1000))
          : 1;
        participant.score += Math.round(q.points * timeBonus);
      }

      participant.revealSent = true;

      socket.emit(QUIZ_EVENTS.ANSWER_REVEAL, {
        correctAnswerIds: correctIds,
        scoreGained: correct ? Math.round(q.points) : 0,
        totalScore: participant.score,
      });
    }
  });
}
