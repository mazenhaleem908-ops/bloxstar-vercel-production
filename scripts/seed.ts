import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "../lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));

type Product = {
  id: number;
  game: string;
  name: string;
  price: number;
  tier: string;
  category: string;
  image: string;
  stock: number;
  available: boolean;
};

/**
 * Games whose entire inventory is flagged on sale. The sale price defaults to the
 * production catalogue price because no external price feed is configured; set
 * BLOXSTAR_SALE_DISCOUNT (0-0.9) to apply a uniform discount instead.
 */
const SALE_GAMES = new Set(["gag", "adoptme", "mm2"]);

const ADMIN_EMAILS = (process.env["ADMIN_EMAILS"] ?? "business@bloxistar.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

async function main() {
  const products: Product[] = JSON.parse(readFileSync(join(here, "..", "db", "products.json"), "utf8"));
  if (products.length !== 341) {
    throw new Error(`expected 341 products in catalogue, found ${products.length}`);
  }
  const discount = Math.min(0.9, Math.max(0, Number(process.env["BLOXSTAR_SALE_DISCOUNT"] ?? 0)));

  for (const p of products) {
    const cents = Math.round(p.price * 100);
    const onSale = SALE_GAMES.has(p.game);
    const saleCents = onSale ? Math.max(1, Math.round(cents * (1 - discount))) : null;
    await query(
      `INSERT INTO products (id, game, name, price_cents, tier, category, image, stock, active, on_sale, sale_price_cents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         game = EXCLUDED.game, name = EXCLUDED.name, price_cents = EXCLUDED.price_cents,
         tier = EXCLUDED.tier, category = EXCLUDED.category, image = EXCLUDED.image,
         on_sale = EXCLUDED.on_sale, sale_price_cents = EXCLUDED.sale_price_cents,
         updated_at = now()`,
      [p.id, p.game, p.name, cents, p.tier, p.category, p.image, p.stock, onSale, saleCents],
    );
  }
  // Stock is only initialised on first insert, so re-seeding never clobbers live stock.
  await query(
    `UPDATE products p SET stock = v.stock FROM (SELECT 0::int AS id, 0::int AS stock) v WHERE false`,
  );

  for (const email of ADMIN_EMAILS) {
    await query(`INSERT INTO admin_emails (email) VALUES ($1) ON CONFLICT DO NOTHING`, [email]);
  }

  const pr = await query<{ n: string }>(`SELECT count(*)::text AS n FROM products`);
  const ad = await query<{ a: string }>(`SELECT count(*)::text AS a FROM admin_emails`);
  console.log(`seeded ${pr[0]?.n} products, ${ad[0]?.a} admin email(s)`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
