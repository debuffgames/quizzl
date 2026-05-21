import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";
import { z } from "zod";

const AnswerSchema = z.object({
  text: z.string().min(1).max(500),
  isCorrect: z.boolean(),
  sortOrder: z.number().int().min(0),
});

const CreateQuestionSchema = z.object({
  text: z.string().min(1).max(2000),
  imageUrl: z.string().url().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  timeLimitSecs: z.number().int().min(5).max(120).nullable().optional(),
  points: z.number().int().min(1).max(10000).default(100),
  answerType: z.enum(["SINGLE_CHOICE", "MULTIPLE_CHOICE", "YES_NO"]).default("SINGLE_CHOICE"),
  explanation: z.string().max(1000).nullable().optional(),
  answers: z.array(AnswerSchema).min(2).max(4),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(req);
  if (!session || session.role !== "teacher") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: quizId } = await params;
  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz) return NextResponse.json({ error: "Quiz nicht gefunden" }, { status: 404 });
  if (quiz.teacherId !== session.sub) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = CreateQuestionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const count = parsed.data.sortOrder ?? (await prisma.question.count({ where: { quizId } }));

  const question = await prisma.question.create({
    data: {
      quizId,
      text: parsed.data.text,
      imageUrl: parsed.data.imageUrl ?? null,
      sortOrder: count,
      timeLimitSecs: parsed.data.timeLimitSecs ?? null,
      points: parsed.data.points,
      answerType: parsed.data.answerType,
      explanation: parsed.data.explanation ?? null,
      answers: { create: parsed.data.answers },
    },
    include: { answers: { orderBy: { sortOrder: "asc" } } },
  });

  return NextResponse.json(question, { status: 201 });
}
