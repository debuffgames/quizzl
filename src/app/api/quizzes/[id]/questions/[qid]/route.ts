import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";
import { z } from "zod";

const AnswerSchema = z.object({
  text: z.string().min(1).max(500),
  isCorrect: z.boolean(),
  sortOrder: z.number().int().min(0),
});

const UpdateQuestionSchema = z.object({
  text: z.string().min(1).max(2000).optional(),
  imageUrl: z.string().url().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  timeLimitSecs: z.number().int().min(5).max(120).nullable().optional(),
  points: z.number().int().min(1).max(10000).optional(),
  answerType: z.enum(["SINGLE_CHOICE", "MULTIPLE_CHOICE", "YES_NO"]).optional(),
  answers: z.array(AnswerSchema).min(2).max(4).optional(),
});

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; qid: string }> }) {
  const session = await getSession(req);
  if (!session || session.role !== "teacher") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: quizId, qid } = await params;
  const question = await prisma.question.findUnique({ where: { id: qid }, include: { quiz: true } });
  if (!question || question.quizId !== quizId) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if (question.quiz.teacherId !== session.sub) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = UpdateQuestionSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { answers, ...questionData } = parsed.data;

  const updated = await prisma.$transaction(async (tx) => {
    const q = await tx.question.update({ where: { id: qid }, data: questionData });
    if (answers) {
      await tx.answer.deleteMany({ where: { questionId: qid } });
      await tx.answer.createMany({ data: answers.map((a) => ({ ...a, questionId: qid })) });
    }
    return tx.question.findUnique({ where: { id: qid }, include: { answers: { orderBy: { sortOrder: "asc" } } } });
  });

  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; qid: string }> }) {
  const session = await getSession(req);
  if (!session || session.role !== "teacher") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: quizId, qid } = await params;
  const question = await prisma.question.findUnique({ where: { id: qid }, include: { quiz: true } });
  if (!question || question.quizId !== quizId) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if (question.quiz.teacherId !== session.sub) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });

  await prisma.question.delete({ where: { id: qid } });
  return NextResponse.json({ ok: true });
}
