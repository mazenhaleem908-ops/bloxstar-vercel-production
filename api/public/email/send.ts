import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route, body, clientIp } from "../../../lib/http.js";
import { requireSession } from "../../../lib/session.js";
import { checkLimits, recordAll } from "../../../lib/ratelimit.js";
import { sendMail, shell, escapeHtml, adminEmails } from "../../../lib/mail.js";

const TEMPLATES: Record<string, { subject: (d: any) => string; html: (d: any) => string; toAdmins?: boolean }> = {
  welcome: {
    subject: () => "Welcome to BloxStar",
    html: (d) => shell("Welcome to BloxStar", `<p>Hi ${escapeHtml(d.name || "there")}, your BloxStar account is ready.</p>`),
  },
  support: {
    subject: (d) => `Support request ${escapeHtml(d.ref || "")}`.trim(),
    toAdmins: true,
    html: (d) =>
      shell("Support request", `<p><b>From:</b> ${escapeHtml(d.from)}</p><p>${escapeHtml(d.message).slice(0, 4000)}</p>`),
  },
  order_status: {
    subject: (d) => `BloxStar order ${escapeHtml(d.code)} — ${escapeHtml(d.status)}`,
    html: (d) =>
      shell("Order update", `<p>Order <b>${escapeHtml(d.code)}</b> is now <b>${escapeHtml(d.status)}</b>.</p>`),
  },
};

/**
 * Not an open relay: authentication is required, only server-owned templates can be
 * rendered, and the recipient is either the authenticated user or the admin list.
 * The Resend API key never leaves the server.
 */
export default route(["POST"], async (req: VercelRequest, res: VercelResponse) => {
  const session = await requireSession(req);
  const ip = clientIp(req);
  const b = body(req);
  const kind = String(b["kind"] ?? b["template"] ?? "");
  const tpl = TEMPLATES[kind];
  if (!tpl) return res.status(400).json({ ok: false, error: "unknown_template" });

  const limit = await checkLimits(
    "email_send",
    { email: session.email, ip },
    { email: [{ windowSeconds: 3600, max: 10, code: "hourly_limit" }], ip: [{ windowSeconds: 3600, max: 30, code: "hourly_limit" }] },
  );
  if (!limit.ok) return res.status(429).json({ ok: false, error: "rate_limited" });
  await recordAll("email_send", { email: session.email, ip });

  const data = { ...(b["data"] ?? {}), from: session.email };
  const recipients = tpl.toAdmins ? await adminEmails() : [session.email];
  if (!recipients.length) return res.status(503).json({ ok: false, error: "no_recipients" });

  const results = [];
  for (const to of recipients) {
    results.push(await sendMail({ to, kind, subject: tpl.subject(data), html: tpl.html(data) }));
  }
  const ok = results.every((r) => r.ok);
  return res.status(ok ? 200 : 503).json({ ok, provider: "resend", ...(ok ? {} : { error: "email_send_failed" }) });
});
