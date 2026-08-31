import type { VercelRequest } from "@vercel/node";
import { query } from "./db.js";
import { generateToken, hashToken } from "./crypto.js";
import { bearer, fail } from "./http.js";

export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export type Session = { email: string; isAdmin: boolean; expiresAt: string };

export async function isAdminEmail(email: string): Promise<boolean> {
  const rows = await query(`SELECT 1 FROM admin_emails WHERE email = $1`, [email]);
  return rows.length > 0;
}

export async function createSession(email: string, ip: string) {
  // Admin status is determined server-side from admin_emails at issue time and
  // re-verified on every privileged action. It is never taken from the client.
  const isAdmin = await isAdminEmail(email);
  const token = generateToken();
  await query(
    `INSERT INTO sessions (token_hash, email, is_admin, expires_at, ip)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5)`,
    [hashToken(token), email, isAdmin, String(SESSION_TTL_SECONDS), ip],
  );
  return { token, email, isAdmin, expiresIn: SESSION_TTL_SECONDS };
}

export async function getSession(req: VercelRequest): Promise<Session | null> {
  const token = bearer(req);
  if (!token || token.length < 20) return null;
  let hash: string;
  try {
    hash = hashToken(token);
  } catch {
    return null;
  }
  const rows = await query<{ email: string; is_admin: boolean; expires_at: string }>(
    `SELECT email, is_admin, expires_at FROM sessions
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hash],
  );
  const r = rows[0];
  if (!r) return null;
  // Re-derive admin from the source of truth so a revoked admin loses access at once.
  const isAdmin = r.is_admin && (await isAdminEmail(r.email));
  return { email: r.email, isAdmin, expiresAt: r.expires_at };
}

export async function requireSession(req: VercelRequest): Promise<Session> {
  const s = await getSession(req);
  if (!s) fail(401, "unauthorized");
  return s;
}

export async function requireAdmin(req: VercelRequest): Promise<Session> {
  const s = await requireSession(req);
  if (!s.isAdmin) fail(403, "forbidden");
  return s;
}
