// In-memory session state — no PII persisted (DSGVO)

import type { BossAbility } from "../src/lib/socket/events";

export interface AnswerRecord {
  questionId: string;
  questionIndex: number;   // 0-based index in quiz, for looking up question data
  absoluteIndex: number;   // ever-increasing across loops, for reveal correlation
  answerIds: string[];
  isCorrect: boolean | null;  // null until revealed (BEAMER); set immediately (AUTONOMOUS)
  timeTakenSecs: number | null;
}

export interface LiveParticipant {
  socketId: string;
  participantId: string;
  displayName: string;  // hub firstName, transient
  score: number;
  answeredCurrentQuestion: boolean;
  currentAnswerIds: string[];
  answeredAt: number | null;          // epoch ms when SUBMIT_ANSWER received (for BLITZ scoring)
  revealSent: boolean;                // AUTONOMOUS: reveal already sent to this participant
  teamIndex: 0 | 1 | null;           // TEAM_SHIELD: which team (0=Grün, 1=Lila)
  joinedAt: Date;
  answerHistory: AnswerRecord[];
}

export interface LiveSession {
  sessionId: string;           // QuizSession.id
  lobbyId: string;
  quizId: string;
  teacherId: string;
  teacherSocketId: string | null;
  beamerSocketId: string | null;
  gameMode: "AUTONOMOUS" | "BEAMER";
  beamerMode: "STANDARD" | "TEAM_SHIELD" | "BOSS";
  speedMode: "NORMAL" | "BLITZ" | "SUPER_BLITZ";
  currentQuestionIndex: number;
  questionTimerEnd: number | null;    // epoch ms, null if no timer
  questionTimerHandle: ReturnType<typeof setTimeout> | null;
  participants: Map<string, LiveParticipant>; // participantId → participant
  socketToParticipant: Map<string, string>;   // socketId → participantId

  // BLITZ / SUPER_BLITZ: epoch ms when answers became visible; null = not yet (BLITZ) or NORMAL
  answersVisibleAt: number | null;

  // Analytics
  questionStartedAt: number | null;  // epoch ms when current question was sent to all clients
  absoluteQuestionIndex: number;     // ever-increasing (never resets on loop); -1 before first question

  // TEAM_SHIELD
  teamShieldMax: number | null;
  teamShields: [number, number] | null;  // [team0=Grün, team1=Lila]

  // BOSS
  bossMaxHp: number | null;
  bossHp: number | null;
  bossTimerSeconds: number | null;
  bossTimerEnd: number | null;           // epoch ms; reduced by boss attacks
  bossWrongCount: number | null;
  currentBossAbility: BossAbility | null;
  hiddenAnswerId: string | null;         // HIDDEN_ANSWER: ID of the answer hidden on beamer
  pendingEnd: Record<string, unknown> | null; // deferred END payload — sent when teacher clicks next
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>();        // sessionId → session
  private lobbyToSession = new Map<string, string>();       // lobbyId → sessionId
  private socketToSession = new Map<string, string>();      // socketId → sessionId
  private lobbyBeamerSockets = new Map<string, string>();   // lobbyId → beamer socketId (persists across sessions)
  private beamerSocketToLobby = new Map<string, string>();  // beamer socketId → lobbyId (for cleanup)

  createSession(session: Omit<LiveSession, "participants" | "socketToParticipant" | "questionTimerHandle" | "answersVisibleAt" | "questionStartedAt" | "absoluteQuestionIndex" | "teamShieldMax" | "teamShields" | "bossMaxHp" | "bossHp" | "bossTimerEnd" | "bossWrongCount" | "currentBossAbility" | "hiddenAnswerId" | "pendingEnd">): LiveSession {
    const live: LiveSession = {
      ...session,
      questionTimerHandle: null,
      participants: new Map(),
      socketToParticipant: new Map(),
      answersVisibleAt: null,
      questionStartedAt: null,
      absoluteQuestionIndex: -1,
      teamShieldMax: null,
      teamShields: null,
      bossMaxHp: null,
      bossHp: null,
      bossTimerEnd: null,
      bossWrongCount: null,
      currentBossAbility: null,
      hiddenAnswerId: null,
      pendingEnd: null,
    };
    this.sessions.set(session.sessionId, live);
    this.lobbyToSession.set(session.lobbyId, session.sessionId);
    return live;
  }

  getByLobby(lobbyId: string): LiveSession | undefined {
    const id = this.lobbyToSession.get(lobbyId);
    return id ? this.sessions.get(id) : undefined;
  }

  getById(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  addParticipant(sessionId: string, participant: LiveParticipant): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.participants.set(participant.participantId, participant);
    session.socketToParticipant.set(participant.socketId, participant.participantId);
    this.socketToSession.set(participant.socketId, sessionId);
  }

  removeParticipant(socketId: string): { session: LiveSession; participant: LiveParticipant } | undefined {
    const sessionId = this.socketToSession.get(socketId);
    if (!sessionId) return undefined;
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    const participantId = session.socketToParticipant.get(socketId);
    if (!participantId) return undefined;

    const participant = session.participants.get(participantId);
    session.participants.delete(participantId);
    session.socketToParticipant.delete(socketId);
    this.socketToSession.delete(socketId);

    if (session.teacherSocketId === socketId) session.teacherSocketId = null;
    if (session.beamerSocketId === socketId) session.beamerSocketId = null;

    return participant ? { session, participant } : undefined;
  }

  getParticipantBySocket(socketId: string): { session: LiveSession; participant: LiveParticipant } | undefined {
    const sessionId = this.socketToSession.get(socketId);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) return undefined;
    const participantId = session.socketToParticipant.get(socketId);
    const participant = participantId ? session.participants.get(participantId) : undefined;
    return participant ? { session, participant } : undefined;
  }

  setTeacherSocket(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.teacherSocketId = socketId;
      this.socketToSession.set(socketId, sessionId);
    }
  }

  setBeamerSocket(sessionId: string, socketId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.beamerSocketId = socketId;
      this.socketToSession.set(socketId, sessionId);
    }
  }

  setLobbyBeamerSocket(lobbyId: string, socketId: string): void {
    const prev = this.lobbyBeamerSockets.get(lobbyId);
    if (prev) this.beamerSocketToLobby.delete(prev);
    this.lobbyBeamerSockets.set(lobbyId, socketId);
    this.beamerSocketToLobby.set(socketId, lobbyId);
  }

  getLobbyBeamerSocket(lobbyId: string): string | null {
    return this.lobbyBeamerSockets.get(lobbyId) ?? null;
  }

  removeBeamerSocket(socketId: string): void {
    const lobbyId = this.beamerSocketToLobby.get(socketId);
    if (lobbyId) {
      this.lobbyBeamerSockets.delete(lobbyId);
      this.beamerSocketToLobby.delete(socketId);
    }
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.lobbyToSession.delete(session.lobbyId);
    for (const socketId of session.socketToParticipant.keys()) {
      this.socketToSession.delete(socketId);
    }
    if (session.teacherSocketId) this.socketToSession.delete(session.teacherSocketId);
    if (session.beamerSocketId) this.socketToSession.delete(session.beamerSocketId);
    // lobbyBeamerSockets intentionally NOT cleared — beamer persists across sessions
    this.sessions.delete(sessionId);
  }

  getTopScores(session: LiveSession, n = 10): { rank: number; displayName: string; score: number }[] {
    return Array.from(session.participants.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, n)
      .map((p, i) => ({ rank: i + 1, displayName: p.displayName, score: p.score }));
  }

  getResponseCount(session: LiveSession): { answered: number; total: number } {
    let answered = 0;
    for (const p of session.participants.values()) {
      if (p.answeredCurrentQuestion) answered++;
    }
    return { answered, total: session.participants.size };
  }
}

export const sessionManager = new SessionManager();
