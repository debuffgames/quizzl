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
export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const scope = searchParams.get("scope") ?? "own"; // "own" | "school" | "public"

  if (scope === "own") {
    const quizzes = await prisma.quiz.findMany({
      where: { teacherId: session.sub },
      include: { _count: { select: { questions: true } } },
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json(quizzes);
  }

  if (scope === "school" && session.schoolId) {
    const quizzes = await prisma.quiz.findMany({
      where: { visibility: "SCHOOL", schoolId: session.schoolId },
      include: { _count: { select: { questions: true } } },
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json(quizzes);
  }

  if (scope === "public") {
    const quizzes = await prisma.quiz.findMany({
      where: { visibility: "PUBLIC" },
      include: { _count: { select: { questions: true } } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return NextResponse.json(quizzes);
  }

  return NextResponse.json([]);
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
