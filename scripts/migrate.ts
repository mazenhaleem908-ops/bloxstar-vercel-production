import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pool, query } from "../lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "db", "migrations");

async function main() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await query<{ name: string }>(`SELECT name FROM schema_migrations`)).map((r) => r.name));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) {
      console.log(`skip   ${file}`);
      continue;
    }
    const sql = readFileSync(join(dir, file), "utf8");
    await query(sql);
    await query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
    console.log(`applied ${file}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
