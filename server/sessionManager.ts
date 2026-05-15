// In-memory session state — no PII persisted (DSGVO)

export interface LiveParticipant {
  socketId: string;
  participantId: string;
  displayName: string;  // hub firstName, transient
  score: number;
  answeredCurrentQuestion: boolean;
  currentAnswerIds: string[];
  joinedAt: Date;
}

export interface LiveSession {
  sessionId: string;           // QuizSession.id
  lobbyId: string;
  quizId: string;
  teacherId: string;
  teacherSocketId: string | null;
  beamerSocketId: string | null;
  gameMode: "AUTONOMOUS" | "BEAMER";
  currentQuestionIndex: number;
  questionTimerEnd: number | null; // epoch ms, null if no timer
  participants: Map<string, LiveParticipant>; // participantId → participant
  socketToParticipant: Map<string, string>;   // socketId → participantId
}

export class SessionManager {
  private sessions = new Map<string, LiveSession>();        // sessionId → session
  private lobbyToSession = new Map<string, string>();       // lobbyId → sessionId
  private socketToSession = new Map<string, string>();      // socketId → sessionId

  createSession(session: Omit<LiveSession, "participants" | "socketToParticipant">): LiveSession {
    const live: LiveSession = {
      ...session,
      participants: new Map(),
      socketToParticipant: new Map(),
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

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.lobbyToSession.delete(session.lobbyId);
    for (const socketId of session.socketToParticipant.keys()) {
      this.socketToSession.delete(socketId);
    }
    if (session.teacherSocketId) this.socketToSession.delete(session.teacherSocketId);
    if (session.beamerSocketId) this.socketToSession.delete(session.beamerSocketId);
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
