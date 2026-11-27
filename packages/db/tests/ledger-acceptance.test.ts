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
  recordBundleDelivery, reopenBundleAfterUnchargedFinal, restoreRefinementSlot, skipRefinementSlot,
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
    const runtimeScenario = async (db: Pool, user: string, fundWith: (userId: string, units: number) => Promise<unknown> = fund) => {
      const tag = randomUUID().slice(0, 8);
      await ensureWallet(db, user);
      await fundWith(user, SCENARIO_FUNDS);
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
      await beginBundleClosure(db, { ...base, trigger: { kind: "final_authorized", finalReservationId: fr.reservationId }, idempotencyKey: key("begin") });
      await recordWorkflowRef(db, { userId: user, component: "s9", reservationId: fr.reservationId, workflowRef: "wf/" + randomUUID(), idempotencyKey: key("wf") });
      await releaseReservation(db, { userId: user, component: "s9", reservationId: fr.reservationId, evidence: releaseEvidence(fr.operationId), idempotencyKey: key("release") });
      await reopenBundleAfterUnchargedFinal(db, { ...base, finalReservationId: fr.reservationId, idempotencyKey: key("reopen") });
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

    // ---- shared helpers for the acceptance rows (all as the runtime login unless named) --------------------------------------
    const fd = recording(funder);
    const settleEv = (operationId: string, overrides: Record<string, unknown> = {}) => ({ transition: "settle", operationId, evidenceKind: "persisted_delivered", evidenceRef: "s9-settle", hasVerifiedManifestHash: true, ownerAndRightsVerified: true, ...overrides });
    const holdEv = (operationId: string, kind: "outcome_unknown" | "persistence_failed_under_review" = "outcome_unknown") => ({ transition: "hold", operationId, evidenceKind: kind, evidenceRef: "s9-hold", reason: kind === "outcome_unknown" ? "outcome_unknown" : "persistence_unconfirmed" });
    const newUser = async (units: number) => { const user = await env!.profile(); await ensureWallet(rt.db, user); if (units > 0) await fund(user, units); return user; };
    const dispatchedBundle = async (db: Pool, user: string) => {
      const auth = await authorizeQuote(db, { userId: user, quoteVersionId: await issueTestQuote(db, user, "bundle", `s9-q-${randomUUID().slice(0, 12)}`), idempotencyKey: key("auth"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
      for (const r of auth.reservations) await recordWorkflowRef(db, { userId: user, component: "s9", reservationId: r.reservationId, workflowRef: "wf/" + randomUUID(), idempotencyKey: key("wf") });
      return auth;
    };
    const entriesFor = async (reservationId: string) => (await admin.query("SELECT entry_kind FROM vynvori_ledger.ledger_entries WHERE reservation_id = $1 ORDER BY entry_kind", [reservationId])).rows.map(r => r.entry_kind as string);
    const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];

    // ---- S9-G2: each runtime and definer privilege is necessary ---------------------------------------------------------------
    type Unit = { privilege: string; column: string | null; schema: boolean; object: string; grantee: keyof Vars };
    /** Splits the proposal's GRANT statements into single privilege units (one privilege, one column, one object, one grantee). */
    const grantUnits = (sql: string): Unit[] => sql.split("\n").filter(line => line.trim() !== "").flatMap(line => {
      const m = /^GRANT (.+?) ON (SCHEMA )?(.+?) TO (.+);$/.exec(line.trim());
      if (!m) throw new Error("not a single GRANT statement: " + line);
      const priv = /^([A-Z]+) \(([^)]+)\)$/.exec(m[1]!);
      const parts: [string, string | null][] = priv ? priv[2]!.split(", ").map(c => [priv[1]!, c]) : m[1]!.split(", ").map(x => [x, null]);
      const grantees = m[4]!.split(", ").map(g => { const v = /^:"([a-z_]+)"$/.exec(g)?.[1]; if (!v || !(v in vars)) throw new Error("bad grantee " + g); return v as keyof Vars; });
      return parts.flatMap(([privilege, column]) => m[3]!.split(", ").flatMap(object => grantees.map(grantee => ({ privilege, column, schema: !!m[2], object, grantee }))));
    });
    const unitSql = (verb: "GRANT" | "REVOKE", u: Unit) => `${verb} ${u.privilege}${u.column ? ` (${u.column})` : ""} ON ${u.schema ? "SCHEMA " : ""}${u.object} ${verb === "GRANT" ? "TO" : "FROM"} ${q(vars[u.grantee])}`;
    const label = (u: Unit) => `${u.grantee}: ${u.privilege}${u.column ? `(${u.column})` : ""} on ${u.object}`;
    const units = [...grantUnits(proposalBlocks().get("runtime")!), ...grantUnits(proposalBlocks().get("privileges")!)];
    /** Revokes one unit as the executor, runs the path, expects it to fail with a recorded 42501, and grants the unit back. */
    const withoutUnit = async (u: Unit, path: () => Promise<unknown>, recorders: { codes: string[] }[]) => {
      for (const r of recorders) r.codes.length = 0;
      await env!.asExec(unitSql("REVOKE", u));
      let threw = false;
      try { await path(); } catch { threw = true; } finally { await env!.asExec(unitSql("GRANT", u)); }
      const codes = recorders.flatMap(r => r.codes);
      assert.ok(threw && codes.includes("42501"), `removing ${label(u)} makes the path fail with 42501 (threw ${threw}, codes ${JSON.stringify(codes)})`);
      for (const r of recorders) r.codes.length = 0;
    };
    const fundVia = (db: Pool) => (userId: string, units: number) => grantSyntheticCredits(db, { userId, grantSourceId: source, sourceRef: `s9-funds-${++funds}`, units });

    // ---- S9-G4 and D15-T3: reconciliation and vendor-cost isolation ------------------------------------------------------------
    await t.test("S9-G4 / D15-T3: as the reconciliation login, vendor-cost evidence (usage, invoice, unknown) is recorded and replayed without moving any credit or state; each unit is necessary; the runtime has no vendor-cost access", async () => {
      const reconPool = await openAs(vars.ledger_reconciliation_login, 1), rc = recording(reconPool);
      try {
        const user = await newUser(SYNTHETIC_BUNDLE_HOLD);
        const auth = await dispatchedBundle(rt.db, user);
        const r = auth.reservations[0]!, before = await buckets(user);
        const input = { component: "reconciler", operationId: r.operationId, reservationId: r.reservationId, evidenceKind: "invoice" as const, evidenceRef: "s9-inv", amountUsdMicros: 1234 };
        const first = await recordVendorCostEvidence(rc.db, input);
        assert.equal(first.replayed, false);
        assert.deepEqual(await recordVendorCostEvidence(rc.db, input), { ...first, replayed: true });
        await recordVendorCostEvidence(rc.db, { ...input, evidenceKind: "usage", evidenceRef: "s9-use" });
        await recordVendorCostEvidence(rc.db, { ...input, evidenceKind: "unknown", evidenceRef: "s9-unk", amountUsdMicros: null });
        assert.deepEqual(await buckets(user), before, "D15-T3: vendor cost never moves a wallet bucket");
        assert.equal((await getReservation(rt.db, user, r.reservationId)).state, "reserved", "D15-T3: an invoice or unknown cost never settles, releases or holds");
        assert.deepEqual(rc.codes, []);
        for (const u of units.filter(x => x.grantee === "ledger_reconciliation"))
          await withoutUnit(u, async () => { const ref = "s9-" + randomUUID().slice(0, 8); await recordVendorCostEvidence(rc.db, { ...input, evidenceRef: ref }); await recordVendorCostEvidence(rc.db, { ...input, evidenceRef: ref }); }, [rc]);
        for (const sql of ["UPDATE vynvori_ledger.vendor_cost_evidence SET amount_usd_micros = 0", "DELETE FROM vynvori_ledger.vendor_cost_evidence", "SELECT count(*) FROM vynvori_ledger.wallets", "SELECT count(*) FROM vynvori_ledger.credit_reservations"])
          await assert.rejects(reconPool.query(sql), sqlstate("42501"), sql);
        await assert.rejects(runtimePool.query("SELECT count(*) FROM vynvori_ledger.vendor_cost_evidence"), sqlstate("42501"), "the runtime role cannot read vendor cost");
        await assert.rejects(recordVendorCostEvidence(runtimePool, { ...input, evidenceRef: "s9-rt" }), "the runtime role cannot record vendor cost");
      } finally { await closePool(reconPool); }
      assert.deepEqual(await endState(), [HARD_GATE_ROW]);
    });

    // ---- doc 15 acceptance targets (small-scale, under the proposed roles; the 100-way cases are in ledger-concurrency) ---------
    const authorizeFor = (user: string, quoteVersionId: string, pricePolicy = currentPricePolicy) =>
      authorizeQuote(rt.db, { userId: user, quoteVersionId, idempotencyKey: key("auth"), consent: consent(), now: new Date(), pricePolicy, eligibility: eligibilityPort() });
    await t.test("D15-T1: concurrent authorizations against a wallet that funds exactly three bundles: exactly three win, the fourth is INSUFFICIENT_CREDITS, nothing is lost", async () => {
      const user = await newUser(3 * SYNTHETIC_BUNDLE_HOLD);
      const quotes = await Promise.all([0, 1, 2, 3].map(i => issueTestQuote(rt.db, user, "bundle", `s9-t1-${i}-${randomUUID().slice(0, 8)}`)));
      const settled = await Promise.allSettled(quotes.map(qv => authorizeFor(user, qv)));
      assert.equal(settled.filter(x => x.status === "fulfilled").length, 3);
      assert.ok(settled.filter(x => x.status === "rejected").every(x => ledgerCode("INSUFFICIENT_CREDITS")((x as PromiseRejectedResult).reason)));
      assert.deepEqual(await buckets(user), { a: "0", r: String(3 * SYNTHETIC_BUNDLE_HOLD), h: "0", c: "0" });
    });
    await t.test("D15-T2: a duplicated settle (same key, concurrent) writes one entry; out-of-order evidence (before the reservation exists, after a terminal transition, or for another operation) moves nothing", async () => {
      const user = await newUser(SYNTHETIC_BUNDLE_HOLD);
      const [r0, r1] = (await dispatchedBundle(rt.db, user)).reservations;
      const k = key("dup");
      const both = await Promise.all([0, 1].map(() => settleReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: settleEv(r0!.operationId), idempotencyKey: k })));
      assert.deepEqual(both.map(b => b.state), ["settled", "settled"]);
      assert.deepEqual(await entriesFor(r0!.reservationId), ["reserve", "settle"]);
      await assert.rejects(settleReservation(rt.db, { userId: user, component: "s9", reservationId: randomUUID(), evidence: settleEv("op-unseen"), idempotencyKey: key("early") }), ledgerCode("NOT_FOUND"), "evidence for a reservation that does not exist yet");
      await assert.rejects(releaseReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: releaseEvidence(r0!.operationId), idempotencyKey: key("late") }), ledgerCode("INVALID_TRANSITION"));
      await assert.rejects(holdReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: holdEv(r0!.operationId), idempotencyKey: key("late") }), ledgerCode("INVALID_TRANSITION"));
      await assert.rejects(settleReservation(rt.db, { userId: user, component: "s9", reservationId: r1!.reservationId, evidence: settleEv(r0!.operationId), idempotencyKey: key("wrongop") }), ledgerCode("EVIDENCE_INVALID"), "evidence for another operation");
      assert.deepEqual(await entriesFor(r0!.reservationId), ["reserve", "settle"]);
      assert.deepEqual(await entriesFor(r1!.reservationId), ["reserve"]);
    });
    await t.test("D15-T4: a renewed quote makes version 1 stale for assessment and authorization; a stale price version is refused; the renewed version authorizes", async () => {
      const user = await newUser(SYNTHETIC_BUNDLE_HOLD);
      const quoteId = `s9-t4-${randomUUID().slice(0, 8)}`, v1 = await issueTestQuote(rt.db, user, "bundle", quoteId);
      await renewQuote(rt.db, { userId: user, quoteId, expectedLatestVersionNo: 1, quoteView: bundleView(quoteId, quoteId + "-v2"), modelRef: "s5-model", allocations: bundleAllocations, idempotencyKey: key("renew") });
      assert.deepEqual(await assessQuoteForAuthorization(rt.db, { userId: user, quoteVersionId: v1, now: new Date(), pricePolicy: currentPricePolicy }), { ok: false, code: "QUOTE_STALE" });
      await assert.rejects(authorizeFor(user, v1), ledgerCode("QUOTE_STALE"));
      await assert.rejects(authorizeFor(user, quoteId + "-v2", stalePricePolicy), ledgerCode("QUOTE_STALE"));
      assert.equal((await authorizeFor(user, quoteId + "-v2")).reservations.length, 3);
    });
    await t.test("D15-T5: no negative balance, no double charge, no double grant: an over-budget authorization moves nothing; a second settle under a new key is INVALID_TRANSITION; a second grant of the same source reference is DUPLICATE_CAUSE", async () => {
      const user = await newUser(SYNTHETIC_BUNDLE_HOLD - 1);
      await assert.rejects(authorizeFor(user, await issueTestQuote(rt.db, user, "bundle", `s9-t5-${randomUUID().slice(0, 8)}`)), ledgerCode("INSUFFICIENT_CREDITS"));
      assert.deepEqual(await buckets(user), { a: String(SYNTHETIC_BUNDLE_HOLD - 1), r: "0", h: "0", c: "0" });
      await fund(user, 1);
      const [r0] = (await dispatchedBundle(rt.db, user)).reservations;
      await settleReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: settleEv(r0!.operationId), idempotencyKey: key("s1") });
      await assert.rejects(settleReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: settleEv(r0!.operationId), idempotencyKey: key("s2") }), ledgerCode("INVALID_TRANSITION"));
      assert.equal((await buckets(user)).c, String(SYNTHETIC_CHARGES[0]));
      const ref = "s9-capture-" + randomUUID();
      await grantSyntheticCredits(funder, { userId: user, grantSourceId: source, sourceRef: ref, units: 1, idempotencyKey: key("g1") });
      await assert.rejects(grantSyntheticCredits(funder, { userId: user, grantSourceId: source, sourceRef: ref, units: 1, idempotencyKey: key("g2") }), ledgerCode("DUPLICATE_CAUSE"));
      assert.equal(Number((await buckets(user)).a), SYNTHETIC_HOLDS[0] - SYNTHETIC_CHARGES[0] + 1);
    });

    // ---- doc 06 test-matrix rows ------------------------------------------------------------------------------------------------
    await t.test("D06-R01: simultaneous requests against a wallet that covers exactly one: one authorization wins, the other is INSUFFICIENT_CREDITS; a wallet one unit short refuses both", async () => {
      for (const [units, wins] of [[SYNTHETIC_BUNDLE_HOLD, 1], [SYNTHETIC_BUNDLE_HOLD - 1, 0]] as const) {
        const user = await newUser(units);
        const quotes = await Promise.all([0, 1].map(i => issueTestQuote(rt.db, user, "bundle", `s9-r01-${i}-${randomUUID().slice(0, 8)}`)));
        const settled = await Promise.allSettled(quotes.map(qv => authorizeFor(user, qv)));
        assert.equal(settled.filter(x => x.status === "fulfilled").length, wins);
        assert.ok(settled.filter(x => x.status === "rejected").every(x => ledgerCode("INSUFFICIENT_CREDITS")((x as PromiseRejectedResult).reason)));
        assert.ok(Number((await buckets(user)).a) >= 0);
      }
    });
    await t.test("D06-R02 (NOT IN W1): no runtime path can register or use a payment-capture grant source; the capture flow itself is M4 and NOT RUN", async () => {
      // W1 has no Medusa capture path (M4). What exists today: the same source_ref under a second key is DUPLICATE_CAUSE (D15-T5), and
      // the runtime role cannot register or read a source (S9-B6). This row stays NOT_IN_W1 in the evidence record.
      await assert.rejects(runtimePool.query("INSERT INTO vynvori_ledger.ledger_grant_sources(grant_source_id, kind, label) VALUES ($1, 'medusa_payment_capture', 'x')", [randomUUID()]), sqlstate("42501"));
    });
    await t.test("D06-R03: provider timeout after billing: the reservation is held (outcome_unknown), never settled or released by a retry; the orphan finder reports it", async () => {
      const user = await newUser(SYNTHETIC_BUNDLE_HOLD);
      const [r0] = (await dispatchedBundle(rt.db, user)).reservations;
      await holdReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: holdEv(r0!.operationId), idempotencyKey: key("hold") });
      await assert.rejects(settleReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: settleEv(r0!.operationId), idempotencyKey: key("retry") }), ledgerCode("INVALID_TRANSITION"));
      await assert.rejects(releaseReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: releaseEvidence(r0!.operationId), idempotencyKey: key("retry") }), ledgerCode("INVALID_TRANSITION"));
      assert.equal((await getReservation(rt.db, user, r0!.reservationId)).state, "reconciliation_hold");
      assert.deepEqual(await buckets(user), { a: "0", r: String(SYNTHETIC_BUNDLE_HOLD - SYNTHETIC_HOLDS[0]), h: String(SYNTHETIC_HOLDS[0]), c: "0" });
      const checkerPool = await openAs(vars.ledger_checker_login, 1);
      try { assert.ok((await findOrphanedReservations(checkerPool, { olderThan: new Date(Date.now() + 60_000) })).orphans.some(o => o.reservationId === r0!.reservationId && o.orphanClass === "hold_present")); }
      finally { await closePool(checkerPool); }
    });
    await t.test("D06-R04: the provider returned an artifact but the DB write failed: settle needs persisted, verified evidence (anything else is EVIDENCE_INVALID); the reservation is held under review", async () => {
      const user = await newUser(SYNTHETIC_BUNDLE_HOLD);
      const [r0] = (await dispatchedBundle(rt.db, user)).reservations;
      for (const bad of [{ evidenceKind: "outcome_unknown" }, { hasVerifiedManifestHash: false }, { ownerAndRightsVerified: false }])
        await assert.rejects(settleReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: settleEv(r0!.operationId, bad), idempotencyKey: key("bad") }), ledgerCode("EVIDENCE_INVALID"), JSON.stringify(bad));
      assert.deepEqual(await entriesFor(r0!.reservationId), ["reserve"]);
      await holdReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: holdEv(r0!.operationId, "persistence_failed_under_review"), idempotencyKey: key("hold") });
      assert.equal((await getReservation(rt.db, user, r0!.reservationId)).state, "reconciliation_hold");
    });
    await t.test("D06-R05: webhook replay and out-of-order: the same settle replays (one entry); a hold after the settle is INVALID_TRANSITION; a release naming another operation is EVIDENCE_INVALID", async () => {
      const user = await newUser(SYNTHETIC_BUNDLE_HOLD);
      const [r0, r1] = (await dispatchedBundle(rt.db, user)).reservations;
      const input = { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: settleEv(r0!.operationId), idempotencyKey: key("hook") };
      await settleReservation(rt.db, input); await settleReservation(rt.db, input);
      assert.deepEqual(await entriesFor(r0!.reservationId), ["reserve", "settle"]);
      await assert.rejects(holdReservation(rt.db, { userId: user, component: "s9", reservationId: r0!.reservationId, evidence: holdEv(r0!.operationId), idempotencyKey: key("late") }), ledgerCode("INVALID_TRANSITION"));
      await assert.rejects(releaseReservation(rt.db, { userId: user, component: "s9", reservationId: r1!.reservationId, evidence: releaseEvidence(r0!.operationId), idempotencyKey: key("wrong") }), ledgerCode("EVIDENCE_INVALID"));
    });
    await t.test("D06-R07 (partly): ownership on every ID: another user's reservation, quote and package are NOT_FOUND for every read and command (no existence leak)", async () => {
      const owner = await newUser(SYNTHETIC_BUNDLE_HOLD), other = await newUser(SYNTHETIC_BUNDLE_HOLD);
      const quoteVersionId = await issueTestQuote(rt.db, owner, "bundle", `s9-r07-${randomUUID().slice(0, 8)}`);
      const auth = await authorizeFor(owner, quoteVersionId);
      const r0 = auth.reservations[0]!, pkg = auth.packageId!;
      const attempts: [string, () => Promise<unknown>][] = [
        ["getReservation", () => getReservation(rt.db, other, r0.reservationId)],
        ["getQuote", () => getQuote(rt.db, other, quoteVersionId)],
        ["getBundleState", () => getBundleState(rt.db, other, pkg)],
        ["recordWorkflowRef", () => recordWorkflowRef(rt.db, { userId: other, component: "s9", reservationId: r0.reservationId, workflowRef: "wf/x", idempotencyKey: key("x") })],
        ["settle", () => settleReservation(rt.db, { userId: other, component: "s9", reservationId: r0.reservationId, evidence: settleEv(r0.operationId), idempotencyKey: key("x") })],
        ["release", () => releaseReservation(rt.db, { userId: other, component: "s9", reservationId: r0.reservationId, evidence: releaseEvidence(r0.operationId), idempotencyKey: key("x") })],
        ["authorize", () => authorizeFor(other, quoteVersionId)],
        ["delivery", () => recordBundleDelivery(rt.db, { userId: other, component: "s9", packageId: pkg, artifactCount: 3, evidenceRef: "s9/x", idempotencyKey: key("x") })],
      ];
      for (const [name, attempt] of attempts) await assert.rejects(attempt(), ledgerCode("NOT_FOUND"), name);
      assert.deepEqual(await buckets(other), { a: String(SYNTHETIC_BUNDLE_HOLD), r: "0", h: "0", c: "0" });
      assert.equal((await getReservation(rt.db, owner, r0.reservationId)).state, "reserved");
    });
    await t.test("D06-R10: a guest (no verified profile) cannot hold a wallet, claim a promo or be granted credit, and the runtime role has no purchase path", async () => {
      const guest = randomUUID();
      await assert.rejects(ensureWallet(rt.db, guest));
      await assert.rejects(claimPromo(rt.db, { userId: guest, operationId: "s9-guest", idempotencyKey: key("guest") }));
      await assert.rejects(grantSyntheticCredits(funder, { userId: guest, grantSourceId: source, sourceRef: "s9-guest-" + randomUUID(), units: 1 }));
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM vynvori_ledger.wallets WHERE user_id = $1", [guest])).rows[0].n, 0);
    });
    await t.test("D06-R11 (partly): fractional amounts are refused before SQL, never rounded: credit units, allocations and vendor USD micros", async () => {
      const user = await newUser(0);
      await assert.rejects(grantSyntheticCredits(funder, { userId: user, grantSourceId: source, sourceRef: "s9-frac-" + randomUUID(), units: 1.5 }), ledgerCode("INVALID_INPUT"));
      const quoteId = `s9-r11-${randomUUID().slice(0, 8)}`;
      await assert.rejects(issueQuote(rt.db, { userId: user, quoteView: bundleView(quoteId, quoteId + "-v1"), modelRef: "s5-model", allocations: bundleAllocations.map((a, i) => i === 0 ? { ...a, holdUnits: 3.5 } : a), idempotencyKey: key("frac") }));
      const reconPool = await openAs(vars.ledger_reconciliation_login, 1);
      try { await assert.rejects(recordVendorCostEvidence(reconPool, { component: "reconciler", operationId: "s9-frac", evidenceKind: "invoice", evidenceRef: "s9-frac", amountUsdMicros: 0.5 }), ledgerCode("INVALID_INPUT")); }
      finally { await closePool(reconPool); }
      assert.deepEqual(await buckets(user), { a: "0", r: "0", h: "0", c: "0" });
    });
    await t.test("D06-R12 (partly): package fee: a bundle that settles all three operations consumes exactly the frozen charges and returns the rest of each hold", async () => {
      const user = await newUser(SYNTHETIC_BUNDLE_HOLD);
      for (const r of (await dispatchedBundle(rt.db, user)).reservations)
        await settleReservation(rt.db, { userId: user, component: "s9", reservationId: r.reservationId, evidence: settleEv(r.operationId), idempotencyKey: key("fee") });
      assert.deepEqual(await buckets(user), { a: String(SYNTHETIC_BUNDLE_HOLD - SYNTHETIC_BUNDLE_CHARGE), r: "0", h: "0", c: String(SYNTHETIC_BUNDLE_CHARGE) });
    });

    // ---- privilege minimality and the checker run after the rows above (the orphan finder caps its report at 100) ----------
    await t.test("S9-G2: each runtime and definer privilege unit of steps 3 and 4 is necessary: revoked alone, the runtime scenario fails with 42501; granted back, the end state is exact again", async () => {
      const mine = units.filter(u => u.grantee === "ledger_runtime" || u.grantee.endsWith("_definer"));
      assert.ok(mine.length >= 50, `${mine.length} units`);
      const fundRecorded = fundVia(fd.db);
      for (const u of mine) await withoutUnit(u, async () => runtimeScenario(rt.db, await env!.profile(), fundRecorded), [rt, fd]);
      assert.deepEqual(await endState(), [HARD_GATE_ROW]);
      const user = await env!.profile();
      assert.equal(await runtimeScenario(rt.db, user), "closed", "and the full path works again");
      assert.deepEqual(await buckets(user), SCENARIO_END);
    });

    // ---- S9-G3: the checker ----------------------------------------------------------------------------------------------------
    await t.test("S9-G3: as the checker login the S8 invariant check and the orphan finder run clean (only the synthetic-source finding); each checker unit is necessary; the checker cannot write and has no vendor-cost access; the runtime cannot run the checker", async () => {
      const checkerPool = await openAs(vars.ledger_checker_login, 1), ck = recording(checkerPool);
      try {
        const report = await checkWalletInvariants(ck.db);
        assert.deepEqual(report.findings.map(f => f.invariant), ["SYNTHETIC_GRANT_SOURCE_REGISTERED"], JSON.stringify(report.findings));
        const orphans = await findOrphanedReservations(ck.db, { olderThan: new Date(Date.now() + 60_000) });
        assert.ok(orphans.orphans.length > 0, "the scenario's held operation is reported");
        assert.deepEqual(ck.codes, []);
        for (const u of units.filter(x => x.grantee === "ledger_checker"))
          await withoutUnit(u, async () => { await checkWalletInvariants(ck.db); await findOrphanedReservations(ck.db, { olderThan: new Date() }); }, [ck]);
        for (const sql of ["INSERT INTO vynvori_ledger.ledger_grant_sources(grant_source_id, kind, label) VALUES (gen_random_uuid(), 'synthetic_test', 'x')", "UPDATE vynvori_ledger.wallets SET user_id = user_id", "SELECT count(*) FROM vynvori_ledger.vendor_cost_evidence", "SELECT count(*) FROM vynvori_ledger.refinement_slots", "SELECT id FROM vynvori_identity.profiles LIMIT 1"])
          await assert.rejects(checkerPool.query(sql), sqlstate("42501"), sql);
        rt.codes.length = 0;
        await assert.rejects(checkWalletInvariants(rt.db), "the runtime role cannot read the grant-source registry, so it cannot run the checker");
        assert.ok(rt.codes.includes("42501")); rt.codes.length = 0;
      } finally { await closePool(checkerPool); }
      assert.deepEqual(await endState(), [HARD_GATE_ROW]);
    });

    // ---- S9-B4: trigger-context branches ------------------------------------------------------------------------------------------
    await t.test("S9-B4: every ledger trigger function refuses each wrong context alone: wrong table (TG_RELID / schema), wrong TG_OP, wrong TG_WHEN and wrong TG_LEVEL, with 23000 'unexpected context'", async () => {
      type Guard = { fn: string; tables: string[]; op: string; when: string; level: string };
      const fns = rows<{ proname: string; src: string }>(await admin.query("SELECT p.proname::text AS proname, p.prosrc AS src FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prorettype = 'trigger'::regtype ORDER BY 1"));
      const attached = async (fn: string) => rows<{ t: string }>(await admin.query("SELECT DISTINCT c.relname::text AS t FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid WHERE g.tgfoid = ('vynvori_ledger.' || $1 || '()')::regprocedure AND NOT g.tgisinternal ORDER BY 1", [fn])).map(r => r.t);
      const guards: Guard[] = [];
      for (const { proname, src } of fns) {
        const head = /IF ([\s\S]*?) THEN\s+RAISE EXCEPTION 'trigger function fired from an unexpected context'/.exec(src)?.[1];
        assert.ok(head, `${proname} starts with a context guard`);
        if (proname === "reject_mutation") { guards.push({ fn: proname, tables: await attached(proname), op: "UPDATE", when: "BEFORE", level: "ROW" }); continue; }
        const tables = [...head.matchAll(/'vynvori_ledger\.([a-z_]+)'::pg_catalog\.regclass/g)].map(m => m[1]!);
        const one = (name: string) => { const v = new RegExp(`TG_${name} <> '([A-Z]+)'`).exec(head)?.[1]; assert.ok(v, `${proname}: TG_${name}`); return v; };
        assert.ok(tables.length >= 1, `${proname}: TG_RELID`);
        for (const x of await attached(proname)) assert.ok(tables.includes(x), `${proname} is attached only to a table its guard names (${x})`);
        guards.push({ fn: proname, tables, op: one("OP"), when: one("WHEN"), level: one("LEVEL") });
      }
      const firstColumn = async (table: string) => (await admin.query("SELECT quote_ident(attname) AS a FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum LIMIT 1", [table])).rows[0].a as string;
      const statement = async (table: string, op: string) => op === "INSERT" ? `INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM ${table} LIMIT 1` : op === "UPDATE" ? `UPDATE ${table} SET ${await firstColumn(table)} = ${await firstColumn(table)}` : op === "DELETE" ? `DELETE FROM ${table}` : `TRUNCATE ${table}`;
      /** One wrong context on the REAL table: every other user trigger disabled and every unique/foreign key dropped, inside a rolled-back transaction. */
      const probe = async (table: string, fn: string, when: string, op: string, level: string, what: string) => {
        await admin.query("BEGIN");
        try {
          await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
          for (const c of rows<{ conname: string }>(await admin.query("SELECT conname::text AS conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p', 'u', 'x', 'f')", [table]))) await admin.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${q(c.conname)} CASCADE`);
          for (const i of rows<{ i: string }>(await admin.query("SELECT indexrelid::regclass::text AS i FROM pg_index WHERE indrelid = $1::regclass AND indisunique", [table]))) await admin.query(`DROP INDEX ${i.i}`);
          assert.equal((await admin.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount, 1, `${table} has a row to fire on (this runs after the scenario)`);
          await admin.query(`CREATE TRIGGER "0_s9_probe" ${when} ${op} ON ${table} FOR EACH ${level} EXECUTE FUNCTION vynvori_ledger.${fn}()`);
          await assert.rejects(admin.query(await statement(table, op)), sqlstate("23000", /unexpected context/), `${fn}: ${what}`);
        } finally { await admin.query("ROLLBACK"); }
      };
      let probes = 0;
      for (const g of guards) {
        const table = "vynvori_ledger." + g.tables[0]!;
        const wrongOp = g.op === "INSERT" ? "UPDATE" : "INSERT";
        await probe(table, g.fn, g.when, wrongOp, g.level, `wrong TG_OP (${wrongOp})`);
        await probe(table, g.fn, g.when === "BEFORE" ? "AFTER" : "BEFORE", g.op, g.level, "wrong TG_WHEN");
        await probe(table, g.fn, g.when, g.op, g.level === "ROW" ? "STATEMENT" : "ROW", "wrong TG_LEVEL");
        await admin.query("BEGIN");
        try {
          // Same columns as the real table, different relation (and schema): only TG_RELID / TG_TABLE_SCHEMA is wrong.
          await admin.query(`CREATE TABLE public.s9_scratch (LIKE ${table})`); await admin.query(`INSERT INTO public.s9_scratch SELECT * FROM ${table} LIMIT 1`);
          await admin.query(`CREATE TRIGGER "0_s9_probe" ${g.when} ${g.op} ON public.s9_scratch FOR EACH ${g.level} EXECUTE FUNCTION vynvori_ledger.${g.fn}()`);
          await assert.rejects(admin.query((await statement("public.s9_scratch", g.op)).replace(" OVERRIDING SYSTEM VALUE", "")), sqlstate("23000", /unexpected context/), `${g.fn}: wrong table`);
        } finally { await admin.query("ROLLBACK"); }
        probes += 4;
      }
      assert.ok(guards.length === fns.length && guards.length >= 25 && probes === 4 * guards.length, `${guards.length} trigger functions, ${probes} probes`);
      assert.deepEqual(await endState(), [HARD_GATE_ROW], "the probes changed nothing");
    });

    // ---- S9-B5: break-glass --------------------------------------------------------------------------------------------------------
    await t.test("S9-B5: break-glass: neither a superuser nor any definer owner can UPDATE a bucket or a state directly; the table owner can only by disabling the named guard in a reviewed transaction", async () => {
      // [table, correction, a row the correction is shape-valid for]
      const targets = [
        ["vynvori_ledger.wallets", "available_units = available_units + 1", "true"], ["vynvori_ledger.credit_reservations", "state = 'released'", "state = 'reserved'"],
        ["vynvori_ledger.ledger_packages", "state = 'authorized'", "state = 'closed'"], ["vynvori_ledger.refinement_slots", "delivered_version_id = delivered_version_id || '-corrected'", "state = 'used'"],
      ] as const;
      for (const [table, set, where] of targets) {
        assert.equal((await admin.query(`SELECT 1 FROM ${table} WHERE ${where} LIMIT 1`)).rowCount, 1, `${table} has a row (${where})`);
        await assert.rejects(admin.query(`UPDATE ${table} SET ${set} WHERE ${where}`), sqlstate("23000"), `superuser: ${table}`);
        for (const d of DEFINERS) {
          await admin.query("BEGIN");
          try {
            await admin.query(`SET LOCAL ROLE ${q(vars[d])}`);
            await assert.rejects(admin.query(`UPDATE ${table} SET ${set} WHERE ${where}`), (e: unknown) => sqlstate("23000")(e) || sqlstate("42501")(e), `${d} (a definer owner, depth 1): ${table}`);
          } finally { await admin.query("ROLLBACK"); }
        }
        const guard = rows<{ tgname: string }>(await admin.query("SELECT tgname::text AS tgname FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND tgtype & 2 <> 0 AND tgtype & 16 <> 0 AND tgname LIKE '%update_guard'", [table]));
        assert.equal(guard.length, 1, `${table} has one named update guard`);
        await admin.query("BEGIN");
        try {
          await admin.query(`SET LOCAL ROLE ${q(exec)}`);
          await admin.query(`ALTER TABLE ${table} DISABLE TRIGGER ${q(guard[0]!.tgname)}`);
          const changed = await admin.query(`UPDATE ${table} SET ${set} WHERE ctid = (SELECT ctid FROM ${table} WHERE ${where} LIMIT 1)`);
          assert.equal(changed.rowCount, 1, `the table owner, with ${guard[0]!.tgname} disabled, can correct ${table}`);
        } finally { await admin.query("ROLLBACK"); }
        assert.equal((await admin.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2", [table, guard[0]!.tgname])).rows[0].tgenabled, "O", "rolled back: the guard is enabled again");
      }
      assert.deepEqual(await endState(), [HARD_GATE_ROW]);
    });

    // ---- S9-G5: the end-state check detects deviations -----------------------------------------------------------------------------
    await t.test("S9-G5: step 6 reports each deviation: a definer granted to the runtime, an extra privilege, a missing privilege, EXECUTE on a definer, CREATE for a definer, PUBLIC TEMPORARY, an extra identity column, and a dangerous login attribute", async () => {
      const cases: [string, string, string][] = [
        ["definer membership", `GRANT ${q(vars.ledger_wallet_definer)} TO ${q(vars.ledger_runtime)}`, `REVOKE ${q(vars.ledger_wallet_definer)} FROM ${q(vars.ledger_runtime)}`],
        ["extra privilege", `GRANT INSERT ON vynvori_ledger.vendor_cost_evidence TO ${q(vars.ledger_runtime)}`, `REVOKE INSERT ON vynvori_ledger.vendor_cost_evidence FROM ${q(vars.ledger_runtime)}`],
        ["missing privilege", `REVOKE UPDATE (state) ON vynvori_ledger.credit_reservations FROM ${q(vars.ledger_reservation_definer)}`, `GRANT UPDATE (state) ON vynvori_ledger.credit_reservations TO ${q(vars.ledger_reservation_definer)}`],
        ["CREATE for a definer", `GRANT CREATE ON SCHEMA vynvori_ledger TO ${q(vars.ledger_slot_definer)}`, `REVOKE CREATE ON SCHEMA vynvori_ledger FROM ${q(vars.ledger_slot_definer)}`],
        ["PUBLIC TEMPORARY", `GRANT TEMPORARY ON DATABASE ${q(env!.database)} TO PUBLIC`, `REVOKE TEMPORARY ON DATABASE ${q(env!.database)} FROM PUBLIC`],
      ];
      for (const [name, change, undo] of cases) {
        await env!.asExec(change);
        try { assert.ok((await endState()).some(x => x !== HARD_GATE_ROW), `${name} is reported`); }
        finally { await env!.asExec(undo); }
      }
      await admin.query(`GRANT EXECUTE ON FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet() TO ${q(vars.ledger_runtime)}`); // the executor cannot: it no longer owns it
      try { assert.ok((await endState()).some(x => /EXECUTE on function vynvori_ledger\.ledger_entries_apply_to_wallet/.test(x)), "EXECUTE on a definer is reported"); }
      finally { await admin.query(`REVOKE EXECUTE ON FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet() FROM ${q(vars.ledger_runtime)}`); }
      await admin.query(`GRANT SELECT (created_at) ON vynvori_identity.profiles TO ${q(vars.ledger_runtime)}`);
      try { assert.ok((await endState()).some(x => x.includes("created_at")), "an identity column beyond id, issuer, subject is reported"); }
      finally { await admin.query(`REVOKE SELECT (created_at) ON vynvori_identity.profiles FROM ${q(vars.ledger_runtime)}`); }
      await admin.query(`ALTER ROLE ${q(vars.ledger_checker_login)} BYPASSRLS`);
      try { assert.ok((await endState()).some(x => x.includes(vars.ledger_checker_login)), "a login holding a ledger role with BYPASSRLS is reported"); }
      finally { await admin.query(`ALTER ROLE ${q(vars.ledger_checker_login)} NOBYPASSRLS`); }
      assert.deepEqual(await endState(), [HARD_GATE_ROW]);
    });

    // ---- S9-G6: undo --------------------------------------------------------------------------------------------------------------
    await t.test("S9-G6: undo (detach logins, reown_back, drop_roles) returns every ledger, identity and database privilege and every function owner to the pre-proposal snapshot", async () => {
      for (const [login, role] of [[vars.ledger_runtime_login, vars.ledger_runtime], [vars.ledger_checker_login, vars.ledger_checker], [vars.ledger_reconciliation_login, vars.ledger_reconciliation]] as const)
        await env!.asExec(`REVOKE ${q(role)} FROM ${q(login)}`);
      for (const pool of [...pools]) await closePool(pool);
      await env!.block("reown_back");
      await env!.block("drop_roles");
      assert.deepEqual((await admin.query(PRIVILEGE_SNAPSHOT)).rows, before, "exact pre-proposal privileges and owners");
      assert.deepEqual(rows(await admin.query("SELECT rolname FROM pg_roles WHERE rolname = ANY($1)", [ROLE_VARIABLES.map(v => vars[v])])), []);
    });
  } finally { await teardown(env, pools); }
});
