import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";
import { z } from "zod";

const UpdateQuizSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullable().optional(),
  visibility: z.enum(["PRIVATE", "SCHOOL", "PUBLIC"]).optional(),
});

async function canAccess(teacherId: string, schoolId: string | undefined, quiz: { teacherId: string; visibility: string; schoolId: string | null }) {
  if (quiz.teacherId === teacherId) return true;
  if (quiz.visibility === "PUBLIC") return true;
  if (quiz.visibility === "SCHOOL" && schoolId && quiz.schoolId === schoolId) return true;
  return false;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const quiz = await prisma.quiz.findUnique({
    where: { id },
    include: {
      questions: {
        orderBy: { sortOrder: "asc" },
        include: { answers: { orderBy: { sortOrder: "asc" } } },
      },
    },
  });
  if (!quiz) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });

  if (!(await canAccess(session.sub, session.schoolId, quiz))) {
    return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });
  }

  return NextResponse.json(quiz);
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(req);
  if (!session || session.role !== "teacher") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const quiz = await prisma.quiz.findUnique({ where: { id } });
  if (!quiz) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if (quiz.teacherId !== session.sub) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const parsed = UpdateQuizSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const updated = await prisma.quiz.update({
    where: { id },
    data: {
      ...parsed.data,
      schoolId: parsed.data.visibility === "SCHOOL" ? session.schoolId ?? null : parsed.data.visibility === "PRIVATE" ? null : quiz.schoolId,
    },
  });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession(req);
  if (!session || session.role !== "teacher") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const quiz = await prisma.quiz.findUnique({ where: { id } });
  if (!quiz) return NextResponse.json({ error: "Nicht gefunden" }, { status: 404 });
  if (quiz.teacherId !== session.sub) return NextResponse.json({ error: "Kein Zugriff" }, { status: 403 });

  await prisma.quiz.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
