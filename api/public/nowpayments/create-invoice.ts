import type { VercelRequest, VercelResponse } from "@vercel/node";
import { route } from "../../../lib/http.js";

/**
 * NOWPayments is REMOVED from the customer payment flow. MoonPay is the only
 * payment provider. Kept for frontend API compatibility only; fails closed.
 */
export default route(["POST"], async (_req: VercelRequest, res: VercelResponse) => {
  return res.status(410).json({ ok: false, error: "provider_disabled", provider: "nowpayments" });
});
