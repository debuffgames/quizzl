import { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { verifyModuleToken } from "./moduleToken";

const SECRET = new TextEncoder().encode(process.env.QUIZZL_MODULE_SECRET ?? "");

export interface QuizzlSession {
  sub: string;
  role: "teacher" | "student";
  lobbyId: string;
  schoolId?: string;
  firstName?: string;
}

export async function getSession(req: NextRequest): Promise<QuizzlSession | null> {
  // Try quizzl session cookie first
  const cookie = req.cookies.get("quizzl-session")?.value;
  if (cookie) {
    try {
      const { payload } = await jwtVerify(cookie, SECRET);
      return payload as unknown as QuizzlSession;
    } catch { /* fall through */ }
  }

  // Accept hub-issued module token as Bearer (for hub standalone page)
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const secret = process.env.QUIZZL_MODULE_SECRET ?? "";
    const payload = verifyModuleToken(authHeader.slice(7), secret);
    if (payload && (payload.role === "teacher" || payload.role === "student")) {
      return {
        sub: payload.sub,
        role: payload.role,
        lobbyId: payload.lobbyId,
        schoolId: payload.schoolId,
        firstName: payload.firstName,
      };
    }
  }

  return null;
}
