import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import type { PoolClient } from "pg";
import { ensureWallet, getWalletSummary } from "../src/ledger-core";
import { ledgerMigrationPlan } from "../src/ledger-migrations";
import { assessQuoteForAuthorization, getLatestQuoteVersion, getQuote, issueQuote, renewQuote } from "../src/ledger-quotes";
import { claimPromo, getPromoClaim, markPromoOutcome } from "../src/ledger-promo";
import { authorizeQuote, getReservation, recordWorkflowRef, releaseReservation } from "../src/ledger-reservations";
import { holdReservation, settleReservation } from "../src/ledger-settlement";
import { recordVendorCostEvidence } from "../src/ledger-evidence";
import {
  beginBundleClosure, closeBundleWithForfeiture, consumeRefinementSlot, getBundleState, markRefinementPending, markRefinementUnknown, openRefinements,
  recordBundleDelivery, restoreRefinementSlot, skipRefinementSlot,
} from "../src/ledger-entitlements";
import { checkWalletInvariants, findOrphanedReservations } from "../src/ledger-invariants";
import { assertDisposableTarget, databaseFor, dropLedger, freshEmptyDatabase, grantSyntheticCredits, ledgerPoolAs, ledgerTarget, registerSyntheticGrantSource } from "./ledger-fixture";
import {
  SYNTHETIC_BUNDLE_CHARGE, SYNTHETIC_BUNDLE_HOLD, SYNTHETIC_CHARGES, SYNTHETIC_FINAL_HOLD, SYNTHETIC_HOLDS, bundleAllocations, bundleView, consent,
  currentPricePolicy, eligibilityPort, finalView, issueTestQuote, releaseEvidence, stalePricePolicy,
} from "./ledger-reservation-fixture";

/**
 * M7 S9 (M7-Plan.md §7 S9, §9): the acceptance suite, and the executable proof of docs/implementation/M7-Runtime-Grants-Proposal.md.
 *
 * Test names carry the row ids of the plan's §9 matrix (D15-T* = doc 15 acceptance targets, D06-R* = doc 06 test-matrix rows) and of
 * the binding S9 content from the ADR-0021 S2 review (S9-B*) and the grants proposal (S9-G*). The heavy 100-way cases stay in
 * ledger-concurrency.test.ts; the traceability test below checks that every row names tests that exist.
 *
 * The grants proposal's SQL blocks are read from the document and executed VERBATIM (after psql-style variable substitution) as a
 * NON-SUPERUSER executor with CREATEROLE that owns the database and applied the migrations, as on a managed database. Every library
 * call below then runs as a login that holds only the proposed role. The superuser fixture connection only creates the executor and
 * the logins, applies the identity schema, registers the synthetic grant source and funds wallets (funding is not a runtime
 * operation: HARD GATE), and runs the trigger-context probes.
 *
 * D15 budget: pools runtime 2 + funder 1 + at most two short-lived single-connection pools (checker, reconciliation) = 5, plus the
 * persistent fixture client and one short-lived real LOGIN connection: declared peak 7. Every unit value is SYNTHETIC.
 */

// ---- the proposal document -----------------------------------------------------------------------------------------------------
const PROPOSAL_URL = new URL("../../../docs/implementation/M7-Runtime-Grants-Proposal.md", import.meta.url);
const EVIDENCE_URL = new URL("../../../docs/implementation/M7-Evidence.md", import.meta.url);
const BLOCK_NAMES = ["preconditions", "roles", "runtime", "privileges", "reown", "end_state", "attach_logins", "reown_back", "drop_roles"] as const;
type BlockName = (typeof BLOCK_NAMES)[number];
const ROLE_VARIABLES = ["ledger_runtime", "ledger_wallet_definer", "ledger_reservation_definer", "ledger_package_definer", "ledger_slot_definer", "ledger_checker", "ledger_reconciliation"] as const;
const LOGIN_VARIABLES = ["ledger_runtime_login", "ledger_checker_login", "ledger_reconciliation_login"] as const;
type Vars = Record<(typeof ROLE_VARIABLES)[number] | (typeof LOGIN_VARIABLES)[number] | "ledger_database", string>;

/** Extracts the `<!-- s9-sql:NAME -->` fenced blocks. Duplicate or unknown names are a test failure, not a silent pick. */
function proposalBlocks(text = readFileSync(PROPOSAL_URL, "utf8")): Map<BlockName, string> {
  const blocks = new Map<BlockName, string>();
  for (const match of text.matchAll(/<!-- s9-sql:([a-z_]+) -->\n```sql\n([\s\S]*?)\n```/g)) {
    const name = match[1] as BlockName;
    if (!(BLOCK_NAMES as readonly string[]).includes(name)) throw new Error("unknown block " + name);
    if (blocks.has(name)) throw new Error("duplicate block " + name);
    blocks.set(name, match[2]!);
  }
  return blocks;
}
/** psql-equivalent substitution for blocks without dollar quoting: :"name" -> quoted identifier, :'name' -> quoted literal. */
function renderBlock(sql: string, vars: Partial<Vars>): string {
  if (sql.includes("$")) throw new Error("dollar quoting or parameters are not allowed in a proposal block (psql would not substitute inside them)");
  const out = sql.replace(/:(["'])([a-z_]+)\1/g, (_, quote: string, name: string) => {
    const value = (vars as Record<string, string | undefined>)[name];
    if (value === undefined) throw new Error("unset variable " + name);
    return quote === '"' ? '"' + value.replace(/"/g, '""') + '"' : "'" + value.replace(/'/g, "''") + "'";
  });
  if (/:["'][a-z_]/.test(out)) throw new Error("unsubstituted variable");
  return out;
}

// ---- traceability: plan §9 rows -> named tests --------------------------------------------------------------------------------
type Row = { id: string; title: string; w1: "yes" | "partly" | "no"; tests: readonly (readonly [file: string, name: string])[] };
const ACC = "ledger-acceptance.test.ts", CONC = "ledger-concurrency.test.ts", SETTLE = "ledger-settlement.test.ts";
const ACCEPTANCE_ROWS: readonly Row[] = [
  { id: "D15-T1", title: "100-way concurrent balance operations", w1: "yes", tests: [[CONC, "100 distinct grants in flight -> exact total, 100 revisions, no lost update"], [CONC, "S5: 100 authorizations of 100 distinct quotes against a wallet funding exactly"], [CONC, "S6: 100 mixed settle, release and hold commands over 100 distinct dispatched reservations of 10 users"], [ACC, "D15-T1"]] },
  { id: "D15-T2", title: "Duplicate and out-of-order events", w1: "yes", tests: [[CONC, "100 identical grant commands in flight -> exactly one entry"], [CONC, "S6: 100 identical settles (same key) in flight"], [ACC, "D15-T2"]] },
  { id: "D15-T3", title: "Isolation of unknown provider cost", w1: "yes", tests: [[SETTLE, "vendor-cost isolation: usage, invoice and unknown evidence"], [ACC, "D15-T3"]] },
  { id: "D15-T4", title: "Stale-quote renewal", w1: "yes", tests: [[CONC, "A3(a): 100 concurrent renewQuote calls with distinct keys"], [CONC, "S5: 50 renewals and 50 authorizations of version 1 race"], [ACC, "D15-T4"]] },
  { id: "D15-T5", title: "No negative balance / double charge / double grant", w1: "yes", tests: [[CONC, "100 same-source_ref grants under distinct keys -> exactly one wins"], [CONC, "S6: 100 mixed settle, release and hold commands on ONE dispatched reservation"], [ACC, "D15-T5"]] },
  { id: "D06-R01", title: "Simultaneous requests against a 1-credit wallet", w1: "yes", tests: [[ACC, "D06-R01"]] },
  { id: "D06-R02", title: "Duplicated payment capture", w1: "no", tests: [[ACC, "D06-R02"]] },
  { id: "D06-R03", title: "Provider timeout after billing", w1: "yes", tests: [[SETTLE, "hold: an unknown outcome"], [ACC, "D06-R03"]] },
  { id: "D06-R04", title: "Provider returns artifact but DB write fails", w1: "yes", tests: [[ACC, "D06-R04"]] },
  { id: "D06-R05", title: "Webhook replay / out-of-order", w1: "yes", tests: [[SETTLE, "out of order: evidence for a reservation that does not exist (yet)"], [ACC, "D06-R05"]] },
  { id: "D06-R06", title: "Refund after partial credit consumption", w1: "no", tests: [] },
  { id: "D06-R07", title: "Unauthorized redemption (ownership on every ID)", w1: "partly", tests: [[ACC, "D06-R07"]] },
  { id: "D06-R08", title: "Concurrent carts reuse entitlement", w1: "no", tests: [] },
  { id: "D06-R09", title: "Digital export paid then failed render", w1: "no", tests: [] },
  { id: "D06-R10", title: "Guest attempts credit purchase", w1: "yes", tests: [[ACC, "D06-R10"]] },
  { id: "D06-R11", title: "Rounding of fractional USD costs", w1: "partly", tests: [[ACC, "D06-R11"]] },
  { id: "D06-R12", title: "Package fee scenario", w1: "partly", tests: [[ACC, "D06-R12"]] },
  { id: "S9-B1", title: "Definer owners have no members; nobody can SET ROLE to one (also with pg_write_all_data)", w1: "yes", tests: [[ACC, "S9-B1"]] },
  { id: "S9-B2", title: "Owner-change procedure executable by a non-superuser; exact end state", w1: "yes", tests: [[ACC, "S9-B2"]] },
  { id: "S9-B3", title: "Rollback after the re-own: refused, then re-own back, down, up", w1: "yes", tests: [[ACC, "S9-B3"]] },
  { id: "S9-B4", title: "Trigger-context branches (TG_RELID, TG_OP, TG_WHEN, TG_LEVEL) of every trigger function", w1: "yes", tests: [[ACC, "S9-B4"]] },
  { id: "S9-B5", title: "Break-glass note", w1: "yes", tests: [[ACC, "S9-B5"]] },
  { id: "S9-B6", title: "HARD GATE on grant sources", w1: "yes", tests: [[ACC, "S9-B6"]] },
  { id: "S9-G1", title: "Proposal end state is exact", w1: "yes", tests: [[ACC, "S9-G1"]] },
  { id: "S9-G2", title: "Runtime and definer privileges are each necessary", w1: "yes", tests: [[ACC, "S9-G2"]] },
  { id: "S9-G3", title: "Checker privileges are each necessary; read-only", w1: "yes", tests: [[ACC, "S9-G3"]] },
  { id: "S9-G4", title: "Reconciliation privileges are each necessary; runtime has no vendor-cost access", w1: "yes", tests: [[ACC, "S9-G4"]] },
  { id: "S9-G5", title: "The end-state check detects deviations", w1: "yes", tests: [[ACC, "S9-G5"]] },
  { id: "S9-G6", title: "Undo returns the database to its pre-proposal privileges", w1: "yes", tests: [[ACC, "S9-G6"]] },
];

test("S9-DOC: the grants proposal is complete, parses, renders like psql, and names only real migrations, tables and definers", () => {
  const text = readFileSync(PROPOSAL_URL, "utf8");
  assert.match(text, /PROPOSAL, NOT APPLIED/, "the document says it is a proposal, not applied");
  const blocks = proposalBlocks(text);
  assert.deepEqual([...blocks.keys()], [...BLOCK_NAMES], "every block present, in runbook order");
  const vars = Object.fromEntries([...ROLE_VARIABLES, ...LOGIN_VARIABLES, "ledger_database"].map(name => [name, name + "_x"])) as Vars;
  for (const [name, sql] of blocks) {
    assert.doesNotMatch(renderBlock(sql, vars), /:["'][a-z_]/, name);
    if (/:"ledger_/.test(sql)) assert.throws(() => renderBlock(sql.replace(/:"ledger_[a-z_]+"/, ':"ledger_not_a_variable"'), vars), /unset variable/, `${name}: an unset variable is refused`);
  }
  assert.throws(() => renderBlock("SELECT $$x$$", vars), /dollar quoting/);
  const grants = [blocks.get("runtime")!, blocks.get("privileges")!, blocks.get("attach_logins")!].join("\n");
  assert.doesNotMatch(grants, /\b(DELETE|TRUNCATE|REFERENCES|TRIGGER|EXECUTE|ALL|MAINTAIN|TEMPORARY|TEMP|CREATE)\b/i, "no DELETE, TRUNCATE, REFERENCES, TRIGGER, EXECUTE, ALL, TEMP or CREATE is granted");
  assert.doesNotMatch(grants, /WITH (GRANT|ADMIN) OPTION|ON ALL (TABLES|FUNCTIONS|SEQUENCES)|DEFAULT PRIVILEGES/i);
  assert.doesNotMatch(blocks.get("runtime")!, /ledger_grant_sources|vendor_cost_evidence/, "the runtime role gets nothing on grant sources or vendor cost");
  const checkerLines = blocks.get("privileges")!.split("\n").filter(line => /TO :"ledger_checker";$/.test(line));
  assert.equal(checkerLines.length, 1);
  assert.doesNotMatch(checkerLines[0]!, /vendor_cost_evidence|INSERT|UPDATE/, "the checker gets SELECT only, and nothing on vendor cost");
  assert.match(blocks.get("privileges")!, /GRANT SELECT, INSERT ON vynvori_ledger\.vendor_cost_evidence TO :"ledger_reconciliation";/);
  for (const [name, sql] of blocks) {
    assert.doesNotMatch(sql, /PASSWORD|(?<!NO)LOGIN\b|ALTER ROLE|(?<!NO)SUPERUSER|(?<!NO)BYPASSRLS|(?<!NO)REPLICATION|(?<!NO)CREATEDB|(?<!NO)CREATEROLE/, `${name}: no password, login, role alteration or dangerous attribute`);
    if (name !== "end_state" && name !== "preconditions") assert.doesNotMatch(sql, /pg_write_all_data|pg_read_all_data|session_replication_role/, `${name}: no predefined bypass role is granted (only the checks name them)`);
  }
  const migrations = ledgerMigrationPlan().migrations;
  const journal = /HAVING coalesce\(string_agg\(a\.file, ',' ORDER BY a\.file\), ''\) <> '([^']+)'/.exec(blocks.get("preconditions")!)?.[1];
  assert.equal(journal, migrations.map(m => m.file).join(","), "step 1 pins exactly the migrations in plan.json: a new migration must update the proposal");
  const definers = [...new Set(migrations.flatMap(m => [...m.sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION vynvori_ledger\.([a-z_]+)\(\)[^;]*?SECURITY DEFINER/g)].map(x => x[1]!)))].sort();
  assert.deepEqual(definers, ["ledger_entries_apply_to_reservation", "ledger_entries_apply_to_wallet", "ledger_package_events_apply", "refinement_slot_events_apply"]);
  for (const fn of definers) {
    assert.match(blocks.get("reown")!, new RegExp(`ALTER FUNCTION vynvori_ledger\\.${fn}\\(\\) OWNER TO :"ledger_[a-z]+_definer";`), `${fn} is re-owned`);
    assert.match(blocks.get("reown_back")!, new RegExp(`ALTER FUNCTION vynvori_ledger\\.${fn}\\(\\) OWNER TO CURRENT_USER;`), `${fn} is re-owned back`);
  }
  const tables = new Set(migrations.flatMap(m => [...m.sql.matchAll(/CREATE TABLE vynvori_ledger\.([a-z_]+)\(/g)].map(x => x[1]!)));
  assert.equal(tables.size, 16);
  const sql = [...blocks.values()].join("\n");
  const named = new Set([...sql.matchAll(/vynvori_ledger\.([a-z_]+)\b(?!\()/g)].map(x => x[1]!));
  const functions = new Set(migrations.flatMap(m => [...m.sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION vynvori_ledger\.([a-z_]+)\(/g)].map(x => x[1]!)));
  for (const name of named) assert.ok(tables.has(name) || functions.has(name), `the proposal names a real table or function: ${name}`);
  for (const table of tables) assert.ok(named.has(table), `every ledger table is accounted for in the proposal blocks: ${table}`);
});

test("S9-TRACE: every plan §9 row and binding S9 item names tests that exist, and the evidence record lists every row", () => {
  const sources = new Map<string, string>();
  const read = (file: string) => { if (!sources.has(file)) sources.set(file, readFileSync(new URL("./" + file, import.meta.url), "utf8")); return sources.get(file)!; };
  const evidence = readFileSync(EVIDENCE_URL, "utf8");
  const ids = new Set<string>();
  for (const row of ACCEPTANCE_ROWS) {
    assert.ok(!ids.has(row.id), "unique row id " + row.id); ids.add(row.id);
    if (row.w1 !== "no") assert.ok(row.tests.length > 0, `${row.id} is in W1 and names at least one test`);
    for (const [file, name] of row.tests) {
      const source = read(file);
      assert.ok(file === ACC ? new RegExp(`t\\.test\\("${row.id}[ :(]`).test(source) : source.includes(name), `${row.id}: ${file} has a test named "${name}"`);
    }
    assert.match(evidence, new RegExp(`\\| ${row.id} \\|`), `M7-Evidence.md has a row for ${row.id}`);
  }
});

// ---- database tests -----------------------------------------------------------------------------------------------------------
const q = (identifier: string) => '"' + identifier.replace(/"/g, '""') + '"';
const sqlstate = (c: string, pattern?: RegExp) => (e: unknown) => ((e as { code?: string }).code === c || (e as { sqlstate?: string }).sqlstate === c) && (!pattern || pattern.test((e as Error).message));
const ledgerCode = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
let keyCounter = 0;
const key = (label: string) => `s9-${label}-${String(++keyCounter).padStart(6, "0")}-${randomUUID().slice(0, 8)}`;
const NOTICE = "rcn-s9";
const terms = (notice: string | null) => ({ customerConsentTermsVersion: "cc-1", expiryTermsVersion: "ex-1", partialRemedyTermsVersion: "pr-1", rightsNoticeVersion: "rn-1", qualityRemedyTermsVersion: "qr-1", refinementClosureNoticeVersion: notice });

/** A pg pool wrapped so that every driver error SQLSTATE is recorded (a library may map a read failure to a code without it). */
function recording(pool: Pool) {
  const codes: string[] = [];
  const note = (error: unknown) => { codes.push(String((error as { code?: string }).code ?? "")); throw error; };
  const db = {
    query: (text: string, values?: unknown[]) => pool.query(text, values).catch(note),
    connect: async () => {
      const client: PoolClient = await pool.connect();
      return { query: (text: string, values?: unknown[]) => client.query(text, values).catch(note), on: client.on.bind(client), off: client.off.bind(client), release: (destroy?: boolean) => client.release(destroy) };
    },
  };
  return { codes, db: db as unknown as Pool };
}

interface Env {
  admin: Client; exec: string; vars: Vars; database: string; suffix: string; rolesCreated: string[];
  /** Runs a proposal block as the executor (SET ROLE from the fixture login; current_user is the non-superuser executor). */
  block(name: BlockName): Promise<{ rows: Record<string, unknown>[] }>;
  asExec(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  profile(): Promise<string>;
}
/** Fresh database owned by a NON-superuser CREATEROLE executor that holds the identity grants it needs and applies the ledger migrations. */
async function setup(): Promise<Env> {
  const suffix = randomBytes(5).toString("hex"), database = databaseFor("acceptance");
  const admin = await freshEmptyDatabase("acceptance");
  const exec = "m7s9_exec_" + suffix;
  const vars = {
    ledger_database: database,
    ledger_runtime: "m7s9_runtime_" + suffix, ledger_wallet_definer: "m7s9_wallet_def_" + suffix, ledger_reservation_definer: "m7s9_reservation_def_" + suffix,
    ledger_package_definer: "m7s9_package_def_" + suffix, ledger_slot_definer: "m7s9_slot_def_" + suffix, ledger_checker: "m7s9_checker_" + suffix,
    ledger_reconciliation: "m7s9_reconciliation_" + suffix,
    ledger_runtime_login: "m7s9_rt_login_" + suffix, ledger_checker_login: "m7s9_ck_login_" + suffix, ledger_reconciliation_login: "m7s9_rc_login_" + suffix,
  } satisfies Vars;
  const rolesCreated = [exec, ...ROLE_VARIABLES.map(v => vars[v]), ...LOGIN_VARIABLES.map(v => vars[v])];
  try {
    await admin.query(`CREATE ROLE ${q(exec)} NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`);
    await admin.query(`ALTER DATABASE ${q(database)} OWNER TO ${q(exec)}`);
    for (const migration of JSON.parse(readFileSync(new URL("../auth-migrations/plan.json", import.meta.url), "utf8")).migrations as { file: string }[])
      await admin.query(readFileSync(new URL("../auth-migrations/" + migration.file, import.meta.url), "utf8"));
    await admin.query(`GRANT USAGE ON SCHEMA vynvori_identity TO ${q(exec)} WITH GRANT OPTION`);
    await admin.query(`GRANT REFERENCES, SELECT (id, issuer, subject) ON vynvori_identity.profiles TO ${q(exec)} WITH GRANT OPTION`);
  } catch (error) { await admin.end().catch(() => undefined); await dropRoles(rolesCreated); throw error; }
  const asExec = async (sql: string) => {
    await admin.query(`SET ROLE ${q(exec)}`);
    try { return await admin.query(sql) as unknown as { rows: Record<string, unknown>[] }; }
    catch (error) { await admin.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { await admin.query("RESET ROLE"); }
  };
  const blocks = proposalBlocks();
  const env: Env = {
    admin, exec, vars, database, suffix, rolesCreated, asExec,
    block: name => asExec(renderBlock(blocks.get(name)!, vars)),
    profile: async () => { const id = randomUUID(); await admin.query("INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES($1,'https://synthetic.invalid',$2)", [id, "s9-" + id]); return id; },
  };
  try { await applyMigrationsAsExecutor(asExec); } catch (error) { await teardown(env, new Set()); throw error; }
  return env;
}
/** The runner's own steps (journal schema, each migration, journal row) as the executor: the runner itself only accepts `synthetic`. */
async function applyMigrationsAsExecutor(asExec: (sql: string) => Promise<unknown>) {
  await asExec("CREATE SCHEMA vynvori_ledger_migrations; CREATE TABLE vynvori_ledger_migrations.applied(file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  for (const migration of ledgerMigrationPlan().migrations) {
    assert.match(migration.file, /^\d{4}_[a-z_]+\.sql$/); assert.match(migration.sha256, /^[0-9a-f]{64}$/);
    await asExec(migration.sql + `;\nINSERT INTO vynvori_ledger_migrations.applied(file, sha256) VALUES ('${migration.file}', '${migration.sha256}')`);
  }
}
async function dropRoles(roles: readonly string[]) {
  const url = new URL(ledgerTarget.url!); url.pathname = "/postgres";
  const cleaner = new Client({ connectionString: url.toString() }); await cleaner.connect();
  const leaked: string[] = [];
  try { for (const role of [...roles].reverse()) { try { await cleaner.query(`DROP ROLE IF EXISTS ${q(role)}`); } catch { leaked.push(role); } } } finally { await cleaner.end().catch(() => undefined); }
  return leaked;
}
/** Roles are cluster-global: drop them from the maintenance database even if the database drop threw; REPORT any that remain. */
async function teardown(env: Env | undefined, pools: Set<Pool>) {
  for (const pool of pools) await pool.end().catch(() => undefined);
  let leaked: string[] = [];
  try {
    await env?.admin.end().catch(() => undefined);
    await dropLedger("acceptance");
  } finally { if (env) leaked = await dropRoles(env.rolesCreated); }
  if (leaked.length) { console.error("LEAKED ROLES (drop manually): " + leaked.join(", ")); throw new Error("leaked cluster roles: " + leaked.join(", ")); }
}
/** Every privilege on the ledger, identity and database objects, and every function owner: compared before the proposal and after undo. */
const PRIVILEGE_SNAPSHOT = `
  SELECT 'schema ' || n.nspname AS o, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END AS g, a.privilege_type AS p
    FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a WHERE n.nspname IN ('vynvori_ledger', 'vynvori_ledger_migrations', 'vynvori_identity')
  UNION ALL SELECT 'table ' || c.oid::regclass::text, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, a.privilege_type
    FROM pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a WHERE c.relnamespace IN ('vynvori_ledger'::regnamespace, 'vynvori_identity'::regnamespace) AND c.relkind = 'r'
  UNION ALL SELECT 'column ' || c.oid::regclass::text || '.' || t.attname, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, a.privilege_type
    FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid, aclexplode(t.attacl) a WHERE c.relnamespace IN ('vynvori_ledger'::regnamespace, 'vynvori_identity'::regnamespace)
  UNION ALL SELECT 'function ' || p.proname || ' owner ' || pg_get_userbyid(p.proowner), CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, a.privilege_type
    FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.pronamespace = 'vynvori_ledger'::regnamespace
  UNION ALL SELECT 'database', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, a.privilege_type
    FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = current_database()
  ORDER BY 1, 2, 3`;

test("S9 grants proposal: applied verbatim by a non-superuser executor; exact end state; every privilege necessary; acceptance rows run as the proposed roles", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const pools = new Set<Pool>();
  let env: Env | undefined;
  try {
    env = await setup();
    const { admin, vars, exec } = env;
    const url = assertDisposableTarget(ledgerTarget.url, env.database); url.pathname = "/" + env.database;
    const openAs = async (role: string, max: number) => { const pool = await ledgerPoolAs("acceptance", role, { max }); pools.add(pool); return pool; };
    const closePool = async (pool: Pool) => { pools.delete(pool); await pool.end(); };
    const endState = async () => (await env!.block("end_state")).rows.map(r => `${r.check_name}: ${r.detail}`);
    const HARD_GATE_ROW = "HARD GATE: a grant source is registered: 1";
    const before = (await admin.query(PRIVILEGE_SNAPSHOT)).rows;

    await t.test("S9-B2: preconditions pass, then the executor (NOT a superuser; CREATEROLE; owns the database and the ledger) applies the roles, grants and re-own; the transient membership and CREATE are gone", async () => {
      const who = (await env!.asExec("SELECT current_user::text AS u, current_setting('is_superuser') AS su, (SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user) AS cr")).rows[0];
      assert.deepEqual(who, { u: exec, su: "off", cr: true }, "every block runs as the non-superuser executor");
      assert.deepEqual((await env!.block("preconditions")).rows, [], "step 1 returns zero rows on a freshly migrated database");
      for (const name of ["roles", "runtime", "privileges", "reown"] as const) await env!.block(name);
      const definerFns = (await admin.query("SELECT p.proname, pg_get_userbyid(p.proowner)::text AS o FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prosecdef ORDER BY 1")).rows;
      assert.deepEqual(definerFns, [
        { proname: "ledger_entries_apply_to_reservation", o: vars.ledger_reservation_definer }, { proname: "ledger_entries_apply_to_wallet", o: vars.ledger_wallet_definer },
        { proname: "ledger_package_events_apply", o: vars.ledger_package_definer }, { proname: "refinement_slot_events_apply", o: vars.ledger_slot_definer },
      ], "four definers, four separate roles (founder decision: separate definer roles for S5 and S7)");
      const members = (await admin.query(`SELECT g.rolname::text AS role, m.rolname::text AS member, a.admin_option AS adm, a.inherit_option AS inh, a.set_option AS st FROM pg_auth_members a
        JOIN pg_roles g ON g.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE g.rolname = ANY($1) ORDER BY 1, 2`, [ROLE_VARIABLES.map(v => vars[v])])).rows;
      assert.deepEqual(members, ROLE_VARIABLES.map(v => vars[v]).sort().map(role => ({ role, member: exec, adm: true, inh: false, st: false })), "only the creator's ADMIN-only row remains: the transient SET grant was revoked in the same transaction");
      for (const v of ["ledger_wallet_definer", "ledger_reservation_definer", "ledger_package_definer", "ledger_slot_definer"] as const)
        assert.equal((await admin.query("SELECT has_schema_privilege($1, 'vynvori_ledger', 'CREATE') AS c", [vars[v]])).rows[0].c, false, `${v} holds no CREATE`);
      assert.deepEqual(await endState(), [], "step 6 returns zero rows");
    });

    // The runtime login is a REAL login (random password generated here, never stored), so SET ROLE is tested with its own session user.
    const password = randomBytes(24).toString("hex");
    await admin.query(`CREATE ROLE ${q(vars.ledger_runtime_login)} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD '${password}'`);
    for (const login of [vars.ledger_checker_login, vars.ledger_reconciliation_login]) await admin.query(`CREATE ROLE ${q(login)} NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS`);
    await env.block("attach_logins");
    const loginClient = async (login: string, secret: string) => { const u = new URL(url.toString()); u.username = login; u.password = secret; const c = new Client({ connectionString: u.toString() }); await c.connect(); return c; };

    await t.test("S9-G1: after attaching the logins the end state is still exact (zero rows)", async () => {
      assert.deepEqual(await endState(), []);
    });

    const DEFINERS = ["ledger_wallet_definer", "ledger_reservation_definer", "ledger_package_definer", "ledger_slot_definer"] as const;
    await t.test("S9-B1: no role can act as a definer: catalog (MEMBER, USAGE, SET) for every non-superuser role, and a real LOGIN cannot SET ROLE to one, also while it holds pg_write_all_data", async () => {
      for (const d of DEFINERS) {
        const can = (await admin.query("SELECT r.rolname FROM pg_roles r WHERE NOT r.rolsuper AND r.rolname <> $1 AND (pg_has_role(r.oid, $1, 'USAGE') OR pg_has_role(r.oid, $1, 'SET'))", [vars[d]])).rows;
        assert.deepEqual(can, [], `nobody can act as ${d}`);
        for (const r of [vars.ledger_runtime, vars.ledger_runtime_login, vars.ledger_checker, vars.ledger_checker_login, vars.ledger_reconciliation, vars.ledger_reconciliation_login, ...DEFINERS.filter(x => x !== d).map(x => vars[x])])
          assert.equal((await admin.query("SELECT pg_has_role($1, $2, 'MEMBER') AS m", [r, vars[d]])).rows[0].m, false, `${r} is not a member of ${d}`);
      }
      const variant = "m7s9_rtw_login_" + env!.suffix, variantPassword = randomBytes(24).toString("hex");
      env!.rolesCreated.push(variant);
      await admin.query(`CREATE ROLE ${q(variant)} LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS PASSWORD '${variantPassword}'`);
      await env!.asExec(`GRANT ${q(vars.ledger_runtime)} TO ${q(variant)}`);
      await admin.query(`GRANT pg_write_all_data TO ${q(variant)}`);
      try {
        assert.ok((await endState()).includes(`a login holding a ledger role is too powerful: ${variant} in ${vars.ledger_runtime}`), "the end-state check reports the pg_write_all_data login");
        for (const d of DEFINERS) assert.equal((await admin.query("SELECT pg_has_role($1, $2, 'MEMBER') OR pg_has_role($1, $2, 'SET') OR pg_has_role($1, $2, 'USAGE') AS x", [variant, vars[d]])).rows[0].x, false, `pg_write_all_data variant -> ${d}`);
        for (const [login, secret] of [[vars.ledger_runtime_login, password], [variant, variantPassword]] as const) {
          const client = await loginClient(login, secret);
          try {
            assert.deepEqual((await client.query("SELECT current_user::text AS c, session_user::text AS s, current_setting('is_superuser') AS su")).rows[0], { c: login, s: login, su: "off" }, "a real login session, not the fixture superuser");
            for (const d of DEFINERS) await assert.rejects(client.query(`SET ROLE ${q(vars[d])}`), sqlstate("42501", /permission denied to set role/), `${login} cannot SET ROLE ${d}`);
            await client.query(`SET ROLE ${q(vars.ledger_runtime)}`); await client.query("RESET ROLE"); // positive control: it can become the role it holds
            await assert.rejects(client.query("CREATE TEMP TABLE s9_probe(x int)"), sqlstate("42501"), `${login}: the TEMP-trigger exploit cannot start (TEMPORARY revoked from PUBLIC)`);
            await assert.rejects(client.query("SELECT vynvori_ledger.ledger_entries_apply_to_wallet()"), sqlstate("42501"), "no EXECUTE on a definer");
          } finally { await client.end(); }
        }
      } finally {
        await admin.query(`REVOKE pg_write_all_data FROM ${q(variant)}`);
        await env!.asExec(`REVOKE ${q(vars.ledger_runtime)} FROM ${q(variant)}`);
        await admin.query(`DROP ROLE ${q(variant)}`);
      }
      assert.deepEqual(await endState(), []);
    });

    // ---- funding and the runtime scenario -----------------------------------------------------------------------------------
    const source = await registerSyntheticGrantSource(admin, "s9 synthetic source");
    const funder = new Pool({ connectionString: url.toString(), max: 1 }); funder.on("error", () => undefined); pools.add(funder);
    let funds = 0;
    const fund = (userId: string, units: number) => grantSyntheticCredits(funder, { userId, grantSourceId: source, sourceRef: `s9-funds-${++funds}`, units });
    const runtimePool = await openAs(vars.ledger_runtime_login, 2);
    const rt = recording(runtimePool);
    const buckets = async (user: string) => (await admin.query("SELECT available_units::text a, reserved_units::text r, held_for_review_units::text h, consumed_units::text c FROM vynvori_ledger.wallets WHERE user_id = $1", [user])).rows[0];

    await t.test("S9-B6: HARD GATE: steps 1 and 6 refuse a registered grant source; the runtime role holds no privilege on the registry and its grant path fails", async () => {
      assert.deepEqual(await endState(), [HARD_GATE_ROW], "the only end-state finding is the gate");
      assert.ok((await env!.block("preconditions")).rows.some(r => r.check_name === "HARD GATE: a grant source is registered"), "step 1 refuses it too");
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) assert.equal((await admin.query("SELECT has_table_privilege($1, 'vynvori_ledger.ledger_grant_sources', $2) AS x", [vars.ledger_runtime_login, p])).rows[0].x, false, p);
      const user = await env!.profile(); await ensureWallet(runtimePool, user);
      await assert.rejects(grantSyntheticCredits(runtimePool, { userId: user, grantSourceId: source, sourceRef: "s9-runtime-grant", units: 1 }), sqlstate("42501"), "the library grant path is not a runtime operation");
      await assert.rejects(runtimePool.query("INSERT INTO vynvori_ledger.ledger_grant_sources(grant_source_id, kind, label) VALUES ($1, 'synthetic_test', 'x')", [randomUUID()]), sqlstate("42501"));
      assert.deepEqual(await buckets(user), { a: "0", r: "0", h: "0", c: "0" });
    });

    const SCENARIO_FUNDS = 2 * SYNTHETIC_BUNDLE_HOLD + SYNTHETIC_FINAL_HOLD;
    /** Every runtime command kind through the REAL library, as the runtime login. Funding comes from the superuser fixture. */
    const runtimeScenario = async (db: Pool, user: string) => {
      const tag = randomUUID().slice(0, 8);
      await ensureWallet(db, user);
      await fund(user, SCENARIO_FUNDS);
      await getWalletSummary(db, user);
      const promoOp = `s9-promo-${tag}`;
      const { claim } = await claimPromo(db, { userId: user, operationId: promoOp, idempotencyKey: key("claim") });
      await markPromoOutcome(db, { userId: user, claimId: claim.claimId, idempotencyKey: key("promo"), outcome: "consumed", evidence: { operationId: promoOp, evidenceRef: "s9-promo", evidenceKind: "persisted_delivered", hasVerifiedManifestHash: true, ownerAndRightsVerified: true } });
      await getPromoClaim(db, user);
      const quoteA = `s9-a-${tag}`;
      await issueTestQuote(db, user, "bundle", quoteA);
      await renewQuote(db, { userId: user, quoteId: quoteA, expectedLatestVersionNo: 1, quoteView: bundleView(quoteA, quoteA + "-v2"), modelRef: "s5-model", allocations: bundleAllocations, idempotencyKey: key("renew") });
      await getQuote(db, user, quoteA + "-v2"); await getLatestQuoteVersion(db, user, quoteA);
      assert.deepEqual(await assessQuoteForAuthorization(db, { userId: user, quoteVersionId: quoteA + "-v2", now: new Date(), pricePolicy: currentPricePolicy }), { ok: true });
      const a = await authorizeQuote(db, { userId: user, quoteVersionId: quoteA + "-v2", idempotencyKey: key("auth"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
      for (const r of a.reservations) await recordWorkflowRef(db, { userId: user, component: "s9", reservationId: r.reservationId, workflowRef: "wf/" + randomUUID(), idempotencyKey: key("wf") });
      const [r0, r1, r2] = [a.reservations[0]!, a.reservations[1]!, a.reservations[2]!];
      await settleReservation(db, { userId: user, component: "s9", reservationId: r0.reservationId, evidence: { transition: "settle", operationId: r0.operationId, evidenceKind: "persisted_delivered", evidenceRef: "s9-settle", hasVerifiedManifestHash: true, ownerAndRightsVerified: true }, idempotencyKey: key("settle") });
      await holdReservation(db, { userId: user, component: "s9", reservationId: r1.reservationId, evidence: { transition: "hold", operationId: r1.operationId, evidenceKind: "outcome_unknown", evidenceRef: "s9-hold", reason: "outcome_unknown" }, idempotencyKey: key("hold") });
      await releaseReservation(db, { userId: user, component: "s9", reservationId: r2.reservationId, evidence: releaseEvidence(r2.operationId), idempotencyKey: key("release") });
      await getReservation(db, user, r0.reservationId);
      const b = await authorizeQuote(db, { userId: user, quoteVersionId: await issueTestQuote(db, user, "bundle", `s9-b-${tag}`, { paidTerms: terms(NOTICE) }), idempotencyKey: key("auth"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
      const base = { userId: user, component: "s9", packageId: b.packageId! };
      await recordBundleDelivery(db, { ...base, artifactCount: 3, evidenceRef: "s9/delivery", idempotencyKey: key("delivery") });
      await openRefinements(db, { ...base, idempotencyKey: key("open") });
      await skipRefinementSlot(db, { userId: user, packageId: base.packageId, ordinal: 1, idempotencyKey: key("skip") });
      await restoreRefinementSlot(db, { userId: user, packageId: base.packageId, ordinal: 1, idempotencyKey: key("restore") });
      const op1 = `s9-ref1-${tag}`, op2 = `s9-ref2-${tag}`;
      await markRefinementPending(db, { ...base, ordinal: 1, sourceVersionId: `src-${tag}-1`, operationId: op1, idempotencyKey: key("pend") });
      await consumeRefinementSlot(db, { ...base, ordinal: 1, operationId: op1, deliveredVersionId: `dv-${tag}-1`, evidenceRef: "s9/ref-1", idempotencyKey: key("consume") });
      await markRefinementPending(db, { ...base, ordinal: 2, sourceVersionId: `src-${tag}-2`, operationId: op2, idempotencyKey: key("pend") });
      await markRefinementUnknown(db, { ...base, ordinal: 2, operationId: op2, evidenceRef: "s9/ref-2", idempotencyKey: key("unknown") });
      await consumeRefinementSlot(db, { ...base, ordinal: 2, operationId: op2, deliveredVersionId: `dv-${tag}-2`, evidenceRef: "s9/ref-2b", idempotencyKey: key("consume") });
      const final = await authorizeQuote(db, { userId: user, quoteVersionId: await issueTestQuote(db, user, "final", `s9-f-${tag}`, { paidTerms: terms(NOTICE) }), idempotencyKey: key("final"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort(), originalPackageId: base.packageId });
      const fr = final.reservations[0]!;
      await recordWorkflowRef(db, { userId: user, component: "s9", reservationId: fr.reservationId, workflowRef: "wf/" + randomUUID(), idempotencyKey: key("wf") });
      await releaseReservation(db, { userId: user, component: "s9", reservationId: fr.reservationId, evidence: releaseEvidence(fr.operationId), idempotencyKey: key("release") });
      await beginBundleClosure(db, { ...base, trigger: { kind: "explicit_close_request" }, idempotencyKey: key("begin") });
      await closeBundleWithForfeiture(db, { ...base, cause: { kind: "explicit_close" }, refinementClosureNoticeVersion: NOTICE, idempotencyKey: key("close") });
      return (await getBundleState(db, user, base.packageId)).state;
    };
    // after the scenario: bundle A settled 1 (charge), held 1, released 1; bundle B stays reserved; the final was reserved and released
    const SCENARIO_END = { a: String(SCENARIO_FUNDS - SYNTHETIC_BUNDLE_HOLD + (SYNTHETIC_HOLDS[0] - SYNTHETIC_CHARGES[0]) + SYNTHETIC_HOLDS[2] - SYNTHETIC_BUNDLE_HOLD), r: String(SYNTHETIC_BUNDLE_HOLD), h: String(SYNTHETIC_HOLDS[1]), c: String(SYNTHETIC_CHARGES[0]) };

    await t.test("S9-G2 (positive): every runtime command kind works end to end as the runtime login under exactly the proposed grants; each definer path runs as its own role", async () => {
      const user = await env!.profile();
      assert.equal(await runtimeScenario(rt.db, user), "closed");
      assert.deepEqual(rt.codes, [], "no driver error on the legitimate path");
      assert.deepEqual(await buckets(user), SCENARIO_END);
    });

    void [closePool, before, ledgerCode, issueQuote, recordVendorCostEvidence, checkWalletInvariants, findOrphanedReservations, finalView, stalePricePolicy, SYNTHETIC_BUNDLE_CHARGE];
  } finally { await teardown(env, pools); }
});
