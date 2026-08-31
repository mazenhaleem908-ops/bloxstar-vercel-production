import { query } from "./db.js";

export const FROM = "BloxStar <business@bloxistar.com>";
export const REPLY_TO = "business@bloxistar.com";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type MailInput = {
  to: string;
  subject: string;
  html: string;
  kind: string;
  dedupeKey?: string;
};

export type MailResult =
  | { ok: true; id: string | null; deduped?: boolean }
  | { ok: false; error: string };

/**
 * Resend is the ONLY provider. No SMTP, no Gmail, no fallback, never client-side.
 * RESEND_API_KEY is read from the server environment only.
 */
export async function sendMail(input: MailInput): Promise<MailResult> {
  const key = process.env["RESEND_API_KEY"];

  if (input.dedupeKey) {
    const dup = await query(`SELECT 1 FROM email_log WHERE dedupe_key = $1`, [input.dedupeKey]);
    if (dup.length) return { ok: true, id: null, deduped: true };
  }

  if (!key) {
    await log(input, "skipped_no_api_key", null, "RESEND_API_KEY not configured");
    return { ok: false, error: "email_provider_unconfigured" };
  }

  try {
    const r = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM,
        to: [input.to],
        reply_to: REPLY_TO,
        subject: input.subject,
        html: input.html,
      }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      await log(input, "failed", null, String(data?.message || r.status));
      return { ok: false, error: "email_send_failed" };
    }
    await log(input, "sent", data?.id ?? null, null);
    return { ok: true, id: data?.id ?? null };
  } catch (e: any) {
    await log(input, "failed", null, String(e?.message || e));
    return { ok: false, error: "email_send_failed" };
  }
}

async function log(i: MailInput, status: string, id: string | null, error: string | null) {
  await query(
    `INSERT INTO email_log (to_email, kind, subject, provider, status, provider_id, error, dedupe_key)
     VALUES ($1,$2,$3,'resend',$4,$5,$6,$7)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [i.to, i.kind, i.subject, status, id, error, i.dedupeKey ?? null],
  );
}

export async function adminEmails(): Promise<string[]> {
  const rows = await query<{ email: string }>(`SELECT email FROM admin_emails ORDER BY email`);
  return rows.map((r) => r.email);
}

export function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0b0d16;font-family:Arial,Helvetica,sans-serif;color:#e9ecff">
  <div style="max-width:560px;margin:0 auto;padding:24px">
    <h1 style="font-size:20px;color:#7c5cff;margin:0 0 16px">${escapeHtml(title)}</h1>
    <div style="background:#141830;border-radius:12px;padding:20px;font-size:14px;line-height:1.6">${bodyHtml}</div>
    <p style="font-size:12px;color:#8b90b5;margin-top:16px">BloxStar &mdash; business@bloxistar.com</p>
  </div></body></html>`;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}
