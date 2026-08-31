import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route } from "../../lib/http.js";

/**
 * Transak is REMOVED from the customer payment flow. MoonPay is the only
 * payment provider. This endpoint is retained for frontend API compatibility
 * only and fails closed — it never returns a usable widget URL.
 */
export default route(["POST"], async (_req: VercelRequest, res: VercelResponse) => {
  return res.status(410).json({ ok: false, error: "provider_disabled", provider: "transak" });
});
