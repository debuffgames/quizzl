import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getSession } from "@/lib/auth/session";
import { verifyModuleToken } from "@/lib/auth/moduleToken";
import { z } from "zod";

const MODULE_SECRET = process.env.QUIZZL_MODULE_SECRET ?? "";
const HUB_ORIGIN = process.env.HUB_ORIGIN ?? "";

const CreateQuizSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  locale: z.string().default("de"),
  visibility: z.enum(["PRIVATE", "SCHOOL", "PUBLIC"]).default("PRIVATE"),
});

function corsHeaders(): Record<string, string> {
  if (!HUB_ORIGIN) return {};
  return {
    "Access-Control-Allow-Origin": HUB_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

// CORS preflight for hub cross-origin requests
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

// GET /api/quizzes — list own + accessible quizzes
// Accepts cookie session OR Bearer module token (teacher role) for hub integration
export async function GET(req: NextRequest) {
  let sub: string;
  let schoolId: string | undefined;

  const cookieSession = await getSession(req);
  if (cookieSession) {
    sub = cookieSession.sub;
    schoolId = cookieSession.schoolId;
  } else {
    const authHeader = req.headers.get("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const payload = verifyModuleToken(authHeader.slice(7), MODULE_SECRET);
      if (!payload || payload.role !== "teacher") {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      sub = payload.sub;
      schoolId = payload.schoolId;
    } else {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

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

  return NextResponse.json(quizzes, { headers: corsHeaders() });
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
