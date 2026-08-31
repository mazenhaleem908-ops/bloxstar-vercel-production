import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { startServer, makeApi, type Api } from "./harness.js";
import { resetDb, seedProducts, seedAdmin, clearRates, login, stockOf } from "./setup.js";
import { pool, query } from "../lib/db.js";
import { cardFeeCents } from "../lib/pricing.js";

let api: Api;
let close: () => Promise<void>;
let userToken: string;
let adminToken: string;
let otherToken: string;

const intent = () => `int-${Math.random().toString(36).slice(2)}-${Date.now()}`;

beforeAll(async () => {
  await resetDb();
  const s = await startServer();
  api = makeApi(s.url);
  close = s.close;
  await seedAdmin("admin@bloxistar.com");
  await seedProducts([
    { id: 1, name: "Chroma Luger", price: 10.0, stock: 50 },
    { id: 2, name: "Bat Dragon", price: 190.72, stock: 3, game: "adoptme" },
    { id: 3, name: "Out of stock item", price: 5, stock: 0 },
  ]);
  userToken = await login(api, "buyer@example.com");
  otherToken = await login(api, "other@example.com");
  adminToken = await login(api, "admin@bloxistar.com");
});
afterAll(async () => {
  await close();
  await pool.end();
});
beforeEach(clearRates);

async function place(token: string, items: any[], extra: any = {}) {
  return api("POST", "/api/public/orders", { token, body: { intentId: intent(), items, ...extra } });
}

describe("pricing", () => {
  it("card fee is max(4.5%, $3.99)", () => {
    expect(cardFeeCents(1000)).toBe(399);
    expect(cardFeeCents(10000)).toBe(450);
    expect(cardFeeCents(20000)).toBe(900);
  });
});

describe("order creation & tampering", () => {
  it("creates an order with server-side pricing", async () => {
    const r = await place(userToken, [{ id: 1, q: 2 }]);
    expect(r.status).toBe(201);
    expect(r.body.order.subtotal).toBe(20);
    expect(r.body.order.fee).toBe(3.99);
    expect(r.body.order.total).toBe(23.99);
    expect(r.body.order.status).toBe("pending_payment");
    expect(r.body.order.paid).toBe(false);
    expect(r.body.order.code).toMatch(/^BS-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  });

  it("ignores client price/subtotal/total/fee tampering", async () => {
    const r = await place(userToken, [{ id: 1, q: 1, price: 0.01, p: 0.01 }], {
      subtotal: 0.01,
      total: 0.01,
      fee: 0,
      price: 0.01,
    });
    expect(r.status).toBe(201);
    expect(r.body.order.subtotal).toBe(10);
    expect(r.body.order.total).toBe(13.99);
  });

  it("ignores client paid/status/admin/paymentVerified injection", async () => {
    const r = await place(userToken, [{ id: 1, q: 1 }], {
      paid: true,
      status: "confirmed",
      admin: true,
      isAdmin: true,
      paymentVerified: true,
    });
    expect(r.body.order.paid).toBe(false);
    expect(r.body.order.status).toBe("pending_payment");
  });

  it("ignores client stock tampering", async () => {
    const before = await stockOf(3);
    const r = await place(userToken, [{ id: 3, q: 1, stock: 999 }]);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("out_of_stock");
    expect(await stockOf(3)).toBe(before);
  });

  it("rejects zero, negative, fractional and oversized quantities", async () => {
    for (const q of [0, -1, -100, 1.5, 11, 1e9]) {
      const r = await place(userToken, [{ id: 1, q }]);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_quantity");
    }
  });

  it("rejects invalid product ids", async () => {
    for (const id of [999999, 0, -3, "abc"]) {
      const r = await place(userToken, [{ id, q: 1 }]);
      expect([400, 409]).toContain(r.status);
      expect(r.body.order).toBeUndefined();
    }
  });

  it("rejects empty carts", async () => {
    const r = await place(userToken, []);
    expect(r.status).toBe(400);
  });

  it("rejects duplicate intent ids (replay protection)", async () => {
    const id = intent();
    const a = await api("POST", "/api/public/orders", { token: userToken, body: { intentId: id, items: [{ id: 1, q: 1 }] } });
    const b = await api("POST", "/api/public/orders", { token: userToken, body: { intentId: id, items: [{ id: 1, q: 1 }] } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    expect(b.body.error).toBe("duplicate_intent");
  });

  it("requires authentication", async () => {
    const r = await api("POST", "/api/public/orders", { body: { intentId: intent(), items: [{ id: 1, q: 1 }] } });
    expect(r.status).toBe(401);
  });
});

describe("stock integrity", () => {
  it("stock=3 with 8 concurrent buyers: exactly 3 succeed, never negative", async () => {
    await query(`UPDATE products SET stock = 3 WHERE id = 2`);
    const attempts = Array.from({ length: 8 }, () => place(userToken, [{ id: 2, q: 1 }]));
    const results = await Promise.all(attempts);
    const ok = results.filter((r) => r.status === 201).length;
    const failed = results.filter((r) => r.status === 409 && r.body.error === "out_of_stock").length;
    expect(ok).toBe(3);
    expect(failed).toBe(5);
    expect(await stockOf(2)).toBe(0);
  });

  it("cancelling restores stock exactly once", async () => {
    await query(`UPDATE products SET stock = 5 WHERE id = 1`);
    const r = await place(userToken, [{ id: 1, q: 2 }]);
    expect(await stockOf(1)).toBe(3);
    const code = r.body.order.code;
    const c1 = await api("PATCH", "/api/public/orders", { token: adminToken, body: { code, action: "cancel" } });
    const c2 = await api("PATCH", "/api/public/orders", { token: adminToken, body: { code, action: "cancel" } });
    expect(c1.status).toBe(200);
    expect(c2.body.idempotent).toBe(true);
    expect(await stockOf(1)).toBe(5);
  });

  it("confirming twice does not deduct stock twice", async () => {
    await query(`UPDATE products SET stock = 5 WHERE id = 1`);
    const r = await place(userToken, [{ id: 1, q: 1 }]);
    const code = r.body.order.code;
    expect(await stockOf(1)).toBe(4);
    const a = await api("PATCH", "/api/public/orders", { token: adminToken, body: { code, action: "confirm" } });
    const b = await api("PATCH", "/api/public/orders", { token: adminToken, body: { code, action: "confirm" } });
    expect(a.body.order.paid).toBe(true);
    expect(b.body.idempotent).toBe(true);
    expect(await stockOf(1)).toBe(4);
  });
});

describe("authorization", () => {
  it("anonymous cannot confirm or cancel", async () => {
    await query(`UPDATE products SET stock = 5 WHERE id = 1`);
    const r = await place(userToken, [{ id: 1, q: 1 }]);
    const code = r.body.order.code;
    for (const action of ["confirm", "cancel"]) {
      const x = await api("PATCH", "/api/public/orders", { body: { code, action } });
      expect(x.status).toBe(401);
    }
  });

  it("a customer cannot confirm their own order as paid", async () => {
    const r = await place(userToken, [{ id: 1, q: 1 }]);
    const x = await api("PATCH", "/api/public/orders", {
      token: userToken,
      body: { code: r.body.order.code, action: "confirm", admin: true, isAdmin: true },
    });
    expect(x.status).toBe(403);
    const check = await api("GET", `/api/public/orders?code=${r.body.order.code}`, { token: userToken });
    expect(check.body.order.paid).toBe(false);
  });

  it("a customer cannot read or cancel another customer's order (IDOR)", async () => {
    const r = await place(userToken, [{ id: 1, q: 1 }]);
    const code = r.body.order.code;
    const read = await api("GET", `/api/public/orders?code=${code}`, { token: otherToken });
    expect(read.status).toBe(404);
    const cancel = await api("PATCH", "/api/public/orders", { token: otherToken, body: { code, action: "cancel" } });
    expect(cancel.status).toBe(403);
  });

  it("GET only lists the caller's own orders", async () => {
    const list = await api("GET", "/api/public/orders", { token: otherToken });
    expect(list.status).toBe(200);
    expect(list.body.orders.every((o: any) => o.email === "other@example.com")).toBe(true);
  });

  it("a customer cannot escalate to the admin listing", async () => {
    const list = await api("GET", "/api/public/orders?all=1", { token: userToken });
    expect(list.body.orders.every((o: any) => o.email === "buyer@example.com")).toBe(true);
  });

  it("a forged admin token is rejected", async () => {
    const r = await place(userToken, [{ id: 1, q: 1 }]);
    const x = await api("PATCH", "/api/public/orders", {
      token: "forged-" + "x".repeat(40),
      body: { code: r.body.order.code, action: "confirm" },
    });
    expect(x.status).toBe(401);
  });

  it("admin can confirm; order only becomes paid after that", async () => {
    const r = await place(userToken, [{ id: 1, q: 1 }]);
    expect(r.body.order.paid).toBe(false);
    const x = await api("PATCH", "/api/public/orders", {
      token: adminToken,
      body: { code: r.body.order.code, action: "confirm" },
    });
    expect(x.status).toBe(200);
    expect(x.body.order.paid).toBe(true);
    expect(x.body.order.status).toBe("confirmed");
  });

  it("a customer cannot cancel an already paid order", async () => {
    await query(`UPDATE products SET stock = 5 WHERE id = 1`);
    const r = await place(userToken, [{ id: 1, q: 1 }]);
    await api("PATCH", "/api/public/orders", { token: adminToken, body: { code: r.body.order.code, action: "confirm" } });
    const x = await api("PATCH", "/api/public/orders", { token: userToken, body: { code: r.body.order.code, action: "cancel" } });
    expect(x.status).toBe(403);
  });

  it("audit events are recorded", async () => {
    const rows = await query(`SELECT count(*)::int AS n FROM order_events WHERE event = 'confirmed'`);
    expect((rows[0] as any).n).toBeGreaterThan(0);
  });
});

describe("disabled payment providers", () => {
  it("transak fails closed", async () => {
    const r = await api("POST", "/api/public/transak-widget-url", { body: { amount: 10 } });
    expect(r.status).toBe(410);
    expect(r.body.error).toBe("provider_disabled");
  });
  it("nowpayments fails closed", async () => {
    const r = await api("POST", "/api/public/nowpayments/create-invoice", { body: { amount: 10 } });
    expect(r.status).toBe(410);
  });
});

describe("misc endpoints", () => {
  it("health is safe and reports product count", async () => {
    const r = await api("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("healthy");
    expect(JSON.stringify(r.body)).not.toMatch(/postgres|password|key/i);
  });

  it("abandoned cart recomputes totals server-side", async () => {
    const r = await api("POST", "/api/public/abandoned-cart", {
      body: { email: "cart@example.com", items: [{ id: 1, q: 2 }], total: 0.01 },
    });
    expect(r.status).toBe(201);
    const rows = await query<{ total_cents: number }>(`SELECT total_cents FROM abandoned_carts ORDER BY id DESC LIMIT 1`);
    expect(Number(rows[0]!.total_cents)).toBe(2000);
  });

  it("email/send is not an open relay", async () => {
    const anon = await api("POST", "/api/public/email/send", { body: { kind: "welcome", to: "victim@example.com" } });
    expect(anon.status).toBe(401);
    const bad = await api("POST", "/api/public/email/send", { token: userToken, body: { kind: "arbitrary_html", html: "<b>x</b>" } });
    expect(bad.status).toBe(400);
  });

  it("CORS never returns a wildcard origin", async () => {
    const r = await api("GET", "/health");
    expect(r.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});
