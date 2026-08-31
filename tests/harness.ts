import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Minimal Vercel-Node-compatible request/response shim so the real API handlers
 * can be exercised over real HTTP (needed for genuine concurrency tests).
 */
type H = (req: any, res: any) => any;

const routes: { path: string; load: () => Promise<{ default: H }> }[] = [
  { path: "/health", load: () => import("../api/health.js") },
  { path: "/api/health", load: () => import("../api/health.js") },
  { path: "/api/public/auth/send-code", load: () => import("../api/public/auth/send-code.js") },
  { path: "/api/public/auth/verify-code", load: () => import("../api/public/auth/verify-code.js") },
  { path: "/api/public/auth/session", load: () => import("../api/public/auth/session.js") },
  { path: "/api/public/email/send", load: () => import("../api/public/email/send.js") },
  { path: "/api/public/orders", load: () => import("../api/public/orders.js") },
  { path: "/api/public/abandoned-cart", load: () => import("../api/public/abandoned-cart.js") },
  { path: "/api/public/transak-widget-url", load: () => import("../api/public/transak-widget-url.js") },
  { path: "/api/public/nowpayments/create-invoice", load: () => import("../api/public/nowpayments/create-invoice.js") },
];

export async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://local");
    const match = routes.find((r) => r.path === u.pathname);
    if (!match) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, error: "not_found" }));
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const vreq: any = req;
    vreq.query = Object.fromEntries(u.searchParams.entries());
    vreq.body = raw ? safeJson(raw) : undefined;
    const vres: any = res;
    vres.status = (code: number) => {
      res.statusCode = code;
      return vres;
    };
    vres.json = (obj: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(obj));
      return vres;
    };
    const mod = await match.load();
    await mod.default(vreq, vres);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export type Api = ReturnType<typeof makeApi>;

export function makeApi(base: string) {
  return async function api(
    method: string,
    path: string,
    opts: { body?: unknown; token?: string; ip?: string } = {},
  ) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    headers["x-forwarded-for"] = opts.ip ?? `10.0.0.${1 + Math.floor(Math.random() * 250)}`;
    const r = await fetch(base + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: r.status, body: json, headers: r.headers };
  };
}
