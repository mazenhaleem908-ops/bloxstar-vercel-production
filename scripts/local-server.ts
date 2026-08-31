/** Local production simulator: static frontend + the real API handlers.
 *  Vercel provides this routing in production; this exists only for testing. */
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");

const routes: Record<string, () => Promise<{ default: any }>> = {
  "/api/health": () => import("../api/health.js"),
  "/health": () => import("../api/health.js"),
  "/api/public/auth/send-code": () => import("../api/public/auth/send-code.js"),
  "/api/public/auth/verify-code": () => import("../api/public/auth/verify-code.js"),
  "/api/public/auth/session": () => import("../api/public/auth/session.js"),
  "/api/public/email/send": () => import("../api/public/email/send.js"),
  "/api/public/orders": () => import("../api/public/orders.js"),
  "/api/public/abandoned-cart": () => import("../api/public/abandoned-cart.js"),
  "/api/public/transak-widget-url": () => import("../api/public/transak-widget-url.js"),
  "/api/public/nowpayments/create-invoice": () => import("../api/public/nowpayments/create-invoice.js"),
};

const port = Number(process.env["PORT"] ?? 8787);

http
  .createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://local");
    const load = routes[u.pathname];
    if (load) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const vreq: any = req;
      vreq.query = Object.fromEntries(u.searchParams.entries());
      try {
        vreq.body = raw ? JSON.parse(raw) : undefined;
      } catch {
        vreq.body = raw;
      }
      const vres: any = res;
      vres.status = (c: number) => ((res.statusCode = c), vres);
      vres.json = (o: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(o));
        return vres;
      };
      const mod = await load();
      await mod.default(vreq, vres);
      return;
    }
    const file = u.pathname === "/" ? "index.html" : u.pathname.replace(/^\/+/, "");
    const path = join(pub, file);
    if (existsSync(path) && path.startsWith(pub)) {
      res.setHeader("Content-Type", file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream");
      res.end(readFileSync(path));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  })
  .listen(port, () => console.log(`local production simulator on http://127.0.0.1:${port}`));
