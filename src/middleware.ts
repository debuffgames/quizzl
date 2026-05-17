import { NextRequest, NextResponse } from "next/server";

const HUB_ORIGIN = process.env.HUB_ORIGIN ?? "";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

export function middleware(req: NextRequest) {
  if (!STATE_CHANGING.has(req.method)) return NextResponse.next();

  // HUB_ORIGIN not configured → skip check (local dev without .env.local)
  if (!HUB_ORIGIN) return NextResponse.next();

  const origin = req.headers.get("origin");

  // No Origin header = same-origin navigation or server-to-server call → allow
  if (!origin) return NextResponse.next();

  const originHost = hostname(origin);
  const ownHost = req.headers.get("host") ?? "";
  const hubHost = hostname(HUB_ORIGIN);

  // Same host as quizzl itself → allow
  if (originHost === ownHost) return NextResponse.next();

  // Trusted hub host → allow
  if (hubHost && originHost === hubHost) return NextResponse.next();

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export const config = {
  matcher: "/api/:path*",
};
