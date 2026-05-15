import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";
import { z } from "zod";

const CreateSessionSchema = z.object({
  quizId: z.string().cuid(),
  lobbyId: z.string(),
  gameMode: z.enum(["AUTONOMOUS", "BEAMER"]).default("AUTONOMOUS"),
});

// POST /api/sessions — teacher creates a quiz session for a lobby
export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session || session.role !== "teacher") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = CreateSessionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  // Only one active session per lobby
  const existing = await prisma.quizSession.findFirst({
    where: { lobbyId: parsed.data.lobbyId, status: { not: "ENDED" } },
  });
  if (existing) {
    return NextResponse.json({ error: "Bereits eine aktive Session für diesen Raum" }, { status: 409 });
  }

  const quiz = await prisma.quiz.findUnique({ where: { id: parsed.data.quizId } });
  if (!quiz) return NextResponse.json({ error: "Quiz nicht gefunden" }, { status: 404 });

  // Teachers can only use their own or public/school quizzes
  const canUse =
    quiz.teacherId === session.sub ||
    quiz.visibility === "PUBLIC" ||
    (quiz.visibility === "SCHOOL" && quiz.schoolId === session.schoolId);

  if (!canUse) return NextResponse.json({ error: "Kein Zugriff auf dieses Quiz" }, { status: 403 });

  const quizSession = await prisma.quizSession.create({
    data: {
      quizId: parsed.data.quizId,
      lobbyId: parsed.data.lobbyId,
      teacherId: session.sub,
      gameMode: parsed.data.gameMode,
    },
  });

  return NextResponse.json(quizSession, { status: 201 });
}
