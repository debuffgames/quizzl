import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";
import { verifyModuleToken } from "@/lib/auth/moduleToken";
import { z } from "zod";

const MODULE_SECRET = process.env.QUIZZL_MODULE_SECRET ?? "";
const SOCKET_INTERNAL_URL = process.env.QUIZZL_SOCKET_INTERNAL_URL ?? "http://quizzl-socket:4001";

const CreateSessionSchema = z.object({
  quizId: z.string().cuid(),
  lobbyId: z.string(),
  gameMode: z.enum(["AUTONOMOUS", "BEAMER"]).default("AUTONOMOUS"),
  beamerMode: z.enum(["STANDARD", "TEAM_SHIELD", "BOSS"]).default("STANDARD"),
  speedMode: z.enum(["NORMAL", "BLITZ", "SUPER_BLITZ"]).default("NORMAL"),
  bossTimerSeconds: z.number().int().min(60).max(3600).optional(),
});

// POST /api/sessions — creates a quiz session for a lobby
// Accepts either a teacher session cookie OR a hub server token (Authorization: Bearer <token>)
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = CreateSessionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  let teacherId: string;

  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const payload = verifyModuleToken(authHeader.slice(7), MODULE_SECRET);
    if (!payload || payload.role !== "hub") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    teacherId = payload.sub;
  } else {
    const session = await getSession(req);
    if (!session || session.role !== "teacher") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    teacherId = session.sub;

    // Ownership check only for direct teacher requests (hub is trusted)
    const quiz = await prisma.quiz.findUnique({ where: { id: parsed.data.quizId } });
    if (!quiz) return NextResponse.json({ error: "Quiz nicht gefunden" }, { status: 404 });
    const canUse =
      quiz.teacherId === teacherId ||
      quiz.visibility === "PUBLIC" ||
      (quiz.visibility === "SCHOOL" && quiz.schoolId === session.schoolId);
    if (!canUse) return NextResponse.json({ error: "Kein Zugriff auf dieses Quiz" }, { status: 403 });
  }

  // Only one active session per lobby
  const existing = await prisma.quizSession.findFirst({
    where: { lobbyId: parsed.data.lobbyId, status: { not: "ENDED" } },
  });
  if (existing) {
    return NextResponse.json({ error: "Bereits eine aktive Session für diesen Raum" }, { status: 409 });
  }

  const quizSession = await prisma.quizSession.create({
    data: {
      quizId: parsed.data.quizId,
      lobbyId: parsed.data.lobbyId,
      teacherId,
      gameMode: parsed.data.gameMode,
      beamerMode: parsed.data.beamerMode,
      speedMode: parsed.data.speedMode,
      bossTimerSeconds: parsed.data.bossTimerSeconds ?? null,
    },
  });

  // For AUTONOMOUS sessions, signal the socket server to auto-start after students connect
  if (quizSession.gameMode === "AUTONOMOUS") {
    fetch(`${SOCKET_INTERNAL_URL}/internal/sessions/${quizSession.lobbyId}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${MODULE_SECRET}` },
    }).catch((err) => console.error("[Sessions] Auto-start signal failed:", err));
  }

  return NextResponse.json(quizSession, { status: 201 });
}
