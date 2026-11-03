import { readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { applyLedgerMigrations, ledgerMigrationPlan, LEDGER_TEST_DATABASE } from "../src/ledger-migrations";

/** Fixture allow-list (ADR-0021 D15). Later steps append their file's name here. */
export const LEDGER_TEST_NAMES = ["migrations", "fixture", "concurrency"] as const;
export type LedgerTestName = (typeof LEDGER_TEST_NAMES)[number];
export const databaseFor = (name: LedgerTestName) => `vynvori_m7_${name}_test`;

/** Connection budget (D15): one 100-way concurrency file may use 110; every other file caps its pool at 5. */
export const POOL_CAPS = { concurrency: 110, standard: 5 } as const;
export const RESERVED_SUPERUSER_SLOTS = 3;

type Env = Record<string, string | undefined>;
/**
 * Pure decision used by every ledger Postgres test. URL present -> run. URL absent and CI_REQUIRE_PG_TESTS=1 ->
 * the test must FAIL (never skip). Otherwise skip, which is reported NOT_RUN and never counts as a pass.
 */
export function resolveLedgerTestUrl(env: Env = process.env) {
  const url = env.M7_TEST_POSTGRES_URL || env.M2_CREATIVE_DATABASE_URL || undefined;
  const required = env.CI_REQUIRE_PG_TESTS === "1";
  return { url, required, skip: !url && !required };
}
export const ledgerTarget = resolveLedgerTestUrl();

/** Throws unless the URL is a loopback synthetic-user target and the database name passes the allow-list. */
export function assertDisposableTarget(connection: string, database: string) {
  let url: URL;
  try { url = new URL(connection); } catch { throw new Error("Refusing non-disposable database"); } // never echo the string (may hold a password)
  // pg-connection-string lets query parameters (host, user, port, options, ssl...) override the URL authority, so none are allowed.
  if (url.search !== "" || url.hash !== "" || url.hostname !== "127.0.0.1" || url.username !== "synthetic" || !LEDGER_TEST_DATABASE.test(database)
    || !(LEDGER_TEST_NAMES as readonly string[]).some(name => database === databaseFor(name as LedgerTestName))) throw new Error("Refusing non-disposable database");
  return url;
}

/** Creates (drop + create) the caller's disposable database, rebuilds vynvori_identity, applies the ledger plan. */
export async function freshLedger(name: LedgerTestName, connection = ledgerTarget.url): Promise<Client> {
  if (!connection) throw new Error("CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const database = databaseFor(name), url = assertDisposableTarget(connection, database);
  const admin = new URL(url.toString()); admin.pathname = "/postgres";
  const adminClient = new Client({ connectionString: admin.toString() }); await adminClient.connect();
  try {
    await adminClient.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE ${database}`);
  } finally { await adminClient.end(); }
  url.pathname = "/" + database;
  const client = new Client({ connectionString: url.toString() }); await client.connect();
  try { await rebuild(client, database); } catch (error) { await client.end().catch(() => undefined); throw error; } // never leave a socket that hangs the runner
  return client;
}
async function rebuild(client: Client, database: string) {
  const plan = JSON.parse(readFileSync(new URL("../auth-migrations/plan.json", import.meta.url), "utf8")) as { migrations: { file: string }[] };
  for (const migration of plan.migrations) await client.query(readFileSync(new URL("../auth-migrations/" + migration.file, import.meta.url), "utf8"));
  await applyLedgerMigrations(client, { database, role: "synthetic", planSha256: ledgerMigrationPlan().digest });
}
export async function dropLedger(name: LedgerTestName, connection = ledgerTarget.url) {
  if (!connection) return;
  const database = databaseFor(name), url = assertDisposableTarget(connection, database); url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() }); await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
}

/**
 * Pool sized by D15. The cap is bounded by SHOW max_connections minus the reserved superuser slots; when the server
 * limit is below the requested cap the result is `degraded` (the caller reports the 100-way row NOT_RUN, or fails
 * under CI_REQUIRE_PG_TESTS=1).
 */
export async function ledgerPool(name: LedgerTestName, kind: keyof typeof POOL_CAPS, connection = ledgerTarget.url) {
  if (!connection) throw new Error("no test database configured");
  const database = databaseFor(name), url = assertDisposableTarget(connection, database); url.pathname = "/" + database;
  const probe = new Client({ connectionString: url.toString() }); await probe.connect();
  let serverMax: number; try { serverMax = Number((await probe.query("SHOW max_connections")).rows[0].max_connections); } finally { await probe.end(); }
  const sized = poolBudget(serverMax, kind);
  return { pool: new Pool({ connectionString: url.toString(), max: sized.max }), ...sized, serverMax };
}
/** Pure D15 sizing: the cap clamped to max_connections minus the reserved superuser slots; degraded when the cap does not fit. */
export function poolBudget(serverMax: number, kind: keyof typeof POOL_CAPS) {
  const cap = POOL_CAPS[kind], budget = serverMax - RESERVED_SUPERUSER_SLOTS;
  return { max: Math.min(cap, Math.max(1, budget)), degraded: budget < cap };
}
