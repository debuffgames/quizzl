import { createHmac, timingSafeEqual } from "crypto";

export interface ModuleTokenPayload {
  sub: string;
  role: "teacher" | "student" | "hub";
  lobbyId: string;
  schoolId?: string;
  firstName?: string;
  iss: "lernspiel-hub";
  aud: "quizzl";
  exp: number;
}

export function verifyModuleToken(token: string, secret: string): ModuleTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  const expectedSig = createHmac("sha256", secret).update(payloadB64).digest("base64url");

  const sigBuf = Buffer.from(signature, "base64url");
  const expBuf = Buffer.from(expectedSig, "base64url");
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as ModuleTokenPayload;
    if (payload.iss !== "lernspiel-hub" || payload.aud !== "quizzl") return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}
