import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route } from "../lib/http.js";
import { query } from "../lib/db.js";

/** Safe health response: no versions, no secrets, no connection strings. */
export default route(["GET"], async (_req: VercelRequest, res: VercelResponse) => {
  try {
    const rows = await query<{ n: string }>(`SELECT count(*)::text AS n FROM products WHERE active`);
    return res.status(200).json({ ok: true, status: "healthy", products: Number(rows[0]?.n ?? 0) });
  } catch {
    return res.status(503).json({ ok: false, status: "degraded" });
  }
});
