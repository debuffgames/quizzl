import { NextRequest, NextResponse } from "next/server";

const HUB_ORIGIN = process.env.HUB_ORIGIN ?? "";
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function hostname(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

function addCors(res: NextResponse, origin: string): NextResponse {
  res.headers.set("Access-Control-Allow-Origin", origin);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  return res;
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get("origin");
  const hubHost = HUB_ORIGIN ? hostname(HUB_ORIGIN) : "";
  const isFromHub = !!(hubHost && origin && hostname(origin) === hubHost);

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    const headers: Record<string, string> = {
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    };
    if (isFromHub && origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    return new NextResponse(null, { status: 204, headers });
  }

  // CSRF protection for state-changing requests
  if (STATE_CHANGING.has(req.method)) {
    if (!HUB_ORIGIN) {
      // Dev without HUB_ORIGIN configured — skip CSRF
      const res = NextResponse.next();
      return isFromHub && origin ? addCors(res, origin) : res;
    }

    if (!origin) {
      // No Origin = server-to-server call, allow
      return NextResponse.next();
    }

    const originHost = hostname(origin);
    const ownHost = req.headers.get("host") ?? "";

    if (originHost === ownHost || (hubHost && originHost === hubHost)) {
      const res = NextResponse.next();
      return isFromHub && origin ? addCors(res, origin) : res;
    }

    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // GET/HEAD — add CORS headers when called from hub
  const res = NextResponse.next();
  return isFromHub && origin ? addCors(res, origin) : res;
}

export const config = {
  matcher: "/api/:path*",
};
