/**
 * Server-side pricing. The client NEVER supplies price, subtotal, fee, total or
 * stock: only product ids and quantities. Everything else is derived here from
 * the database catalogue.
 */
export const CARD_FEE_RATE = 0.045; // 4.5%
export const CARD_FEE_MIN_CENTS = 399; // $3.99 minimum
export const MAX_QTY_PER_LINE = 10;
export const MAX_LINES = 20;

export function cardFeeCents(subtotalCents: number): number {
  if (subtotalCents <= 0) return 0;
  return Math.max(CARD_FEE_MIN_CENTS, Math.round(subtotalCents * CARD_FEE_RATE));
}

export type RequestedLine = { id: number; qty: number };

/** Strict validation of the only client-controlled part of an order. */
export function parseLines(raw: unknown): RequestedLine[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("invalid_items");
  if (raw.length > MAX_LINES) throw new Error("too_many_items");
  const merged = new Map<number, number>();
  for (const it of raw as any[]) {
    const id = Number(it?.id ?? it?.productId ?? it?.product_id);
    const qty = Number(it?.q ?? it?.qty ?? it?.quantity ?? 1);
    if (!Number.isInteger(id) || id <= 0) throw new Error("invalid_product");
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY_PER_LINE) throw new Error("invalid_quantity");
    merged.set(id, (merged.get(id) ?? 0) + qty);
  }
  for (const [, q] of merged) {
    if (q > MAX_QTY_PER_LINE) throw new Error("invalid_quantity");
  }
  return [...merged.entries()].map(([id, qty]) => ({ id, qty }));
}

export function money(cents: number): string {
  return (cents / 100).toFixed(2);
}
