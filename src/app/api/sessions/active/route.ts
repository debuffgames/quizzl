import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const session = await getSession(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const lobbyId = new URL(req.url).searchParams.get("lobbyId");
  if (!lobbyId) return NextResponse.json({ error: "lobbyId fehlt" }, { status: 400 });

  const quizSession = await prisma.quizSession.findFirst({
    where: { lobbyId, status: { not: "ENDED" } },
    include: { quiz: { select: { title: true } } },
    orderBy: { createdAt: "desc" },
  });

  if (!quizSession) return NextResponse.json(null);
  return NextResponse.json(quizSession);
}
