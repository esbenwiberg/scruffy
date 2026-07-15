// Waits for Postgres to accept connections. Used by `npm run db:up`.
import pg from "pg";

const url = process.env.DATABASE_URL ?? "postgres://scruffy:scruffy@localhost:5433/scruffy";
const deadline = Date.now() + 30_000;

while (true) {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("select 1");
    await client.end();
    console.log("db ready");
    process.exit(0);
  } catch (err) {
    await client.end().catch(() => {});
    if (Date.now() > deadline) {
      console.error("db did not become ready in time:", err.message);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
