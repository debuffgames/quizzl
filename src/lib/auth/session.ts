import { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.QUIZZL_MODULE_SECRET ?? "");

export interface QuizzlSession {
  sub: string;
  role: "teacher" | "student";
  lobbyId: string;
  schoolId?: string;
  firstName?: string;
}

export async function getSession(req: NextRequest): Promise<QuizzlSession | null> {
  const cookie = req.cookies.get("quizzl-session")?.value;
  if (!cookie) return null;

  try {
    const { payload } = await jwtVerify(cookie, SECRET);
    return payload as unknown as QuizzlSession;
  } catch {
    return null;
  }
}
