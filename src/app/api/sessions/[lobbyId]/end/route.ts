import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { verifyModuleToken } from "@/lib/auth/moduleToken";

const MODULE_SECRET = process.env.QUIZZL_MODULE_SECRET ?? "";

// POST /api/sessions/[lobbyId]/end — hub marks the session as ended
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ lobbyId: string }> }
) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = verifyModuleToken(authHeader.slice(7), MODULE_SECRET);
  if (!payload || payload.role !== "hub") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { lobbyId } = await params;

  await prisma.quizSession.updateMany({
    where: { lobbyId, status: { not: "ENDED" } },
    data: { status: "ENDED", endedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
