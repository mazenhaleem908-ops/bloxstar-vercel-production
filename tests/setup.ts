import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "../lib/db.js";
import { hashOtp } from "../lib/crypto.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function resetDb() {
  const sql = readFileSync(join(here, "..", "db", "migrations", "001_init.sql"), "utf8");
  await query(`DROP TABLE IF EXISTS order_events, order_items, orders, abandoned_carts,
                                   email_log, sessions, rate_events, otp_codes,
                                   admin_emails, products CASCADE`);
  await query(sql);
}

export async function seedProducts(rows: { id: number; name?: string; price: number; stock: number; game?: string }[]) {
  for (const r of rows) {
    await query(
      `INSERT INTO products (id, game, name, price_cents, stock, active) VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (id) DO UPDATE SET price_cents = EXCLUDED.price_cents, stock = EXCLUDED.stock`,
      [r.id, r.game ?? "mm2", r.name ?? `Item ${r.id}`, Math.round(r.price * 100), r.stock],
    );
  }
}

export async function seedAdmin(email: string) {
  await query(`INSERT INTO admin_emails (email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
}

/** Inserts a known-value OTP so the verify endpoint can be exercised end-to-end. */
export async function putOtp(email: string, code: string, opts: { ttlSeconds?: number } = {}) {
  await query(`UPDATE otp_codes SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL`, [email]);
  await query(
    `INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' seconds')::interval)`,
    [email, hashOtp(email, code), String(opts.ttlSeconds ?? 600)],
  );
}

export async function clearRates() {
  await query(`DELETE FROM rate_events`);
}

export async function login(api: any, email: string, ip = "10.1.1.1") {
  await putOtp(email, "123456");
  const r = await api("POST", "/api/public/auth/verify-code", { body: { email, code: "123456" }, ip });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
  return r.body.token as string;
}

export async function stockOf(id: number) {
  const rows = await query<{ stock: number }>(`SELECT stock FROM products WHERE id = $1`, [id]);
  return Number(rows[0]?.stock ?? -1);
}
