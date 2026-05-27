import type { Server, Socket } from "socket.io";
import { prisma } from "../../src/lib/db/prisma";
import { verifyModuleToken } from "../../src/lib/auth/moduleToken";
import { QUIZ_EVENTS } from "../../src/lib/socket/events";
import type { SessionManager } from "../sessionManager";
import { sendBossState, sendShieldState } from "./quizHandlers";

const MODULE_SECRET = process.env.QUIZZL_MODULE_SECRET ?? "";

export function registerSessionHandlers(io: Server, socket: Socket, sessionManager: SessionManager) {
  // Student joins a quiz session
  socket.on(QUIZ_EVENTS.JOIN, async (data: { lobbyId: string; token: string }, ack?: (r: { ok: boolean; error?: string; gameMode?: string; beamerMode?: string }) => void) => {
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
        beamerMode: (dbSession.beamerMode ?? "STANDARD") as "STANDARD" | "TEAM_SHIELD" | "BOSS",
        speedMode: (dbSession.speedMode ?? "NORMAL") as "NORMAL" | "BLITZ" | "SUPER_BLITZ",
        bossTimerSeconds: dbSession.bossTimerSeconds ?? null,
        currentQuestionIndex: dbSession.currentQuestionIndex,
        questionTimerEnd: null,
      });
    }

    const isReconnect = session.participants.has(payload.sub);

    sessionManager.addParticipant(session.sessionId, {
      socketId: socket.id,
      participantId: payload.sub,
      displayName: payload.firstName ?? "Anonym",
      score: 0,
      answeredCurrentQuestion: false,
      currentAnswerIds: [],
      answeredAt: null,
      revealSent: false,
      teamIndex: null,
      joinedAt: new Date(),
      answerHistory: [],
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

    ack?.({ ok: true, gameMode: session.gameMode, beamerMode: session.beamerMode });

    if (session.paused) socket.emit(QUIZ_EVENTS.PAUSE);

    // Send current state if session is already active
    if (session.currentQuestionIndex >= 0) {
      // TEAM_SHIELD: assign late joiner to smaller team; re-send assignment on reconnect
      if (session.beamerMode === "TEAM_SHIELD" && session.teamShields) {
        const p = session.participants.get(payload.sub)!;
        if (!isReconnect) {
          const t0 = Array.from(session.participants.values()).filter((m) => m.teamIndex === 0).length;
          const t1 = Array.from(session.participants.values()).filter((m) => m.teamIndex === 1).length;
          p.teamIndex = t0 <= t1 ? 0 : 1;
        }
        if (p.teamIndex !== null) {
          socket.emit(QUIZ_EVENTS.TEAM_ASSIGNED, {
            teamIndex: p.teamIndex,
            teamName: p.teamIndex === 0 ? "Team Grün" : "Team Orange",
          });
        }
        socket.emit(QUIZ_EVENTS.SHIELD_STATE, {
          teams: [
            { name: "Team Grün", hp: session.teamShields[0], maxHp: session.teamShieldMax ?? 1 },
            { name: "Team Orange", hp: session.teamShields[1], maxHp: session.teamShieldMax ?? 1 },
          ],
        });
      }

      // BOSS: send current boss state to (re)joining student
      if (session.beamerMode === "BOSS") {
        socket.emit(QUIZ_EVENTS.BOSS_STATE, {
          hp: session.bossHp,
          maxHp: session.bossMaxHp,
          timerEnd: session.bossTimerEnd,
          ability: session.currentBossAbility,
          wrongCount: session.bossWrongCount,
          threshold: Math.max(1, Math.ceil(session.participants.size / 4)),
        });
      }

      await sendCurrentQuestion(io, socket.id, session, sessionManager, payload.sub);
    }
  });

  // Teacher joins to control the session
  socket.on("quiz:teacherJoin", async (data: { lobbyId: string; token: string }, ack?: (r: { ok: boolean; sessionId?: string; gameMode?: string; beamerMode?: string; speedMode?: string; bossTimerSeconds?: number; error?: string }) => void) => {
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
        beamerMode: (dbSession.beamerMode ?? "STANDARD") as "STANDARD" | "TEAM_SHIELD" | "BOSS",
        speedMode: (dbSession.speedMode ?? "NORMAL") as "NORMAL" | "BLITZ" | "SUPER_BLITZ",
        bossTimerSeconds: dbSession.bossTimerSeconds ?? null,
        currentQuestionIndex: dbSession.currentQuestionIndex,
        questionTimerEnd: null,
      });
    }

    const isNewTeacher = session.teacherSocketId === null;

    sessionManager.setTeacherSocket(session.sessionId, socket.id);
    socket.join(session.sessionId);
    socket.join(`${session.sessionId}:teacher`);

    ack?.({ ok: true, sessionId: session.sessionId, gameMode: session.gameMode, beamerMode: session.beamerMode, speedMode: session.speedMode, bossTimerSeconds: session.bossTimerSeconds ?? undefined });

    if (session.paused) socket.emit(QUIZ_EVENTS.PAUSE);

    // On first teacher join for a not-yet-started session, reset any lingering beamer
    // state (e.g. previous BOSS session still on screen)
    if (isNewTeacher && session.currentQuestionIndex === -1) {
      const beamerSocketId = sessionManager.getLobbyBeamerSocket(session.lobbyId);
      if (beamerSocketId) {
        io.to(beamerSocketId).emit(QUIZ_EVENTS.SESSION_STARTED, {
          beamerMode: session.beamerMode,
          speedMode: session.speedMode,
        });
      }
    }

    // If session is already active, send the current question to the teacher
    if (session.currentQuestionIndex >= 0) {
      await sendCurrentQuestion(io, socket.id, session, sessionManager);
      // Restore pending-end state so the teacher sees "Ergebnis anzeigen" after a win
      if (session.pendingEnd) {
        socket.emit(QUIZ_EVENTS.PENDING_END);
      }
    }
  });

  // Beamer joins (persistent — survives across sessions in the same lobby)
  socket.on(QUIZ_EVENTS.BEAMER_JOIN, async (data: { lobbyId: string; token: string }, ack?: (r: { ok: boolean; beamerMode?: string; speedMode?: string; error?: string }) => void) => {
    const payload = verifyModuleToken(data.token, MODULE_SECRET);
    if (!payload || payload.role !== "teacher") {
      ack?.({ ok: false, error: "Ungültiger Token" });
      return;
    }

    // Register beamer for this lobby — persists across sessions
    sessionManager.setLobbyBeamerSocket(data.lobbyId, socket.id);

    const session = sessionManager.getByLobby(data.lobbyId);
    if (!session) {
      // No active session yet — park and wait for SESSION_STARTED
      ack?.({ ok: true });
      return;
    }

    sessionManager.setBeamerSocket(session.sessionId, socket.id);
    socket.join(session.sessionId);
    socket.join(`${session.sessionId}:beamer`);

    ack?.({ ok: true, beamerMode: session.beamerMode, speedMode: session.speedMode });

    if (session.paused) socket.emit(QUIZ_EVENTS.PAUSE);

    if (session.currentQuestionIndex >= 0) {
      await sendCurrentQuestion(io, socket.id, session, sessionManager);
      if (session.beamerMode === "BOSS") sendBossState(io, session);
      if (session.beamerMode === "TEAM_SHIELD") sendShieldState(io, session);
    }
  });
}

async function sendCurrentQuestion(io: Server, socketId: string, session: import("../sessionManager").LiveSession, _sessionManager: SessionManager, participantId?: string) {
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

  const isBeamer = socketId === session.beamerSocketId;
  const isTeacher = socketId === session.teacherSocketId;
  const includeText = session.gameMode === "AUTONOMOUS" || isBeamer || isTeacher;
  const alreadyAnswered = participantId
    ? (session.participants.get(participantId)?.answeredCurrentQuestion ?? false)
    : undefined;

  io.to(socketId).emit(QUIZ_EVENTS.QUESTION, {
    id: question.id,
    text: includeText ? question.text : undefined,
    answerType: question.answerType,
    answers: question.answers.map((a) => ({
      id: a.id,
      text: includeText
        ? (isBeamer && session.hiddenAnswerId === a.id ? null : a.text)
        : undefined,
      sortOrder: a.sortOrder,
    })),
    timeLimitSecs: question.timeLimitSecs,
    remainingSecs,
    index: session.currentQuestionIndex,
    total: quiz?.questions.length ?? 0,
    // Restore speed/visibility/boss state so reconnecting clients get the right UI
    speedMode: !isTeacher ? session.speedMode : undefined,
    answersVisibleAt: !isTeacher ? session.answersVisibleAt : undefined,
    bossAbility: isBeamer
      ? session.currentBossAbility
      : !isTeacher
        ? (session.currentBossAbility === "DANCING_BUZZERS" ? "DANCING_BUZZERS" : null)
        : undefined,
    hiddenAnswerId: isBeamer ? session.hiddenAnswerId : undefined,
    alreadyAnswered: alreadyAnswered || undefined,
  });
}
