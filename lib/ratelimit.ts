import { query } from "./db.js";

export type Limit = { windowSeconds: number; max: number; code: string };

export const OTP_SEND_LIMITS: Record<"email" | "ip", Limit[]> = {
  email: [
    { windowSeconds: 60, max: 1, code: "cooldown" },
    { windowSeconds: 3600, max: 5, code: "hourly_limit" },
    { windowSeconds: 86400, max: 20, code: "daily_limit" },
  ],
  ip: [
    { windowSeconds: 60, max: 3, code: "cooldown" },
    { windowSeconds: 3600, max: 15, code: "hourly_limit" },
    { windowSeconds: 86400, max: 60, code: "daily_limit" },
  ],
};

export const OTP_VERIFY_LIMITS: Record<"email" | "ip", Limit[]> = {
  email: [{ windowSeconds: 900, max: 10, code: "too_many_attempts" }],
  ip: [{ windowSeconds: 900, max: 30, code: "too_many_attempts" }],
};

async function countSince(bucket: string, subject: string, seconds: number): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM rate_events
      WHERE bucket = $1 AND subject = $2 AND created_at > now() - ($3 || ' seconds')::interval`,
    [bucket, subject, String(seconds)],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function recordEvent(bucket: string, subject: string): Promise<void> {
  await query(`INSERT INTO rate_events (bucket, subject) VALUES ($1, $2)`, [bucket, subject]);
}

/**
 * Server-side rate limiting. The frontend limiter is advisory only; this is the
 * enforcement point and applies to direct API calls too.
 */
export async function checkLimits(
  bucket: string,
  subjects: { email?: string; ip?: string },
  limits: Record<"email" | "ip", Limit[]>,
): Promise<{ ok: true } | { ok: false; code: string; retryAfter: number }> {
  for (const kind of ["email", "ip"] as const) {
    const value = subjects[kind];
    if (!value) continue;
    const subject = `${kind}:${value}`;
    for (const l of limits[kind]) {
      const n = await countSince(bucket, subject, l.windowSeconds);
      if (n >= l.max) return { ok: false, code: l.code, retryAfter: l.windowSeconds };
    }
  }
  return { ok: true };
}

export async function recordAll(bucket: string, subjects: { email?: string; ip?: string }) {
  if (subjects.email) await recordEvent(bucket, `email:${subjects.email}`);
  if (subjects.ip) await recordEvent(bucket, `ip:${subjects.ip}`);
}
