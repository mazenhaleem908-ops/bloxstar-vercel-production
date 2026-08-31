import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { startServer, makeApi, type Api } from "./harness.js";
import { resetDb, seedAdmin, putOtp, clearRates } from "./setup.js";
import { query, pool } from "../lib/db.js";

let api: Api;
let close: () => Promise<void>;

beforeAll(async () => {
  await resetDb();
  const s = await startServer();
  api = makeApi(s.url);
  close = s.close;
  await seedAdmin("admin@bloxistar.com");
});
afterAll(async () => {
  await close();
  await pool.end();
});
beforeEach(clearRates);

describe("OTP + session security", () => {
  it("valid OTP issues a session", async () => {
    await putOtp("user@example.com", "111111");
    const r = await api("POST", "/api/public/auth/verify-code", { body: { email: "user@example.com", code: "111111" } });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.isAdmin).toBe(false);
  });

  it("invalid OTP is rejected", async () => {
    await putOtp("user2@example.com", "222222");
    const r = await api("POST", "/api/public/auth/verify-code", { body: { email: "user2@example.com", code: "999999" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_code");
  });

  it("expired OTP is rejected", async () => {
    await putOtp("user3@example.com", "333333", { ttlSeconds: -10 });
    const r = await api("POST", "/api/public/auth/verify-code", { body: { email: "user3@example.com", code: "333333" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("code_expired");
  });

  it("OTP is one-time use (replay fails)", async () => {
    await putOtp("user4@example.com", "444444");
    const a = await api("POST", "/api/public/auth/verify-code", { body: { email: "user4@example.com", code: "444444" } });
    expect(a.status).toBe(200);
    const b = await api("POST", "/api/public/auth/verify-code", { body: { email: "user4@example.com", code: "444444" } });
    expect(b.status).toBe(400);
  });

  it("brute force is capped by max attempts", async () => {
    await putOtp("bf@example.com", "555555");
    const codes = ["000001", "000002", "000003", "000004", "000005"];
    for (const c of codes) {
      await api("POST", "/api/public/auth/verify-code", { body: { email: "bf@example.com", code: c }, ip: "10.9.9.9" });
    }
    // 6th attempt: the record is locked out even with the CORRECT code.
    const r = await api("POST", "/api/public/auth/verify-code", { body: { email: "bf@example.com", code: "555555" }, ip: "10.9.9.9" });
    expect([429, 400]).toContain(r.status);
    expect(r.body.token).toBeUndefined();
  });

  it("send-code enforces per-email cooldown (direct API, no frontend)", async () => {
    const a = await api("POST", "/api/public/auth/send-code", { body: { email: "rl@example.com" }, ip: "10.5.5.1" });
    expect(a.status).toBe(200);
    const b = await api("POST", "/api/public/auth/send-code", { body: { email: "rl@example.com" }, ip: "10.5.5.2" });
    expect(b.status).toBe(429);
    expect(b.body.error).toBe("rate_limited");
  });

  it("send-code enforces per-IP limits across different emails", async () => {
    const ip = "10.6.6.6";
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await api("POST", "/api/public/auth/send-code", { body: { email: `ip${i}@example.com` }, ip }));
    }
    expect(results.some((r) => r.status === 429)).toBe(true);
  });

  it("send-code never leaks the code", async () => {
    const r = await api("POST", "/api/public/auth/send-code", { body: { email: "leak@example.com" }, ip: "10.7.7.7" });
    expect(JSON.stringify(r.body)).not.toMatch(/\d{6}/);
  });

  it("forged session tokens are rejected", async () => {
    const r = await api("POST", "/api/public/auth/session", { token: "a".repeat(43) });
    expect(r.status).toBe(401);
  });

  it("expired sessions are rejected", async () => {
    await putOtp("exp@example.com", "666666");
    const s = await api("POST", "/api/public/auth/verify-code", { body: { email: "exp@example.com", code: "666666" } });
    await query(`UPDATE sessions SET expires_at = now() - interval '1 hour'`);
    const r = await api("POST", "/api/public/auth/session", { token: s.body.token });
    expect(r.status).toBe(401);
  });

  it("admin flag comes from the server, not the client", async () => {
    await putOtp("admin@bloxistar.com", "777777");
    const s = await api("POST", "/api/public/auth/verify-code", {
      body: { email: "admin@bloxistar.com", code: "777777", isAdmin: true, admin: true },
    });
    expect(s.body.isAdmin).toBe(true);
    await putOtp("nope@example.com", "888888");
    const c = await api("POST", "/api/public/auth/verify-code", {
      body: { email: "nope@example.com", code: "888888", isAdmin: true, admin: true },
    });
    expect(c.body.isAdmin).toBe(false);
  });

  it("SQL injection in email/code is rejected safely", async () => {
    const r = await api("POST", "/api/public/auth/verify-code", {
      body: { email: "a'; DROP TABLE orders;--@x.com", code: "1' OR '1'='1" },
    });
    expect(r.status).toBe(400);
    const t = await query(`SELECT to_regclass('public.orders') AS t`);
    expect(t[0]!.t).toBe("orders");
  });
});
