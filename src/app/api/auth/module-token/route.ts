import { NextRequest, NextResponse } from "next/server";
import { verifyModuleToken } from "@/lib/auth/moduleToken";
import { cookies } from "next/headers";
import { SignJWT } from "jose";

const SECRET = new TextEncoder().encode(process.env.QUIZZL_MODULE_SECRET ?? "");
const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4h — covers a full lesson

/**
 * POST /api/auth/module-token
 * Verifies the hub-issued module token and issues a quizzl session JWT (cookie).
 */
export async function POST(req: NextRequest) {
  const { token } = await req.json().catch(() => ({ token: undefined }));
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const secret = process.env.QUIZZL_MODULE_SECRET;
  if (!secret) return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });

  const payload = verifyModuleToken(token, secret);
  if (!payload) return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });

  // Issue a session JWT (longer-lived, for socket auth and API calls)
  const sessionToken = await new SignJWT({
    sub: payload.sub,
    role: payload.role,
    lobbyId: payload.lobbyId,
    schoolId: payload.schoolId,
    firstName: payload.firstName,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(SECRET);

  const cookieStore = await cookies();
  cookieStore.set("quizzl-session", sessionToken, {
    httpOnly: true,
    sameSite: "none",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  });

  return NextResponse.json({ ok: true, role: payload.role });
}
