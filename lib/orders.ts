import type { PoolClient } from "pg";
import { query, tx } from "./db.js";
import { cardFeeCents, parseLines, type RequestedLine } from "./pricing.js";
import { generateOrderCode } from "./crypto.js";

export type OrderRow = {
  id: string;
  code: string;
  intent_id: string;
  email: string;
  roblox_user: string;
  game: string;
  subtotal_cents: number;
  fee_cents: number;
  total_cents: number;
  method: string;
  status: string;
  paid: boolean;
  stock_reserved: boolean;
  created_at: string;
};

export class OrderError extends Error {
  constructor(
    public code: string,
    public status = 400,
    public extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

async function event(c: PoolClient, orderId: string | null, ev: string, actor: string, ip: string, detail: any = {}) {
  await c.query(
    `INSERT INTO order_events (order_id, event, actor, ip, detail) VALUES ($1,$2,$3,$4,$5)`,
    [orderId, ev, actor, ip, JSON.stringify(detail)],
  );
}

/**
 * Atomic order creation.
 *  - price/fee/total come only from the DB catalogue
 *  - stock is locked with SELECT ... FOR UPDATE and reserved exactly once
 *  - intent_id is unique => replay / duplicate submissions are rejected
 */
export async function createOrder(input: {
  email: string;
  intentId: string;
  robloxUser?: string;
  game?: string;
  items: unknown;
  ip: string;
}): Promise<{ order: OrderRow; items: any[] }> {
  let lines: RequestedLine[];
  try {
    lines = parseLines(input.items);
  } catch (e: any) {
    throw new OrderError(String(e.message || "invalid_items"), 400);
  }
  const intentId = String(input.intentId || "").trim();
  if (!/^[A-Za-z0-9_.:-]{8,80}$/.test(intentId)) throw new OrderError("invalid_intent", 400);

  return tx(async (c) => {
    // Reject replays before doing any work.
    const existing = await c.query(`SELECT id, code FROM orders WHERE intent_id = $1`, [intentId]);
    if (existing.rows.length) throw new OrderError("duplicate_intent", 409, { code: existing.rows[0].code });

    // Deterministic lock order avoids deadlocks under concurrency.
    const ids = lines.map((l) => l.id).sort((a, b) => a - b);
    const prods = await c.query(
      `SELECT id, name, price_cents, sale_price_cents, on_sale, stock, active
         FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    if (prods.rows.length !== ids.length) throw new OrderError("invalid_product", 400);

    const byId = new Map<number, any>(prods.rows.map((p: any) => [Number(p.id), p]));
    let subtotal = 0;
    const priced: any[] = [];
    for (const l of lines) {
      const p = byId.get(l.id);
      if (!p || !p.active) throw new OrderError("invalid_product", 400);
      if (p.stock < l.qty) throw new OrderError("out_of_stock", 409, { productId: l.id, available: p.stock });
      const unit = p.on_sale && p.sale_price_cents != null ? p.sale_price_cents : p.price_cents;
      const line = unit * l.qty;
      subtotal += line;
      priced.push({ productId: l.id, name: p.name, qty: l.qty, unitCents: unit, lineCents: line });
    }
    if (subtotal <= 0) throw new OrderError("invalid_items", 400);

    const fee = cardFeeCents(subtotal);
    const total = subtotal + fee;

    // Reserve stock exactly once, atomically, never below zero.
    for (const l of lines) {
      const r = await c.query(
        `UPDATE products SET stock = stock - $2, updated_at = now()
          WHERE id = $1 AND stock >= $2 RETURNING stock`,
        [l.id, l.qty],
      );
      if (!r.rows.length) throw new OrderError("out_of_stock", 409, { productId: l.id });
    }

    const code = generateOrderCode();
    const ins = await c.query(
      `INSERT INTO orders (code, intent_id, email, roblox_user, game, subtotal_cents, fee_cents,
                           total_cents, method, status, paid, stock_reserved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'moonpay','pending_payment',false,true)
       RETURNING *`,
      [code, intentId, input.email, String(input.robloxUser ?? "").slice(0, 64),
       String(input.game ?? "").slice(0, 32), subtotal, fee, total],
    );
    const order = ins.rows[0] as OrderRow;
    for (const p of priced) {
      await c.query(
        `INSERT INTO order_items (order_id, product_id, name, qty, unit_cents, line_cents)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [order.id, p.productId, p.name, p.qty, p.unitCents, p.lineCents],
      );
    }
    await event(c, order.id, "created", input.email, input.ip, { subtotal, fee, total });
    return { order, items: priced };
  });
}

/** Admin-only manual payment confirmation. Idempotent + replay safe. */
export async function confirmOrder(code: string, actor: string, ip: string) {
  return tx(async (c) => {
    const r = await c.query(`SELECT * FROM orders WHERE code = $1 FOR UPDATE`, [code]);
    const o = r.rows[0] as OrderRow | undefined;
    if (!o) throw new OrderError("not_found", 404);
    if (o.status === "cancelled") throw new OrderError("order_cancelled", 409);
    if (o.paid) {
      // Idempotent: no second stock deduction, no second state change.
      await event(c, o.id, "confirm_replay_ignored", actor, ip);
      return { order: o, alreadyPaid: true };
    }
    const up = await c.query(
      `UPDATE orders SET paid = true, paid_at = now(), status = 'confirmed',
              confirmed_by = $2, updated_at = now()
        WHERE id = $1 AND paid = false AND status <> 'cancelled' RETURNING *`,
      [o.id, actor],
    );
    if (!up.rows.length) throw new OrderError("conflict", 409);
    // Stock was already reserved (deducted) exactly once at creation time,
    // so confirmation must not deduct again.
    await event(c, o.id, "confirmed", actor, ip);
    return { order: up.rows[0] as OrderRow, alreadyPaid: false };
  });
}

/** Cancellation restores reserved stock exactly once. */
export async function cancelOrder(code: string, actor: string, ip: string) {
  return tx(async (c) => {
    const r = await c.query(`SELECT * FROM orders WHERE code = $1 FOR UPDATE`, [code]);
    const o = r.rows[0] as OrderRow | undefined;
    if (!o) throw new OrderError("not_found", 404);
    if (o.status === "cancelled") {
      await event(c, o.id, "cancel_replay_ignored", actor, ip);
      return { order: o, alreadyCancelled: true };
    }
    if (o.stock_reserved) {
      const items = await c.query(`SELECT product_id, qty FROM order_items WHERE order_id = $1`, [o.id]);
      for (const it of items.rows) {
        await c.query(`UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1`, [
          it.product_id,
          it.qty,
        ]);
      }
    }
    const up = await c.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = now(), stock_reserved = false,
              paid = false, updated_at = now()
        WHERE id = $1 AND status <> 'cancelled' RETURNING *`,
      [o.id],
    );
    await event(c, o.id, "cancelled", actor, ip);
    return { order: (up.rows[0] ?? o) as OrderRow, alreadyCancelled: false };
  });
}

export async function orderWithItems(code: string) {
  const rows = await query<OrderRow>(`SELECT * FROM orders WHERE code = $1`, [code]);
  const o = rows[0];
  if (!o) return null;
  const items = await query(`SELECT product_id, name, qty, unit_cents, line_cents FROM order_items WHERE order_id = $1`, [o.id]);
  return { ...o, items };
}

export function publicOrder(o: any) {
  return {
    code: o.code,
    email: o.email,
    game: o.game,
    robloxUser: o.roblox_user,
    subtotal: Number(o.subtotal_cents) / 100,
    fee: Number(o.fee_cents) / 100,
    total: Number(o.total_cents) / 100,
    method: o.method,
    status: o.status,
    paid: o.paid,
    createdAt: o.created_at,
    items: (o.items ?? []).map((i: any) => ({
      id: i.product_id,
      name: i.name,
      q: i.qty,
      price: Number(i.unit_cents) / 100,
      line: Number(i.line_cents) / 100,
    })),
  };
}
