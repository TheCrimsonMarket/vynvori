import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client, Pool, PoolClient } from "pg";
import {
  appendGrantEntry, canonicalRequestHash, classifyCommitFailure, classifyStatementFailure, ensureWallet, getWalletSummary, LedgerBusinessRejection, LedgerError,
  parseSafeUnits, assertPositiveUnits, PERSISTABLE_REJECTION_CODES, runLedgerCommand, type LedgerConn, type LedgerDb, type LedgerTx,
} from "../src/ledger-core";
import { dropLedger, freshLedger, grantSyntheticCredits, ledgerPool, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet } from "./ledger-fixture";

// SYNTHETIC_* values exist only in tests and are never exported from src/.
const SYNTHETIC_UNITS = 7;
const key = (label: string) => (label + "-" + randomUUID()).slice(0, 64);
const dbError = (code: string, severity = "ERROR") => Object.assign(new Error("db"), { code, severity });
const ledgerCode = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;

// ---- unit tests (no database) -----------------------------------------------------------------------------------------------

test("units parsing is exact: nothing beyond 2^53-1, no fractions, no exponents, no Number() on unchecked text", () => {
  assert.equal(parseSafeUnits("0"), 0); assert.equal(parseSafeUnits("9007199254740991"), 9007199254740991); assert.equal(parseSafeUnits("-9007199254740991"), -9007199254740991);
  for (const bad of ["9007199254740992", "-9007199254740992", "99999999999999999999", "1.5", "1e3", "", " 1", "0x10", "NaN", "Infinity", null, undefined, 5, {}])
    assert.throws(() => parseSafeUnits(bad), ledgerCode("INVALID_INPUT"), String(bad));
  for (const ok of [1, 5, 9007199254740991]) assert.equal(assertPositiveUnits(ok), ok);
  for (const bad of [0, -1, 1.5, NaN, Infinity, 9007199254740992, 2 ** 53, "5", null, undefined, 1n]) assert.throws(() => assertPositiveUnits(bad), ledgerCode("INVALID_INPUT"), String(bad));
});

test("canonicalRequestHash is key-order independent, deep, and rejects non-canonical values", () => {
  const a = canonicalRequestHash({ b: 1, a: { y: [1, 2, { q: null, p: "x" }], x: true } });
  assert.equal(a, canonicalRequestHash({ a: { x: true, y: [1, 2, { p: "x", q: null }] }, b: 1 }));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, canonicalRequestHash({ a: { x: true, y: [2, 1, { p: "x", q: null }] }, b: 1 }), "array order is significant");
  assert.notEqual(canonicalRequestHash({ n: 1 }), canonicalRequestHash({ n: "1" }));
  for (const bad of [{ n: NaN }, { n: Infinity }, { n: 2 ** 53 }, { n: undefined }, { n: 1n }, { n: new Date() }, { n: () => 1 }] as unknown[])
    assert.throws(() => canonicalRequestHash(bad as never), ledgerCode("INVALID_INPUT"));
});

test("commit-failure classifier: definite only for server ERROR in SQLSTATE class 23 or 40", () => {
  for (const code of ["23000", "23503", "23505", "23514", "40001", "40002", "40P01"]) assert.equal(classifyCommitFailure(dbError(code)), "definite", code);
  for (const code of ["08000", "08006", "57P01", "57014", "53300", "XX000", "25P02", "55P03", "40003"]) assert.equal(classifyCommitFailure(dbError(code)), "unknown", code);
  assert.equal(classifyCommitFailure(dbError("23505", "FATAL")), "unknown", "FATAL is never definite");
  assert.equal(classifyCommitFailure(dbError("57P01", "FATAL")), "unknown");
  assert.equal(classifyCommitFailure(new Error("Connection terminated unexpectedly")), "unknown", "no SQLSTATE");
  assert.equal(classifyCommitFailure(Object.assign(new Error("reset"), { code: "ECONNRESET" })), "unknown");
  assert.equal(classifyCommitFailure(Object.assign(new Error("pipe"), { code: "EPIPE" })), "unknown", "5-character socket codes are not SQLSTATEs");
  assert.equal(classifyCommitFailure(Object.assign(new Error("x"), { code: "23505" })), "unknown", "a code without server severity is not a server report");
  for (const odd of [null, undefined, "boom", 7]) assert.equal(classifyCommitFailure(odd), "unknown");
  // before COMMIT is sent, any server-reported ERROR is a definite rollback
  assert.equal(classifyStatementFailure(dbError("23505")), "definite"); assert.equal(classifyStatementFailure(dbError("22003")), "definite");
  assert.equal(classifyStatementFailure(dbError("57P01", "FATAL")), "unknown"); assert.equal(classifyStatementFailure(new Error("socket")), "unknown");
});

test("business rejections: only persistable codes can be constructed", () => {
  for (const code of PERSISTABLE_REJECTION_CODES) assert.equal(new LedgerBusinessRejection(code).code, code);
  for (const bad of ["NOT_FOUND", "IDEMPOTENCY_CONFLICT", "LEDGER_OUTCOME_UNKNOWN", "TRANSIENT", "nonsense"]) assert.throws(() => new LedgerBusinessRejection(bad as never), ledgerCode("INVALID_INPUT"), bad);
});

test("invalid input is rejected before any connection or SQL is used", async () => {
  const userId = randomUUID();
  let touched = 0;
  const db: LedgerDb = { acquire: async () => { touched++; throw new Error("must not connect"); } };
  const base = { actor: "system" as const, component: "synthetic-test", expectedUserId: userId, userId, commandKind: "grant_credits", idempotencyKey: key("unit"), payload: { x: 1 } };
  const run = (spec: Parameters<typeof runLedgerCommand>[1]) => runLedgerCommand(db, spec, async () => undefined);
  await assert.rejects(run({ ...base, idempotencyKey: "short" }), ledgerCode("INVALID_INPUT"));
  await assert.rejects(run({ ...base, idempotencyKey: "has space and bad chars!!" }), ledgerCode("INVALID_INPUT"));
  await assert.rejects(run({ ...base, commandKind: "Bad Kind" }), ledgerCode("INVALID_INPUT"));
  await assert.rejects(run({ ...base, userId: "not-a-uuid", expectedUserId: "not-a-uuid" }), ledgerCode("INVALID_INPUT"));
  await assert.rejects(run({ ...base, userId: userId.toUpperCase(), expectedUserId: userId.toUpperCase() }), ledgerCode("INVALID_INPUT"), "uppercase uuid would fork the idempotency scope");
  await assert.rejects(run({ ...base, expectedUserId: randomUUID() }), ledgerCode("INVALID_INPUT"), "actor must expect the command user");
  await assert.rejects(run({ ...base, payload: { n: NaN } }), ledgerCode("INVALID_INPUT"));
  await assert.rejects(run({ actor: "customer", userId, commandKind: "x_y", idempotencyKey: key("unit"), payload: { n: 2 ** 53 } }), ledgerCode("INVALID_INPUT"));
  assert.equal(touched, 0);
  const tx: LedgerTx = { commandId: randomUUID(), userId, actor: "system", query: async () => { touched++; throw new Error("must not query"); } };
  const grant = { grantSourceId: randomUUID(), sourceRef: "ref-1", units: SYNTHETIC_UNITS };
  for (const bad of [{ ...grant, units: NaN }, { ...grant, units: -1 }, { ...grant, units: 0 }, { ...grant, units: 1.5 }, { ...grant, units: 2 ** 53 }, { ...grant, units: "5" as never }, { ...grant, sourceRef: "bad ref!" }, { ...grant, sourceRef: "" }, { ...grant, grantSourceId: "nope" }])
    await assert.rejects(appendGrantEntry(tx, bad), ledgerCode("INVALID_INPUT"));
  await assert.rejects(appendGrantEntry({ ...tx, actor: "customer" }, grant), ledgerCode("INVALID_TRANSITION"), "a customer actor can never grant");
  assert.equal(touched, 0);
  await assert.rejects(ensureWallet({ query: async () => { touched++; throw new Error("no"); } }, "nope"), ledgerCode("INVALID_INPUT"));
  await assert.rejects(getWalletSummary({ query: async () => { touched++; throw new Error("no"); } }, "nope"), ledgerCode("INVALID_INPUT"));
  assert.equal(touched, 0);
});

// ---- database tests (CI `foundation` job only; locally NOT_RUN unless a throwaway server is supplied) ---------------------------

const raw = (client: Client, sql: string, values?: unknown[]) => client.query(sql, values);
const either = (...codes: string[]) => (e: unknown) => codes.includes((e as { code?: string }).code ?? "");
const sqlstate = (code: string, pattern?: RegExp) => (e: unknown) => (e as { code?: string }).code === code && (!pattern || pattern.test((e as Error).message));

test("wallet, command log and ledger enforce their invariants in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client = await freshLedger("core");
  let pool!: Pool; // created inside the try so a failed probe cannot leak the client or the database
  const ctx = { client, get pool() { return pool as Pool; } };
  try {
    const sized = await ledgerPool("core", "standard"); pool = sized.pool; const degraded = sized.degraded;
    assert.equal(degraded, false, "the standard pool fits the server's connection limit");
    await t.test("migration leaves no grant source, wallet, command or entry", async () => {
      for (const table of ["ledger_grant_sources", "wallets", "ledger_commands", "ledger_entries"]) assert.equal((await raw(client, `SELECT count(*)::int AS n FROM vynvori_ledger.${table}`)).rows[0].n, 0, table);
    });

    const alice = await syntheticProfileWithWallet(client), bob = await syntheticProfileWithWallet(client);
    const source = await registerSyntheticGrantSource(client);
    const rawCommand = async (userId: string, outcome: "applied" | "rejected" = "applied") => {
      const id = randomUUID(), kind = "raw_probe";
      await raw(client, "INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome,rejection_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, `${userId}:${kind}`, key("raw"), "a".repeat(64), userId, kind, outcome, outcome === "rejected" ? "INSUFFICIENT_CREDITS" : null]);
      return id;
    };
    const insertEntry = (o: Record<string, unknown>) => {
      const e = { entry_id: randomUUID(), kind: "grant", da: 5, dr: 0, dh: 0, dc: 0, de: -5, src: source, ref: key("ref"), res: null, ek: null, er: null, cause_kind: "grant", ...o } as Record<string, unknown>;
      const ref = e["ref"] as string | null, causeRef = e["cause_ref"] ?? (e["src"] && ref ? `${e["src"]}:${ref}` : "x");
      return raw(client, `INSERT INTO vynvori_ledger.ledger_entries(entry_id,user_id,command_id,entry_kind,delta_available,delta_reserved,delta_held,delta_consumed,delta_external,grant_source_id,source_ref,reservation_id,evidence_kind,evidence_ref,cause_kind,cause_ref)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [e["entry_id"], e["user"], e["command"], e["kind"], e["da"], e["dr"], e["dh"], e["dc"], e["de"], e["src"], e["ref"], e["res"], e["ek"], e["er"], e["cause_kind"], causeRef]);
    };

    await t.test("wallets: creation with credits, direct update, delete and truncate are rejected; missing profile is rejected", async () => {
      const other = randomUUID();
      await raw(client, "INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES($1,'https://synthetic.invalid',$2)", [other, "s-" + other]);
      for (const column of ["available_units", "reserved_units", "held_for_review_units", "consumed_units", "revision"])
        await assert.rejects(raw(client, `INSERT INTO vynvori_ledger.wallets(user_id, ${column}) VALUES($1, 5)`, [other]), sqlstate("23000", /created empty/), column);
      for (const column of ["available_units", "reserved_units", "held_for_review_units", "consumed_units", "revision"])
        await assert.rejects(raw(client, `UPDATE vynvori_ledger.wallets SET ${column} = ${column} + 1 WHERE user_id = $1`, [alice]), sqlstate("23000", /only through ledger entries/), column);
      await assert.rejects(raw(client, "UPDATE vynvori_ledger.wallets SET created_at = now() WHERE user_id = $1", [alice]), sqlstate("23000"));
      await assert.rejects(raw(client, "UPDATE vynvori_ledger.wallets SET available_units = 0 WHERE user_id = $1", [alice]), sqlstate("23000"), "even a no-op value change is rejected");
      await assert.rejects(raw(client, "DELETE FROM vynvori_ledger.wallets WHERE user_id = $1", [alice]), sqlstate("23000", /append-only/));
      await assert.rejects(raw(client, "TRUNCATE vynvori_ledger.wallets"), (e: unknown) => ["23000", "0A000"].includes((e as { code?: string }).code ?? ""), "rejected by the trigger or, because wallets is FK-referenced, by PostgreSQL itself");
      await assert.rejects(raw(client, "INSERT INTO vynvori_ledger.wallets(user_id) VALUES($1)", [randomUUID()]), sqlstate("23503"), "FK to a non-existent profile");
      await assert.rejects(ensureWallet(client, randomUUID()), ledgerCode("NOT_FOUND"), "a guest has no profile and therefore no wallet");
      assert.deepEqual(await ensureWallet(client, other), { created: true }); assert.deepEqual(await ensureWallet(client, other), { created: false });
      await assert.rejects(raw(client, "DELETE FROM vynvori_identity.profiles WHERE id = $1", [other]), sqlstate("23503"), "ON DELETE RESTRICT");
    });

    await t.test("entries: malformed, unbalanced, over-bound, non-grant and unregistered-source entries are rejected; control insert succeeds", async () => {
      const command = await rawCommand(alice), base = { user: alice, command };
      const bad = (o: Record<string, unknown>, code: string, label: string) => assert.rejects(insertEntry({ ...base, ...o }), sqlstate(code), label);
      await bad({ de: -4 }, "23514", "unbalanced");
      await bad({ da: -5, de: 5 }, "23514", "grant with negative available");
      await bad({ da: 0, de: 0 }, "23514", "zero grant");
      await bad({ da: 5, dr: 1, de: -6 }, "23514", "grant touching reserved");
      await bad({ da: 5, dc: 1, de: -6 }, "23514", "grant touching consumed");
      await bad({ da: 9007199254740992, de: -9007199254740992 }, "23514", "over the safe-integer bound");
      await bad({ src: null }, "23514", "grant without a source");
      await bad({ ref: null, cause_ref: "x" }, "23514", "grant without a source_ref");
      await bad({ ref: "bad ref!" }, "23514", "source_ref shape");
      await bad({ ek: "e", er: "r", res: randomUUID() }, "23514", "grant carrying reservation evidence");
      await bad({ cause_kind: "other" }, "23514", "grant with the wrong cause kind");
      await bad({ cause_ref: "forged" }, "23514", "grant whose cause_ref is not source:ref");
      await bad({ src: randomUUID() }, "23503", "grant source that is not registered");
      for (const [kind, shape] of [["reserve", { da: -5, dr: 5, de: 0 }], ["release", { da: 5, dr: -5, de: 0 }], ["settle", { da: 2, dr: -5, dc: 3, de: 0 }], ["hold", { da: 0, dr: -5, dh: 5, de: 0 }]] as const) {
        const reservation = randomUUID();
        await bad({ kind, ...shape, src: null, ref: null, res: reservation, ek: "synthetic", er: "synthetic", cause_kind: "reservation", cause_ref: `${reservation}:${kind}` }, "23514", `${kind} is blocked by ledger_entries_s2_grant_only until S5`);
      }
      await assert.rejects(insertEntry({ ...base, user: bob }), either("23000", "23503"), "command of another user");
      await assert.rejects(insertEntry({ ...base, command: randomUUID() }), either("23000", "23503"), "unknown command");
      await assert.rejects(insertEntry({ ...base, command: await rawCommand(alice, "rejected") }), sqlstate("23000", /applied command/), "a rejected command can never own an entry");
      await assert.rejects(insertEntry({ ...base, user: randomUUID() }), either("23000", "23503"), "no wallet");
      const ok = { ...base, entry_id: randomUUID(), ref: key("control") };
      await insertEntry(ok);
      assert.equal((await getWalletSummary(client, alice)).availableUnits, 5);
      await assert.rejects(insertEntry({ ...base, ref: ok.ref }), sqlstate("23505"), "duplicate cause (same source + ref)");
      assert.equal((await getWalletSummary(client, alice)).availableUnits, 5, "rejected inserts changed nothing");
    });

    await t.test("append-only and immutable: entries, commands and grant sources reject UPDATE, DELETE and TRUNCATE", async () => {
      await grantSyntheticCredits(pool, { userId: alice, grantSourceId: source, sourceRef: "immutability-seed", units: SYNTHETIC_UNITS }); // rows must exist for row-level triggers to fire
      for (const sql of [
        "UPDATE vynvori_ledger.ledger_entries SET source_ref = source_ref", "DELETE FROM vynvori_ledger.ledger_entries", "TRUNCATE vynvori_ledger.ledger_entries",
        "UPDATE vynvori_ledger.ledger_commands SET outcome = outcome", "DELETE FROM vynvori_ledger.ledger_commands", "TRUNCATE vynvori_ledger.ledger_commands",
        "UPDATE vynvori_ledger.ledger_grant_sources SET label = 'x'", "DELETE FROM vynvori_ledger.ledger_grant_sources", "TRUNCATE vynvori_ledger.ledger_grant_sources",
      ]) await assert.rejects(raw(client, sql), either("23000", "0A000"), sql); // TRUNCATE of an FK-referenced table is stopped by PostgreSQL (0A000) before the trigger
      for (const sql of ["UPDATE vynvori_ledger.ledger_entries SET source_ref = source_ref", "DELETE FROM vynvori_ledger.ledger_commands", "UPDATE vynvori_ledger.ledger_grant_sources SET label = 'x'"]) await assert.rejects(raw(client, sql), sqlstate("23000", /append-only/), sql);
      await assert.rejects(raw(client, "TRUNCATE vynvori_ledger.ledger_entries, vynvori_ledger.wallets CASCADE"), sqlstate("23000"));
      await assert.rejects(raw(client, "INSERT INTO vynvori_ledger.ledger_grant_sources(grant_source_id,kind,label) VALUES($1,'not_a_kind','x')", [randomUUID()]), sqlstate("23514"));
      await assert.rejects(raw(client, "INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,'wrong-scope',$2,$3,$4,'raw_probe','applied')", [randomUUID(), key("k"), "a".repeat(64), alice]), sqlstate("23514"), "scope must be user:kind");
      await assert.rejects(raw(client, "INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,'XYZ',$4,'raw_probe','applied')", [randomUUID(), `${alice}:raw_probe`, key("k"), alice]), sqlstate("23514"), "hash shape");
      await assert.rejects(raw(client, "INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,$4,$5,'raw_probe','rejected')", [randomUUID(), `${alice}:raw_probe`, key("k"), "a".repeat(64), alice]), sqlstate("23514"), "rejection needs a code");
    });

    await t.test("a negative or overflowing bucket result is stopped by the wallet CHECKs even if the shape CHECK were removed", async () => {
      const user = await syntheticProfileWithWallet(client), command = await rawCommand(user), reservation = randomUUID();
      await raw(client, "BEGIN");
      try {
        await raw(client, "ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_s2_grant_only");
        await raw(client, "SAVEPOINT s");
        await assert.rejects(insertEntry({ user, command, kind: "reserve", da: -5, dr: 5, de: 0, src: null, ref: null, res: reservation, ek: "synthetic", er: "synthetic", cause_kind: "reservation", cause_ref: `${reservation}:reserve` }),
          sqlstate("23514", /wallets_available_bounds/), "reserve with no funds -> negative available");
        await raw(client, "ROLLBACK TO SAVEPOINT s");
      } finally { await raw(client, "ROLLBACK"); }
      assert.equal((await raw(client, "SELECT count(*)::int AS n FROM pg_constraint WHERE conname='ledger_entries_s2_grant_only'")).rows[0].n, 1, "the temporary constraint is back after the rollback");
      const big = await syntheticProfileWithWallet(client);
      await grantSyntheticCredits(pool, { userId: big, grantSourceId: source, sourceRef: "big-1", units: 9007199254740991 });
      await assert.rejects(grantSyntheticCredits(pool, { userId: big, grantSourceId: source, sourceRef: "big-2", units: 1 }), (e: unknown) => e instanceof LedgerError && e.code === "DATABASE_REJECTED" && e.sqlstate === "23514", "available would exceed 2^53-1");
      assert.equal((await getWalletSummary(client, big)).availableUnits, 9007199254740991);
    });

    await t.test("wallet buckets equal the sum of entry deltas after N grants; revision increments once per entry", async () => {
      const user = await syntheticProfileWithWallet(client);
      let seed = 12345; const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
      const units = Array.from({ length: 25 }, () => (next() % 1000) + 1);
      for (const [i, n] of units.entries()) await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "rand-" + i, units: n });
      const row = (await raw(client, `SELECT w.available_units::text a, w.reserved_units::text r, w.held_for_review_units::text h, w.consumed_units::text c, w.revision::text rev,
        (SELECT sum(delta_available)::text FROM vynvori_ledger.ledger_entries WHERE user_id=w.user_id) sa, (SELECT sum(delta_external)::text FROM vynvori_ledger.ledger_entries WHERE user_id=w.user_id) se,
        (SELECT count(*)::text FROM vynvori_ledger.ledger_entries WHERE user_id=w.user_id) n FROM vynvori_ledger.wallets w WHERE user_id=$1`, [user])).rows[0];
      const total = units.reduce((a, b) => a + b, 0);
      assert.deepEqual({ a: row.a, r: row.r, h: row.h, c: row.c, rev: row.rev, sa: row.sa, se: row.se, n: row.n }, { a: String(total), r: "0", h: "0", c: "0", rev: "25", sa: String(total), se: String(-total), n: "25" });
      const summary = await getWalletSummary(client, user);
      assert.deepEqual({ ...summary, snapshotAt: "" }, { unit: "credits", availableUnits: total, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: "", walletRevision: "25" });
      assert.ok(!Number.isNaN(Date.parse(summary.snapshotAt)));
      await assert.rejects(getWalletSummary(client, randomUUID()), ledgerCode("NOT_FOUND"), "absent wallet");
    });

    await t.test("idempotency: same key + payload -> one entry; different payload -> conflict; users independent; no unregistered grants", async () => {
      const user = await syntheticProfileWithWallet(client), other = await syntheticProfileWithWallet(client), k = key("idem");
      const first = await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "idem-1", units: SYNTHETIC_UNITS, idempotencyKey: k });
      const again = await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "idem-1", units: SYNTHETIC_UNITS, idempotencyKey: k });
      assert.equal(first.replayed, false); assert.equal(again.replayed, true);
      assert.equal(again.commandId, first.commandId); assert.equal(first.entries.length, 1);
      assert.deepEqual(again.entries, first.entries, "replay reconstructs the result from the stored entries");
      assert.equal((await getWalletSummary(client, user)).availableUnits, SYNTHETIC_UNITS);
      await assert.rejects(grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "idem-1", units: SYNTHETIC_UNITS + 1, idempotencyKey: k }), ledgerCode("IDEMPOTENCY_CONFLICT"));
      await assert.rejects(grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "idem-2", units: SYNTHETIC_UNITS, idempotencyKey: k }), ledgerCode("IDEMPOTENCY_CONFLICT"));
      assert.equal((await getWalletSummary(client, user)).availableUnits, SYNTHETIC_UNITS, "conflicts mutate nothing");
      const independent = await grantSyntheticCredits(pool, { userId: other, grantSourceId: source, sourceRef: "idem-1-other", units: 2 * SYNTHETIC_UNITS, idempotencyKey: k });
      assert.equal(independent.replayed, false, "the same key for another user is a different scope");
      assert.equal((await getWalletSummary(client, other)).availableUnits, 2 * SYNTHETIC_UNITS);
      // the same source_ref under a NEW key is a duplicate cause, not a second grant
      await assert.rejects(grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "idem-1", units: SYNTHETIC_UNITS }), ledgerCode("DUPLICATE_CAUSE"));
      assert.equal((await getWalletSummary(client, user)).availableUnits, SYNTHETIC_UNITS);
      await assert.rejects(grantSyntheticCredits(pool, { userId: user, grantSourceId: randomUUID(), sourceRef: "idem-3", units: SYNTHETIC_UNITS }), ledgerCode("GRANT_SOURCE_UNREGISTERED"));
      const commands = (await raw(client, "SELECT count(*)::int n FROM vynvori_ledger.ledger_commands WHERE user_id=$1", [user])).rows[0].n;
      assert.equal(commands, 1, "failed attempts left no command rows");
      // customer actors and wallet-less users
      await assert.rejects(runLedgerCommand(pool, { actor: "customer", userId: user, commandKind: "grant_credits", idempotencyKey: key("cust"), payload: {} },
        tx => appendGrantEntry(tx, { grantSourceId: source, sourceRef: "cust-1", units: 1 }).then(() => undefined)), ledgerCode("INVALID_TRANSITION"));
      const guest = randomUUID();
      await assert.rejects(runLedgerCommand(pool, { actor: "customer", userId: guest, commandKind: "noop", idempotencyKey: key("guest"), payload: {} }, async () => undefined), ledgerCode("NOT_FOUND"));
      assert.equal((await getWalletSummary(client, user)).availableUnits, SYNTHETIC_UNITS);
    });

    await t.test("persisted business rejection replays identically, never re-runs the callback, and cannot succeed after the wallet is funded", async () => {
      const user = await syntheticProfileWithWallet(client), k = key("reject");
      let executions = 0;
      // SYNTHETIC stand-in for a future authorization: needs SYNTHETIC_UNITS available, otherwise a terminal business rejection.
      const press = (idempotencyKey: string) => runLedgerCommand(pool, { actor: "customer", userId: user, commandKind: "synthetic_press", idempotencyKey, payload: { need: SYNTHETIC_UNITS } }, async tx => {
        executions++;
        const available = (await tx.query("SELECT available_units::text a FROM vynvori_ledger.wallets WHERE user_id=$1", [tx.userId])).rows[0]!["a"];
        if (BigInt(String(available)) < BigInt(SYNTHETIC_UNITS)) throw new LedgerBusinessRejection("INSUFFICIENT_CREDITS");
      });
      await assert.rejects(press(k), (e: unknown) => e instanceof LedgerBusinessRejection && e.code === "INSUFFICIENT_CREDITS" && !e.replayed);
      assert.equal(executions, 1);
      const stored = (await raw(client, "SELECT outcome, rejection_code FROM vynvori_ledger.ledger_commands WHERE user_id=$1", [user])).rows;
      assert.deepEqual(stored, [{ outcome: "rejected", rejection_code: "INSUFFICIENT_CREDITS" }]);
      await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "fund-1", units: 5 * SYNTHETIC_UNITS });
      await assert.rejects(press(k), (e: unknown) => e instanceof LedgerBusinessRejection && e.code === "INSUFFICIENT_CREDITS" && e.replayed, "stale replay stays rejected after funding");
      assert.equal(executions, 1, "the callback never runs again for a recorded key");
      await assert.rejects(runLedgerCommand(pool, { actor: "customer", userId: user, commandKind: "synthetic_press", idempotencyKey: k, payload: { need: SYNTHETIC_UNITS + 1 } }, async () => undefined), ledgerCode("IDEMPOTENCY_CONFLICT"));
      const fresh = await press(key("reject-new"));
      assert.equal(fresh.replayed, false); assert.equal(executions, 2, "a new press with a new key runs and succeeds");
    });

    await t.test("transient and unexpected failures roll back fully and are not recorded; the same key works afterwards", async () => {
      const user = await syntheticProfileWithWallet(client), k = key("transient");
      const spec = { actor: "system" as const, component: "synthetic-test", expectedUserId: user, userId: user, commandKind: "grant_credits", idempotencyKey: k, payload: { n: 1 } };
      const grant = (ref: string) => (tx: LedgerTx) => appendGrantEntry(tx, { grantSourceId: source, sourceRef: ref, units: SYNTHETIC_UNITS }).then(() => undefined);
      const count = async () => (await raw(client, "SELECT (SELECT count(*) FROM vynvori_ledger.ledger_commands WHERE user_id=$1)::int c, (SELECT count(*) FROM vynvori_ledger.ledger_entries WHERE user_id=$1)::int e", [user])).rows[0];
      await assert.rejects(runLedgerCommand(pool, spec, async tx => { await grant("tr-1")(tx); throw dbError("40001"); }), ledgerCode("TRANSIENT"));
      await assert.rejects(runLedgerCommand(pool, spec, async tx => { await grant("tr-1")(tx); throw dbError("40P01"); }), ledgerCode("TRANSIENT"));
      await assert.rejects(runLedgerCommand(pool, spec, async tx => { await grant("tr-1")(tx); throw dbError("55P03"); }), ledgerCode("TRANSIENT"));
      await assert.rejects(runLedgerCommand(pool, spec, async tx => { await grant("tr-1")(tx); throw new TypeError("programming error"); }), ledgerCode("DATABASE_ERROR"));
      assert.deepEqual(await count(), { c: 0, e: 0 });
      assert.equal((await runLedgerCommand(pool, spec, grant("tr-1"))).replayed, false);
      assert.deepEqual(await count(), { c: 1, e: 1 });
    });

    await t.test("a retained transaction handle is dead after the command ends", async () => {
      const user = await syntheticProfileWithWallet(client); let kept: LedgerTx | undefined;
      await runLedgerCommand(pool, { actor: "customer", userId: user, commandKind: "handle_probe", idempotencyKey: key("handle"), payload: {} }, async tx => { kept = tx; });
      await assert.rejects(kept!.query("SELECT 1"), ledgerCode("INVALID_TRANSITION"));
    });

    await t.test("a deferred-constraint failure surfaces before COMMIT as a definite error, not LEDGER_OUTCOME_UNKNOWN", async () => {
      await raw(client, "CREATE TABLE public.s2_deferred_probe(id int, CONSTRAINT s2_deferred_unique UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)");
      const user = await syntheticProfileWithWallet(client), k = key("deferred");
      const run = () => runLedgerCommand(pool, { actor: "customer", userId: user, commandKind: "deferred_probe", idempotencyKey: k, payload: {} },
        async tx => { await tx.query("INSERT INTO public.s2_deferred_probe VALUES (1)"); await tx.query("INSERT INTO public.s2_deferred_probe VALUES (1)"); });
      await assert.rejects(run(), (e: unknown) => e instanceof LedgerError && e.code === "DATABASE_REJECTED" && e.sqlstate === "23505");
      assert.equal((await raw(client, "SELECT count(*)::int n FROM public.s2_deferred_probe")).rows[0].n, 0, "nothing committed");
      assert.equal((await raw(client, "SELECT count(*)::int n FROM vynvori_ledger.ledger_commands WHERE user_id=$1", [user])).rows[0].n, 0, "a definite database rejection is not recorded under the key");
      await raw(client, "DROP TABLE public.s2_deferred_probe");
    });

    /** Connection source that runs the real statements but lets a test inject a fault around one of them. */
    const faulty = (hook: (text: string, conn: PoolClient) => Promise<void>, after?: (text: string, conn: PoolClient) => Promise<void>): LedgerDb => ({
      acquire: async (): Promise<LedgerConn> => {
        const conn = await ctx.pool.connect(); conn.on("error", () => undefined);
        return { query: async (text, values) => { await hook(text, conn); const result = await conn.query(text, values); await after?.(text, conn); return result as never; }, release: destroy => conn.release(destroy) };
      },
    });
    const entriesFor = async (user: string) => (await raw(client, "SELECT count(*)::int n FROM vynvori_ledger.ledger_entries WHERE user_id=$1", [user])).rows[0].n as number;

    await t.test("connection lost AFTER COMMIT was sent -> LEDGER_OUTCOME_UNKNOWN; replaying the same key converges on one entry", async () => {
      const user = await syntheticProfileWithWallet(client), k = key("lostcommit");
      const db = faulty(async () => undefined, async text => { if (text === "COMMIT") throw new Error("Connection terminated unexpectedly"); });
      await assert.rejects(grantSyntheticCredits(db, { userId: user, grantSourceId: source, sourceRef: "lost-1", units: SYNTHETIC_UNITS, idempotencyKey: k }), ledgerCode("LEDGER_OUTCOME_UNKNOWN"));
      assert.equal(await entriesFor(user), 1, "the commit had in fact happened");
      const replay = await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "lost-1", units: SYNTHETIC_UNITS, idempotencyKey: k });
      assert.equal(replay.replayed, true); assert.equal(await entriesFor(user), 1);
      assert.equal((await getWalletSummary(client, user)).availableUnits, SYNTHETIC_UNITS);
    });

    await t.test("COMMIT answered by a server error: class 23/40 ERROR is definite, anything else is unknown", async () => {
      const user = await syntheticProfileWithWallet(client);
      const failing = (error: unknown) => faulty(async text => { if (text === "COMMIT") throw error; });
      await assert.rejects(grantSyntheticCredits(failing(dbError("23505")), { userId: user, grantSourceId: source, sourceRef: "cf-1", units: 1 }), (e: unknown) => e instanceof LedgerError && e.code === "DATABASE_REJECTED");
      await assert.rejects(grantSyntheticCredits(failing(dbError("40001")), { userId: user, grantSourceId: source, sourceRef: "cf-2", units: 1 }), ledgerCode("TRANSIENT"));
      for (const error of [dbError("57P01", "FATAL"), dbError("08006"), dbError("XX000"), new Error("socket hang up")])
        await assert.rejects(grantSyntheticCredits(failing(error), { userId: user, grantSourceId: source, sourceRef: "cf-3", units: 1 }), ledgerCode("LEDGER_OUTCOME_UNKNOWN"));
      assert.equal(await entriesFor(user), 0, "COMMIT was never executed in these injections");
    });

    await t.test("backend terminated before COMMIT -> LEDGER_OUTCOME_UNKNOWN; the replay applies exactly once", async () => {
      const user = await syntheticProfileWithWallet(client), k = key("killed");
      const db = faulty(async (text, conn) => {
        if (text !== "SET CONSTRAINTS ALL IMMEDIATE") return;
        const pid = (await conn.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
        await raw(client, "SELECT pg_terminate_backend($1)", [pid]);
        for (let i = 0; i < 100 && (await raw(client, "SELECT 1 FROM pg_stat_activity WHERE pid=$1", [pid])).rows.length; i++) await new Promise(resolve => setTimeout(resolve, 50)); // wait until the backend is really gone
      });
      await assert.rejects(grantSyntheticCredits(db, { userId: user, grantSourceId: source, sourceRef: "kill-1", units: SYNTHETIC_UNITS, idempotencyKey: k }), ledgerCode("LEDGER_OUTCOME_UNKNOWN"));
      assert.equal(await entriesFor(user), 0, "the terminated transaction rolled back");
      const replay = await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "kill-1", units: SYNTHETIC_UNITS, idempotencyKey: k });
      assert.equal(replay.replayed, false); assert.equal(await entriesFor(user), 1);
      assert.equal((await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "kill-1", units: SYNTHETIC_UNITS, idempotencyKey: k })).replayed, true);
      assert.equal(await entriesFor(user), 1);
    });
  } finally { await pool?.end().catch(() => undefined); await client.end().catch(() => undefined); await dropLedger("core"); }
});
