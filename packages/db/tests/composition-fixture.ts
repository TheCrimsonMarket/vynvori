import { readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { applyCompositionMigrations, compositionMigrationPlan, COMPOSITION_TEST_DATABASE } from "../src/composition-migrations";

export const connectionString = process.env.M3_TEST_POSTGRES_URL;

/** Fixture allow-list (ADR-0022 D8). Later steps append their file's name here. */
export const COMPOSITION_TEST_NAMES = ["migration", "service", "ddl", "concurrency"] as const;
export type CompositionTestName = (typeof COMPOSITION_TEST_NAMES)[number];
export const databaseFor = (name: CompositionTestName) => `vynvori_m3_${name}_test`;

/** Connection budget (ADR-0022 D8): the one race file's pool is capped at 18; every other M3 DB file caps its pool at 3. */
export const POOL_CAPS = { concurrency: 18, standard: 3 } as const;
export const RESERVED_SUPERUSER_SLOTS = 3;

/**
 * Declared peak connections per M3 PostgreSQL test file (ADR-0022 D8), each figure counting that file's pool, its
 * own persistent client and one transient admin/probe connection. Checked by a static test against the 40-total
 * budget; not itself a live connection count.
 */
export const DECLARED_PEAK_CONNECTIONS = {
  "composition.test.ts": 5,
  "composition-pg.test.ts": 5,
  "composition-0002-ddl.test.ts": 5,
  "composition-0002-concurrency.test.ts": 20,
  "reserved (later M3 step)": 5,
} as const;
export const M3_CONNECTION_BUDGET = 40;

/**
 * Disposable loopback database only; the database itself already exists (created by the `m2.yml` foundation
 * workflow for `vynvori_m3_migration_test` and `vynvori_m3_service_test`). Rebuilds M1b identity DDL then applies
 * the reviewed M3 plan inside it. Signature and behaviour are unchanged by C3a: only the allow-list below widened
 * from a two-name list to the shared name pattern.
 */
export async function freshComposition(database = "vynvori_m3_migration_test"): Promise<Client> {
  const url = new URL(connectionString!); url.pathname = "/" + database;
  if (url.hostname !== "127.0.0.1" || !COMPOSITION_TEST_DATABASE.test(database) || url.username !== "synthetic") throw new Error("Refusing non-disposable database");
  const client = new Client({ connectionString: url.toString() }); await client.connect();
  await client.query("DROP SCHEMA IF EXISTS vynvori_composition CASCADE; DROP SCHEMA IF EXISTS vynvori_composition_migrations CASCADE; DROP SCHEMA IF EXISTS vynvori_identity CASCADE");
  await rebuildIdentityAndComposition(client, database);
  return client;
}

async function rebuildIdentityAndComposition(client: Client, database: string) {
  const plan = JSON.parse(readFileSync(new URL("../auth-migrations/plan.json", import.meta.url), "utf8")) as { migrations: { file: string }[] };
  for (const migration of plan.migrations) await client.query(readFileSync(new URL("../auth-migrations/" + migration.file, import.meta.url), "utf8"));
  await applyCompositionMigrations(client, { database, role: "synthetic", planSha256: compositionMigrationPlan().digest });
}

/** Only CI's port is accepted unless M3_TEST_POSTGRES_PORT_ACK explicitly names another one (a local throwaway server). */
export const DEFAULT_TEST_PORT = "5432";
type Env = Record<string, string | undefined>;
/** Throws unless the URL is a loopback synthetic-user target with an explicit allowed port and the database name passes the allow-list. */
export function assertDisposableTarget(connection: string, database: string, env: Env = process.env) {
  let url: URL;
  try { url = new URL(connection); } catch { throw new Error("Refusing non-disposable database"); } // never echo the string (may hold a password)
  // pg-connection-string lets query parameters (host, user, port, options, ssl...) override the URL authority, so none are allowed.
  if (url.search !== "" || url.hash !== "" || url.port === "" || (url.port !== DEFAULT_TEST_PORT && url.port !== env.M3_TEST_POSTGRES_PORT_ACK) || url.hostname !== "127.0.0.1" || url.username !== "synthetic" || !COMPOSITION_TEST_DATABASE.test(database)
    || !(COMPOSITION_TEST_NAMES as readonly string[]).some(name => database === databaseFor(name as CompositionTestName))) throw new Error("Refusing non-disposable database");
  return url;
}

/**
 * Server-side check, run on the maintenance connection BEFORE any DROP/CREATE DATABASE: the session user must be `synthetic` and a
 * superuser (CI's `synthetic` is the bootstrap superuser; managed databases normally give application roles no superuser). The
 * server ADDRESS is deliberately not checked: a Docker-published port shows the container-side address, not 127.0.0.1.
 */
export async function assertServerIsDisposableSynthetic(client: { query(text: string): Promise<{ rows: { u: string; su: string }[] }> }) {
  const row = (await client.query("SELECT current_user::text AS u, current_setting('is_superuser') AS su")).rows[0];
  if (!row || row.u !== "synthetic" || row.su !== "on") throw new Error("Refusing non-disposable server");
}

/**
 * Creates (drop + create) the caller's OWN disposable database through a maintenance connection (not pre-created by
 * any workflow, unlike `migration`/`service`), then rebuilds M1b identity DDL and applies the reviewed M3 plan
 * inside it. For the new per-file M3 database test files (`ddl`, `concurrency`).
 */
export async function freshCompositionDatabase(name: CompositionTestName): Promise<Client> {
  if (!connectionString) throw new Error("CI_REQUIRE_PG_TESTS=1 requires M3_TEST_POSTGRES_URL");
  const database = databaseFor(name), url = assertDisposableTarget(connectionString, database);
  const admin = new URL(url.toString()); admin.pathname = "/postgres";
  const adminClient = new Client({ connectionString: admin.toString() }); await adminClient.connect();
  try {
    await assertServerIsDisposableSynthetic(adminClient);
    await adminClient.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await adminClient.query(`CREATE DATABASE ${database}`);
  } finally { await adminClient.end(); }
  url.pathname = "/" + database;
  const client = new Client({ connectionString: url.toString() }); await client.connect();
  try { await rebuildIdentityAndComposition(client, database); } catch (error) { await client.end().catch(() => undefined); throw error; } // never leave a socket that hangs the runner
  return client;
}

export async function dropCompositionDatabase(name: CompositionTestName) {
  if (!connectionString) return;
  const database = databaseFor(name), url = assertDisposableTarget(connectionString, database); url.pathname = "/postgres";
  const admin = new Client({ connectionString: url.toString() }); await admin.connect();
  try { await assertServerIsDisposableSynthetic(admin); await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); } finally { await admin.end(); }
}

/**
 * Pool sized by the D8 budget. The cap is bounded by `SHOW max_connections` minus the reserved superuser slots; when
 * the server limit is below the requested cap the result is `degraded` (the caller reports the affected rows
 * NOT_RUN, or fails under CI_REQUIRE_PG_TESTS=1).
 */
export async function compositionPool(name: CompositionTestName, kind: keyof typeof POOL_CAPS) {
  if (!connectionString) throw new Error("no test database configured");
  const database = databaseFor(name), url = assertDisposableTarget(connectionString, database); url.pathname = "/" + database;
  const probe = new Client({ connectionString: url.toString() }); await probe.connect();
  let serverMax: number; try { serverMax = Number((await probe.query("SHOW max_connections")).rows[0].max_connections); } finally { await probe.end(); }
  const sized = poolBudget(serverMax, kind);
  const pool = new Pool({ connectionString: url.toString(), max: sized.max });
  pool.on("error", () => undefined); // an idle-client error must not crash the test process; the failing query surfaces it
  return { pool, ...sized, serverMax };
}

/** Pure D8 sizing: the cap clamped to max_connections minus the reserved superuser slots; degraded when the cap does not fit. */
export function poolBudget(serverMax: number, kind: keyof typeof POOL_CAPS) {
  const cap = POOL_CAPS[kind], budget = serverMax - RESERVED_SUPERUSER_SLOTS;
  return { max: Math.min(cap, Math.max(1, budget)), degraded: budget < cap };
}
