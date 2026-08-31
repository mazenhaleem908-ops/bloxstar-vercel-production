import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function secret(): string {
  const s = process.env["SESSION_SECRET"];
  if (!s || s.length < 16) {
    throw new Error("SESSION_SECRET missing or too short (min 16 chars)");
  }
  return s;
}

/** Cryptographically secure 6-digit OTP. */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function hashOtp(email: string, code: string): string {
  return createHash("sha256").update(`${secret()}|otp|${email}|${code}`).digest("hex");
}

export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(`${secret()}|sess|${token}`).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Server-generated, unguessable, human-readable order code. */
export function generateOrderCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = randomBytes(10);
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `BS-${out.slice(0, 5)}-${out.slice(5, 10)}`;
}
