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

  // AUTONOMOUS mode uses client-side evaluation: the full question data including
  // isCorrect is sent to the student's browser. A motivated student could read the
  // correct answers from DevTools. This is an intentional trade-off — it avoids a
  // network round-trip per question and enables offline play. Kahoot and similar tools
  // make the same choice. Do not use Quizzl for high-stakes exams.
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
