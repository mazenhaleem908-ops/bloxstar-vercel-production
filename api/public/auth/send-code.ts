import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route, body, normEmail, clientIp } from "../../../lib/http.js";
import { query } from "../../../lib/db.js";
import { generateOtp, hashOtp } from "../../../lib/crypto.js";
import { checkLimits, recordAll, OTP_SEND_LIMITS } from "../../../lib/ratelimit.js";
import { sendMail, shell, escapeHtml } from "../../../lib/mail.js";

export const OTP_TTL_SECONDS = 600;

export default route(["POST"], async (req: VercelRequest, res: VercelResponse) => {
  const b = body(req);
  const email = normEmail(b["email"]);
  const ip = clientIp(req);

  // Enforced server-side: the frontend limiter is advisory only.
  const limit = await checkLimits("otp_send", { email, ip }, OTP_SEND_LIMITS);
  if (!limit.ok) {
    res.setHeader("Retry-After", String(limit.retryAfter));
    return res.status(429).json({ ok: false, error: "rate_limited", reason: limit.code, retryAfter: limit.retryAfter });
  }
  await recordAll("otp_send", { email, ip });

  // Invalidate any outstanding codes for this email: one live code at a time.
  await query(`UPDATE otp_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL`, [email]);

  const code = generateOtp();
  await query(
    `INSERT INTO otp_codes (email, code_hash, expires_at, ip)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval, $4)`,
    [email, hashOtp(email, code), String(OTP_TTL_SECONDS), ip],
  );

  const mail = await sendMail({
    to: email,
    kind: "otp",
    subject: `Your BloxStar verification code: ${code}`,
    html: shell(
      "Your verification code",
      `<p>Use this code to sign in to BloxStar:</p>
       <p style="font-size:30px;letter-spacing:8px;font-weight:bold">${escapeHtml(code)}</p>
       <p>It expires in 10 minutes and can be used once. If you didn't request it, ignore this email.</p>`,
    ),
  });

  // Never reveal the code, and never reveal whether the address exists.
  // The response shape is uniform for every well-formed address; `sent` reports
  // provider status without changing the status code (no enumeration oracle).
  return res.status(200).json({
    ok: true,
    sent: mail.ok,
    ...(mail.ok ? {} : { warning: mail.error }),
    expiresIn: OTP_TTL_SECONDS,
  });
});
