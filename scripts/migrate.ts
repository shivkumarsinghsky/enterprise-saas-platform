/**
 * Applies migrations to the pooled cluster and every dedicated cluster.
 *
 *   MIGRATION_DATABASE_URL=postgres://owner@.../saas APP_DB_PASSWORD=... npx tsx scripts/migrate.ts
 *
 * Runs as the schema owner. Creates the RLS-restricted application role `saas_app` if missing.
 * Dedicated clusters: MIGRATION_DEDICATED_DATABASES='{"dedicated-eu-1":"postgres://owner@..."}'.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const dir = join(process.cwd(), "migrations");

export async function migrate(
  url: string,
  password: string,
  log: (m: string) => void = console.log,
): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('saas-migrations'))");
    // Roles are cluster-wide; create once, (re)set the password from the environment.
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'saas_app'");
    if (!exists.rowCount) await client.query("CREATE ROLE saas_app LOGIN NOSUPERUSER NOBYPASSRLS");
    await client.query(`ALTER ROLE saas_app PASSWORD ${client.escapeLiteral(password)}`);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())",
    );
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      if (applied.has(file)) continue;
      await client.query("BEGIN");
      await client.query(await readFile(join(dir, file), "utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      log(`applied ${file}`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('saas-migrations'))").catch(() => {});
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const appPassword = process.env.APP_DB_PASSWORD;
  if (!process.env.MIGRATION_DATABASE_URL || !appPassword) {
    console.error("MIGRATION_DATABASE_URL and APP_DB_PASSWORD are required");
    process.exit(2);
  }
  const targets: Record<string, string> = {
    pooled: process.env.MIGRATION_DATABASE_URL,
    ...JSON.parse(process.env.MIGRATION_DEDICATED_DATABASES ?? "{}"),
  };
  for (const [name, url] of Object.entries(targets)) {
    console.log(`migrating ${name}`);
    await migrate(url, appPassword);
  }
  console.log("migrations complete");
}
