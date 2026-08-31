import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route, body, normEmail, clientIp } from "../../lib/http.js";
import { query } from "../../lib/db.js";
import { parseLines } from "../../lib/pricing.js";
import { checkLimits, recordAll } from "../../lib/ratelimit.js";

export default route(["POST"], async (req: VercelRequest, res: VercelResponse) => {
  const b = body(req);
  const email = normEmail(b["email"]);
  const ip = clientIp(req);

  const limit = await checkLimits(
    "abandoned_cart",
    { email, ip },
    { email: [{ windowSeconds: 3600, max: 5, code: "hourly_limit" }], ip: [{ windowSeconds: 3600, max: 20, code: "hourly_limit" }] },
  );
  if (!limit.ok) return res.status(429).json({ ok: false, error: "rate_limited" });
  await recordAll("abandoned_cart", { email, ip });

  let lines: { id: number; qty: number }[] = [];
  try {
    lines = parseLines(b["items"]);
  } catch {
    return res.status(400).json({ ok: false, error: "invalid_items" });
  }

  // Totals are recomputed server-side; the client value is discarded.
  const rows = await query<{ id: number; price_cents: number; sale_price_cents: number | null; on_sale: boolean }>(
    `SELECT id, price_cents, sale_price_cents, on_sale FROM products WHERE id = ANY($1::int[])`,
    [lines.map((l) => l.id)],
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  let total = 0;
  for (const l of lines) {
    const p = byId.get(l.id);
    if (!p) continue;
    total += (p.on_sale && p.sale_price_cents != null ? p.sale_price_cents : p.price_cents) * l.qty;
  }

  await query(`INSERT INTO abandoned_carts (email, items, total_cents) VALUES ($1, $2::jsonb, $3)`, [
    email,
    JSON.stringify(lines),
    total,
  ]);
  return res.status(201).json({ ok: true });
});
