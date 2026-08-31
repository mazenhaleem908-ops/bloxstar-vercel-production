import type { VercelRequest, VercelResponse } from "@vercel/node";

export const ALLOWED_ORIGINS = [
  "https://www.bloxistar.com",
  "https://bloxistar.com",
];

export function applySecurityHeaders(req: VercelRequest, res: VercelResponse) {
  const origin = String(req.headers["origin"] || "");
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  // Never `*`.
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Cache-Control", "no-store");
}

export type Handler = (req: VercelRequest, res: VercelResponse) => Promise<unknown> | unknown;

/** Wraps a handler with CORS/security headers, method guard and safe error handling. */
export function route(methods: string[], handler: Handler): Handler {
  return async (req, res) => {
    applySecurityHeaders(req, res);
    if (req.method === "OPTIONS") return res.status(204).end();
    if (!methods.includes(String(req.method))) {
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }
    try {
      return await handler(req, res);
    } catch (err: any) {
      if (err && err.__http) {
        return res.status(err.status).json({ ok: false, error: err.code, ...(err.extra || {}) });
      }
      // Never leak internals / SQL to the client.
      console.error("[bloxstar] unhandled", err);
      return res.status(500).json({ ok: false, error: "internal_error" });
    }
  };
}

export function fail(status: number, code: string, extra?: Record<string, unknown>): never {
  const e: any = new Error(code);
  e.__http = true;
  e.status = status;
  e.code = code;
  e.extra = extra;
  throw e;
}

export function clientIp(req: VercelRequest): string {
  const xf = String(req.headers["x-forwarded-for"] || "");
  const ip = xf.split(",")[0]?.trim() || (req.socket && (req.socket as any).remoteAddress) || "";
  return String(ip).slice(0, 64);
}

export function body(req: VercelRequest): Record<string, any> {
  const b = (req as any).body;
  if (!b) return {};
  if (typeof b === "string") {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  return typeof b === "object" ? (b as Record<string, any>) : {};
}

export function normEmail(v: unknown): string {
  const s = String(v ?? "").trim().toLowerCase();
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s)) fail(400, "invalid_email");
  return s;
}

export function bearer(req: VercelRequest): string {
  const h = String(req.headers["authorization"] || "");
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (m && m[1]) {
    // A duplicated header ("Bearer x, Bearer x") must still resolve to one token.
    const parts = m[1].split(",").map((p) => p.replace(/^\s*Bearer\s+/i, "").trim()).filter(Boolean);
    if (parts.length && parts.every((p) => p === parts[0])) return parts[0]!;
    return m[1].trim();
  }
  const b = body(req);
  return String(b["token"] || b["session"] || req.query?.["token"] || "").trim();
}
