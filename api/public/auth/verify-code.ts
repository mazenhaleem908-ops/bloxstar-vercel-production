import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route, body, normEmail, clientIp } from "../../../lib/http.js";
import { query } from "../../../lib/db.js";
import { hashOtp, safeEqual } from "../../../lib/crypto.js";
import { checkLimits, recordAll, OTP_VERIFY_LIMITS } from "../../../lib/ratelimit.js";
import { createSession } from "../../../lib/session.js";

export const MAX_ATTEMPTS = 5;

export default route(["POST"], async (req: VercelRequest, res: VercelResponse) => {
  const b = body(req);
  const email = normEmail(b["email"]);
  const ip = clientIp(req);
  const code = String(b["code"] ?? "").trim();
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "invalid_code" });

  const limit = await checkLimits("otp_verify", { email, ip }, OTP_VERIFY_LIMITS);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({ ok: false, error: "rate_limited", reason: limit.code });
  }
  await recordAll("otp_verify", { email, ip });

  const rows = await query<{ id: string; code_hash: string; attempts: number; expired: boolean }>(
    `SELECT id, code_hash, attempts, (expires_at <= now()) AS expired
       FROM otp_codes
      WHERE email = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [email],
  );
  const row = rows[0];
  if (!row) return res.status(400).json({ ok: false, error: "invalid_code" });
  if (row.expired) {
    await query(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
    return res.status(400).json({ ok: false, error: "code_expired" });
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await query(`UPDATE otp_codes SET consumed_at = now() WHERE id = $1`, [row.id]);
    return res.status(429).json({ ok: false, error: "too_many_attempts" });
  }

  if (!safeEqual(row.code_hash, hashOtp(email, code))) {
    await query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return res.status(400).json({ ok: false, error: "invalid_code" });
  }

  // One-time use: consume atomically so a replay of the same code cannot succeed.
  const consumed = await query(
    `UPDATE otp_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id`,
    [row.id],
  );
  if (!consumed.length) return res.status(400).json({ ok: false, error: "invalid_code" });

  const session = await createSession(email, ip);
  return res.status(200).json({
    ok: true,
    token: session.token,
    email: session.email,
    // Determined server-side from admin_emails. `admin` is the field name the
    // storefront reads; `isAdmin` is kept for existing API consumers.
    isAdmin: session.isAdmin,
    admin: session.isAdmin,
    expiresIn: session.expiresIn,
  });
});
