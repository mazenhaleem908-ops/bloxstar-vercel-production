import { Pool, type PoolClient } from "pg";

const url = process.env["DATABASE_URL"];
if (!url) {
  // Fail closed and loudly at boot rather than silently mis-serving requests.
  console.error("[bloxstar] DATABASE_URL is not set");
}

const needsSsl = !!url && !/localhost|127\.0\.0\.1/.test(url) && !/sslmode=disable/.test(url);

declare global {
  // eslint-disable-next-line no-var
  var __bloxstarPool: Pool | undefined;
}

export const pool: Pool =
  globalThis.__bloxstarPool ??
  new Pool({
    connectionString: url,
    max: Number(process.env["PGPOOL_MAX"] ?? 5),
    ssl: needsSsl ? { rejectUnauthorized: true } : undefined,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

if (process.env["NODE_ENV"] !== "production") globalThis.__bloxstarPool = pool;

export async function query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params as any[]);
  return r.rows as T[];
}

/** Runs fn inside a transaction; rolls back on any throw. */
export async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already gone */
    }
    throw e;
  } finally {
    client.release();
  }
}
