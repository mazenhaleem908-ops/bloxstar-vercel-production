import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route } from "../../../lib/http.js";
import { getSession } from "../../../lib/session.js";

/** Returns the server's view of the caller. Never trusts client-supplied identity. */
export default route(["POST", "GET"], async (req: VercelRequest, res: VercelResponse) => {
  const s = await getSession(req);
  if (!s) return res.status(401).json({ ok: false, error: "unauthorized", authenticated: false });
  return res.status(200).json({
    ok: true,
    authenticated: true,
    email: s.email,
    isAdmin: s.isAdmin,
    admin: s.isAdmin,
    expiresAt: s.expiresAt,
  });
});
