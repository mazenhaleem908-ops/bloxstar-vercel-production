import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route, body, clientIp } from "../../lib/http.js";
import { query } from "../../lib/db.js";
import { requireSession } from "../../lib/session.js";
import { checkLimits, recordAll } from "../../lib/ratelimit.js";
import { createOrder, confirmOrder, cancelOrder, orderWithItems, publicOrder, OrderError } from "../../lib/orders.js";
import { sendMail, shell, escapeHtml, adminEmails } from "../../lib/mail.js";
import { money } from "../../lib/pricing.js";

export default route(["POST", "GET", "PATCH"], async (req: VercelRequest, res: VercelResponse) => {
  const session = await requireSession(req);
  const ip = clientIp(req);

  if (req.method === "GET") {
    const code = String(req.query?.["code"] ?? "");
    if (code) {
      const o = await orderWithItems(code);
      // IDOR protection: a customer may only read their own orders.
      if (!o || (!session.isAdmin && o.email !== session.email)) {
        return res.status(404).json({ ok: false, error: "not_found" });
      }
      return res.status(200).json({ ok: true, order: publicOrder(o) });
    }
    const all = session.isAdmin && String(req.query?.["all"] ?? "") === "1";
    const rows = await query(
      `SELECT o.*, COALESCE(
                 (SELECT json_agg(i.* ORDER BY i.id) FROM order_items i WHERE i.order_id = o.id),
                 '[]'::json) AS items
         FROM orders o
        ${all ? "" : "WHERE o.email = $1"}
        ORDER BY o.created_at DESC LIMIT 200`,
      all ? [] : [session.email],
    );
    return res.status(200).json({ ok: true, orders: rows.map(publicOrder) });
  }

  if (req.method === "POST") {
    const limit = await checkLimits(
      "order_create",
      { email: session.email, ip },
      { email: [{ windowSeconds: 3600, max: 20, code: "hourly_limit" }], ip: [{ windowSeconds: 3600, max: 60, code: "hourly_limit" }] },
    );
    if (!limit.ok) return res.status(429).json({ ok: false, error: "rate_limited" });
    await recordAll("order_create", { email: session.email, ip });

    const b = body(req);
    // Client-supplied price / subtotal / total / fee / paid / status / admin /
    // stock / paymentVerified fields are ignored entirely.
    try {
      const { order } = await createOrder({
        email: session.email,
        intentId: String(b["intentId"] ?? b["intent_id"] ?? b["id"] ?? ""),
        robloxUser: b["user"] ?? b["robloxUser"],
        game: b["game"],
        items: b["items"],
        ip,
      });
      const full = await orderWithItems(order.code);
      void notifyCreated(full);
      return res.status(201).json({ ok: true, order: publicOrder(full) });
    } catch (e) {
      if (e instanceof OrderError) return res.status(e.status).json({ ok: false, error: e.code, ...e.extra });
      throw e;
    }
  }

  // PATCH: confirm / cancel
  const b = body(req);
  const code = String(b["code"] ?? req.query?.["code"] ?? "");
  const action = String(b["action"] ?? "");
  if (!code) return res.status(400).json({ ok: false, error: "missing_code" });

  const existing = await orderWithItems(code);
  if (!existing) return res.status(404).json({ ok: false, error: "not_found" });

  try {
    if (action === "confirm") {
      // Manual MoonPay verification: ONLY a server-verified admin may mark paid.
      if (!session.isAdmin) return res.status(403).json({ ok: false, error: "forbidden" });
      const r = await confirmOrder(code, session.email, ip);
      const full = await orderWithItems(code);
      if (!r.alreadyPaid) void notifyStatus(full, "confirmed");
      return res.status(200).json({ ok: true, order: publicOrder(full), idempotent: r.alreadyPaid });
    }
    if (action === "cancel") {
      const owner = existing.email === session.email;
      if (!session.isAdmin && !owner) return res.status(403).json({ ok: false, error: "forbidden" });
      if (!session.isAdmin && existing.paid) return res.status(403).json({ ok: false, error: "forbidden" });
      const r = await cancelOrder(code, session.email, ip);
      const full = await orderWithItems(code);
      if (!r.alreadyCancelled) void notifyStatus(full, "cancelled");
      return res.status(200).json({ ok: true, order: publicOrder(full), idempotent: r.alreadyCancelled });
    }
  } catch (e) {
    if (e instanceof OrderError) return res.status(e.status).json({ ok: false, error: e.code, ...e.extra });
    throw e;
  }
  return res.status(400).json({ ok: false, error: "unknown_action" });
});

async function notifyCreated(o: any) {
  if (!o) return;
  const lines = o.items
    .map((i: any) => `<li>${escapeHtml(i.name)} &times; ${i.qty} — $${money(i.line_cents)}</li>`)
    .join("");
  const html = shell(
    "Order received",
    `<p>Order <b>${escapeHtml(o.code)}</b> is <b>pending payment</b>.</p><ul>${lines}</ul>
     <p>Subtotal $${money(o.subtotal_cents)}<br>Card fee $${money(o.fee_cents)}<br><b>Total $${money(o.total_cents)}</b></p>
     <p>Your items are delivered after our team verifies the payment.</p>`,
  );
  await sendMail({ to: o.email, kind: "order_created", subject: `BloxStar order ${o.code} received`, html, dedupeKey: `order_created|${o.code}` });
  for (const a of await adminEmails()) {
    await sendMail({
      to: a,
      kind: "admin_new_order",
      subject: `New BloxStar order ${o.code} — $${money(o.total_cents)}`,
      html: shell("New order", `<p>${escapeHtml(o.email)} placed order <b>${escapeHtml(o.code)}</b> for $${money(o.total_cents)}. Verify the MoonPay payment, then confirm it in admin.</p>`),
      dedupeKey: `admin_new_order|${o.code}|${a}`,
    });
  }
}

async function notifyStatus(o: any, status: string) {
  if (!o) return;
  await sendMail({
    to: o.email,
    kind: `order_${status}`,
    subject: `BloxStar order ${o.code} ${status}`,
    html: shell("Order update", `<p>Order <b>${escapeHtml(o.code)}</b> is now <b>${escapeHtml(status)}</b>.</p>`),
    dedupeKey: `order_${status}|${o.code}`,
  });
}
