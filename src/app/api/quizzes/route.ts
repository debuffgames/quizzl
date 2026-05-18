import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";
import { z } from "zod";

const CreateQuizSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  locale: z.string().default("de"),
  visibility: z.enum(["PRIVATE", "SCHOOL", "PUBLIC"]).default("PRIVATE"),
});

// GET /api/quizzes — list own + accessible quizzes
// Accepts cookie session OR Bearer module token (teacher role) for hub integration
export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sub = session.sub;
  const schoolId = session.schoolId;

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get("scope") ?? "own";

  let quizzes;
  if (scope === "school" && schoolId) {
    quizzes = await prisma.quiz.findMany({
      where: { visibility: "SCHOOL", schoolId },
      include: { _count: { select: { questions: true } } },
      orderBy: { updatedAt: "desc" },
    });
  } else if (scope === "public") {
    quizzes = await prisma.quiz.findMany({
      where: { visibility: "PUBLIC" },
      include: { _count: { select: { questions: true } } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
  } else {
    quizzes = await prisma.quiz.findMany({
      where: { teacherId: sub },
      include: { _count: { select: { questions: true } } },
      orderBy: { updatedAt: "desc" },
    });
  }

  return NextResponse.json(quizzes);
}

// POST /api/quizzes — create new quiz
export async function POST(req: NextRequest) {
  const session = await getSession(req);
  if (!session || session.role !== "teacher") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = CreateQuizSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const quiz = await prisma.quiz.create({
    data: {
      ...parsed.data,
      teacherId: session.sub,
      schoolId: parsed.data.visibility === "SCHOOL" ? session.schoolId : null,
    },
  });

  return NextResponse.json(quiz, { status: 201 });
}
