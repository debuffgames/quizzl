import { NextRequest, NextResponse } from "next/server";

const HUB_ORIGIN = process.env.HUB_ORIGIN ?? "";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function middleware(req: NextRequest) {
  if (!STATE_CHANGING.has(req.method)) return NextResponse.next();

  // HUB_ORIGIN not configured → skip check (local dev without .env.local)
  if (!HUB_ORIGIN) return NextResponse.next();

  const origin = req.headers.get("origin");

  // No Origin header = same-origin navigation or server-to-server call → allow
  if (!origin) return NextResponse.next();

  // Same origin as quizzl itself → allow
  const host = req.headers.get("host");
  const ownOrigin = `${req.nextUrl.protocol}//${host}`;
  if (origin === ownOrigin) return NextResponse.next();

  // Trusted hub origin → allow
  if (origin === HUB_ORIGIN) return NextResponse.next();

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export const config = {
  matcher: "/api/:path*",
};
