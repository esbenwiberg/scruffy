import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, withTransaction, type Pool } from "./db.js";

/**
 * Minimal forward-only migration runner. Applies every `*.sql` file in
 * `migrations/` in lexical order exactly once, each in its own transaction, and
 * records applied names in `schema_migrations`. One migration authority.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

export async function migrate(pool: Pool): Promise<string[]> {
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const name of files) {
    const already = await pool.query("select 1 from schema_migrations where name = $1", [name]);
    if ((already.rowCount ?? 0) > 0) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    await withTransaction(pool, async (client) => {
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [name]);
    });
    applied.push(name);
  }
  return applied;
}

// Allow `npm run db:migrate`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = createPool();
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
  } finally {
    await pool.end();
  }
}
