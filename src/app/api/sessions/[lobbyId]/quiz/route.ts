import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ lobbyId: string }> }
) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { lobbyId } = await params;

  const quizSession = await prisma.quizSession.findFirst({
    where: { lobbyId, status: { not: "ENDED" } },
    orderBy: { createdAt: "desc" },
    include: {
      quiz: {
        include: {
          questions: {
            orderBy: { sortOrder: "asc" },
            include: { answers: { orderBy: { sortOrder: "asc" } } },
          },
        },
      },
    },
  });

  if (!quizSession) {
    return NextResponse.json({ error: "Session nicht gefunden" }, { status: 404 });
  }

  return NextResponse.json({
    gameMode: quizSession.gameMode,
    questions: quizSession.quiz.questions.map((q) => ({
      id: q.id,
      text: q.text,
      answerType: q.answerType,
      timeLimitSecs: q.timeLimitSecs,
      points: q.points,
      explanation: q.explanation ?? null,
      answers: q.answers.map((a) => ({
        id: a.id,
        text: a.text,
        isCorrect: a.isCorrect,
        sortOrder: a.sortOrder,
      })),
    })),
  });
}
