import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PLANE_C_PROMO_GRAPH, canTransitionPlaneCPromo, type PlaneCPromoState } from "@vynvori/contracts";
import { LedgerBusinessRejection, LedgerError } from "../src/ledger-core";
import { claimPromo, getPromoClaim, markPromoOutcome, type MarkPromoOutcomeInput } from "../src/ledger-promo";
import { dropLedger, freshLedger, grantSyntheticCredits, ledgerPool, ledgerPoolAs, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet } from "./ledger-fixture";

/**
 * ADR-0021 S4 addendum: promo_claims / promo_claim_events DDL + store behaviour (D8). Non-concurrency file: pool capped at 5 (D15);
 * declared peak connections = 5 (pool) + 1 (persistent fixture client) + 2 (restricted-role pool) = 8. No SYNTHETIC credit value is
 * exported from src/: the only numbers below are test-local.
 */
const SYNTHETIC_GRANT_UNITS = 5;
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
const rejection = (c: string, replayed?: boolean) => (e: unknown) => e instanceof LedgerBusinessRejection && e.code === c && (replayed === undefined || e.replayed === replayed);
const sqlCode = (c: string) => (e: unknown) => (e as { code?: string }).code === c;
/** BEFORE triggers run ahead of CHECK and foreign-key checks, so several defences can be the one that fires; any of them is a rejection at the database. */
const anyOf = (...codes: string[]) => (e: unknown) => codes.includes((e as { code?: string }).code ?? "");
const key = (label: string) => `${label}-${randomUUID()}`;
const operation = () => "promo-op-" + randomUUID();
type Evidence = MarkPromoOutcomeInput["evidence"];
const evidence = (operationId: string, evidenceKind: Evidence["evidenceKind"], flags: { manifest?: boolean; rights?: boolean } = {}): Evidence =>
  ({ operationId, evidenceRef: "evidence-" + randomUUID(), evidenceKind, hasVerifiedManifestHash: flags.manifest ?? false, ownerAndRightsVerified: flags.rights ?? false });
const delivered = (operationId: string, evidenceKind: "persisted_delivered" | "reconciled_delivered") => evidence(operationId, evidenceKind, { manifest: true, rights: true });
const STATES = [...PLANE_C_PROMO_GRAPH.keys()] as PlaneCPromoState[];

// ---- no database needed ---------------------------------------------------------------------------------------------

test("ledger-promo source: only promo tables are written; no wallet, ledger-entry, grant-source, quote or reservation SQL; no raw state UPDATE", () => {
  const text = readFileSync(new URL("../src/ledger-promo.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(text, /\b(wallets|ledger_entries|ledger_grant_sources|ledger_quote\w*|credit_reservations|appendGrantEntry)\b/, "a promo never reads or writes a wallet, entry, source, quote or reservation");
  assert.doesNotMatch(text, /\b(UPDATE|DELETE\s+FROM|TRUNCATE)\s+\S*promo_claim/i, "claim state changes only by inserting events; no direct UPDATE/DELETE in code");
  assert.doesNotMatch(text, /session_replication_role|DISABLE\s+TRIGGER|SECURITY\s+DEFINER/i);
  assert.equal([...text.matchAll(/INSERT\s+INTO\s+\S*promo_claim_events/gi)].length, 2, "exactly two event writers: claimPromo and markPromoOutcome");
  assert.equal([...text.matchAll(/INSERT\s+INTO\s+\S*promo_claims\b/gi)].length, 1, "exactly one claim writer: claimPromo");
  assert.doesNotMatch(text, /VYNVORI_|process\.env/, "no flag, no environment access");
});

test("input shapes are rejected as INVALID_INPUT before any database call", async () => {
  const tripwire = { query: async () => { throw new Error("database must not be reached"); }, acquire: async () => { throw new Error("database must not be reached"); } };
  const user = randomUUID(), op = operation();
  await assert.rejects(claimPromo(tripwire, { userId: "not-a-uuid", operationId: op, idempotencyKey: key("shape") }), code("INVALID_INPUT"));
  await assert.rejects(claimPromo(tripwire, { userId: user.toUpperCase(), operationId: op, idempotencyKey: key("shape") }), code("INVALID_INPUT"), "uppercase uuid");
  for (const bad of ["", "has space", "x".repeat(129), "emoji-😀"]) await assert.rejects(claimPromo(tripwire, { userId: user, operationId: bad, idempotencyKey: key("shape") }), code("INVALID_INPUT"), JSON.stringify(bad));
  const base = { userId: user, claimId: randomUUID(), idempotencyKey: key("shape"), outcome: "consumed" as const, evidence: delivered(op, "persisted_delivered") };
  await assert.rejects(markPromoOutcome(tripwire, { ...base, userId: "x" }), code("INVALID_INPUT"));
  await assert.rejects(markPromoOutcome(tripwire, { ...base, claimId: "x" }), code("INVALID_INPUT"));
  await assert.rejects(markPromoOutcome(tripwire, { ...base, outcome: "claim_reserved" as never }), code("INVALID_INPUT"), "claim_reserved is not an outcome");
  await assert.rejects(markPromoOutcome(tripwire, { ...base, outcome: "eligible" as never }), code("INVALID_INPUT"));
  await assert.rejects(markPromoOutcome(tripwire, { ...base, evidence: { ...base.evidence, evidenceKind: "vendor_charge_message" as never } }), code("INVALID_INPUT"), "a vendor-charge message is not an evidence kind");
  await assert.rejects(markPromoOutcome(tripwire, { ...base, evidence: { ...base.evidence, evidenceRef: "" } }), code("INVALID_INPUT"));
  await assert.rejects(markPromoOutcome(tripwire, { ...base, evidence: { ...base.evidence, evidenceRef: "x".repeat(256) } }), code("INVALID_INPUT"));
  await assert.rejects(markPromoOutcome(tripwire, { ...base, evidence: null as never }), code("INVALID_INPUT"));
});

// ---- disposable PostgreSQL --------------------------------------------------------------------------------------------

test("promo claims: DDL + store behaviour in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client = await freshLedger("promo");
  const { pool } = await ledgerPool("promo", "standard");
  let restrictedPool: Awaited<ReturnType<typeof ledgerPoolAs>> | undefined;
  const role = "m7_promo_rt_" + randomBytes(6).toString("hex"); // roles are cluster-global: never a fixed name
  let roleCreated = false;

  const profileOnly = async (issuer = "https://synthetic.invalid", subject = "synthetic-" + randomUUID()) => {
    const id = randomUUID();
    await client.query("INSERT INTO vynvori_identity.profiles(id, issuer, subject) VALUES($1,$2,$3)", [id, issuer, subject]);
    return { id, issuer, subject };
  };
  const claimFor = async (state: PlaneCPromoState) => {
    const userId = await syntheticProfileWithWallet(client), operationId = operation();
    if (state === "eligible") { // an eligible claim with no events exists only through raw SQL
      const { rows } = await client.query("SELECT issuer, subject FROM vynvori_identity.profiles WHERE id = $1", [userId]);
      const claimId = randomUUID();
      await client.query("INSERT INTO vynvori_ledger.promo_claims(claim_id,user_id,issuer,subject,operation_id,state,event_seq) VALUES($1,$2,$3,$4,$5,'eligible',0)", [claimId, userId, rows[0].issuer, rows[0].subject, operationId]);
      return { userId, claimId, operationId };
    }
    const { claim } = await claimPromo(pool, { userId, operationId, idempotencyKey: key("setup-claim") });
    const move = (outcome: "consumed" | "verified_uncharged_failure" | "claim_unknown", ev: Evidence) => markPromoOutcome(pool, { userId, claimId: claim.claimId, idempotencyKey: key("setup-outcome"), outcome, evidence: ev });
    if (state === "consumed") await move("consumed", delivered(operationId, "persisted_delivered"));
    if (state === "verified_uncharged_failure") await move("verified_uncharged_failure", evidence(operationId, "verified_zero_charge_failure"));
    if (state === "claim_unknown") await move("claim_unknown", evidence(operationId, "outcome_unknown"));
    return { userId, claimId: claim.claimId, operationId };
  };
  /** A raw, applied command row so a raw event insert can satisfy the command FK and the applied-command check. */
  const rawCommand = async (userId: string) => {
    const commandId = randomUUID();
    await client.query("INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,$4,$5,'raw_promo_probe','applied')",
      [commandId, `${userId}:raw_promo_probe`, "raw-probe-" + randomUUID(), "a".repeat(64), userId]);
    return commandId;
  };
  const rawEvent = async (c: { userId: string; claimId: string; operationId: string }, e: { seq: number; from: string; to: string; kind: string; commandId?: string }) =>
    client.query("INSERT INTO vynvori_ledger.promo_claim_events(event_id,claim_id,user_id,operation_id,seq,from_state,to_state,evidence_kind,evidence_ref,command_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'raw-evidence',$9)",
      [randomUUID(), c.claimId, c.userId, c.operationId, e.seq, e.from, e.to, e.kind, e.commandId ?? await rawCommand(c.userId)]);
  const claimRow = async (claimId: string) => (await client.query("SELECT state, event_seq FROM vynvori_ledger.promo_claims WHERE claim_id = $1", [claimId])).rows[0] as { state: string; event_seq: number };
  const count = async (table: string) => (await client.query(`SELECT count(*)::int AS n FROM vynvori_ledger.${table}`)).rows[0].n as number;
  const ledgerSnapshot = async () => ({
    wallets: (await client.query("SELECT user_id, available_units::text a, reserved_units::text r, held_for_review_units::text h, consumed_units::text c, revision::text rev, xmin::text x FROM vynvori_ledger.wallets ORDER BY user_id")).rows,
    entries: await count("ledger_entries"), sources: await count("ledger_grant_sources"), quotes: await count("ledger_quotes"), lineages: await count("ledger_quote_lineages"), allocations: await count("ledger_quote_allocations"),
  });

  try {
    await t.test("two-device race: five concurrent claims for one identity under distinct keys -> exactly one claim and one event; the rest PROMO_ALREADY_USED", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => claimPromo(pool, { userId, operationId: operation(), idempotencyKey: key("race") })));
      const fulfilled = results.filter(r => r.status === "fulfilled"), rejected = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
      assert.equal(fulfilled.length, 1, "exactly one device wins");
      assert.equal(rejected.length, 4);
      for (const r of rejected) assert.ok(rejection("PROMO_ALREADY_USED", false)(r.reason), "the losers see the persisted business rejection");
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.promo_claims WHERE user_id = $1", [userId])).rows[0].n, 1);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.promo_claim_events WHERE user_id = $1", [userId])).rows[0].n, 1);
      assert.equal((await getPromoClaim(pool, userId)).state, "claim_reserved");
    });

    await t.test("DB backstop: raw connections racing past the wallet lock insert the same identity -> the unique index admits exactly one", async () => {
      const { id, issuer, subject } = await profileOnly();
      const insert = () => pool.query("INSERT INTO vynvori_ledger.promo_claims(claim_id,user_id,issuer,subject,operation_id,state,event_seq) VALUES($1,$2,$3,$4,$5,'eligible',0)", [randomUUID(), id, issuer, subject, operation()]);
      const results = await Promise.allSettled([insert(), insert(), insert()]);
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      for (const r of results.filter(r => r.status === "rejected") as PromiseRejectedResult[]) assert.ok(sqlCode("23505")(r.reason) && (r.reason as { constraint?: string }).constraint === "promo_claims_identity_unique");
    });

    await t.test("same-key replay returns the same claim; replay after the state advanced reports the current state; a different payload under the key is IDEMPOTENCY_CONFLICT", async () => {
      const userId = await syntheticProfileWithWallet(client), operationId = operation(), idempotencyKey = key("replay");
      const first = await claimPromo(pool, { userId, operationId, idempotencyKey });
      assert.equal(first.replayed, false); assert.equal(first.claim.state, "claim_reserved"); assert.equal(first.claim.operationId, operationId);
      const again = await claimPromo(pool, { userId, operationId, idempotencyKey });
      assert.equal(again.replayed, true); assert.deepEqual(again.claim, first.claim);
      await assert.rejects(claimPromo(pool, { userId, operationId: operation(), idempotencyKey }), code("IDEMPOTENCY_CONFLICT"), "same key, different operation id");
      const outcomeKey = key("replay-outcome"), outcomeEvidence = delivered(operationId, "persisted_delivered");
      const input = { userId, claimId: first.claim.claimId, idempotencyKey: outcomeKey, outcome: "consumed" as const, evidence: outcomeEvidence };
      const consumed = await markPromoOutcome(pool, input);
      assert.equal(consumed.claim.state, "consumed"); assert.equal(consumed.replayed, false);
      const replayedOutcome = await markPromoOutcome(pool, input);
      assert.equal(replayedOutcome.replayed, true); assert.equal(replayedOutcome.claim.state, "consumed");
      await assert.rejects(markPromoOutcome(pool, { ...input, evidence: { ...outcomeEvidence, evidenceRef: "a-different-ref" } }), code("IDEMPOTENCY_CONFLICT"), "same key, different evidence");
      const replayedClaim = await claimPromo(pool, { userId, operationId, idempotencyKey });
      assert.equal(replayedClaim.replayed, true); assert.equal(replayedClaim.claim.claimId, first.claim.claimId); assert.equal(replayedClaim.claim.state, "consumed", "the replay reports the claim as it is now");
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.promo_claims WHERE user_id = $1", [userId])).rows[0].n, 1);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.promo_claim_events WHERE user_id = $1", [userId])).rows[0].n, 2);
    });

    await t.test("five concurrent same-key claims -> one execution, identical result for every caller", async () => {
      const userId = await syntheticProfileWithWallet(client), operationId = operation(), idempotencyKey = key("same-key-race");
      const results = await Promise.all(Array.from({ length: 5 }, () => claimPromo(pool, { userId, operationId, idempotencyKey })));
      assert.equal(results.filter(r => !r.replayed).length, 1, "exactly one execution; the rest replayed");
      for (const r of results) assert.equal(r.claim.claimId, results[0]!.claim.claimId);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.promo_claims WHERE user_id = $1", [userId])).rows[0].n, 1);
    });

    await t.test("a persisted PROMO_ALREADY_USED rejection replays identically under its own key", async () => {
      const userId = await syntheticProfileWithWallet(client);
      await claimPromo(pool, { userId, operationId: operation(), idempotencyKey: key("first") });
      const op = operation(), idempotencyKey = key("second");
      await assert.rejects(claimPromo(pool, { userId, operationId: op, idempotencyKey }), rejection("PROMO_ALREADY_USED", false));
      await assert.rejects(claimPromo(pool, { userId, operationId: op, idempotencyKey }), rejection("PROMO_ALREADY_USED", true));
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_commands WHERE idempotency_key = $1 AND outcome = 'rejected'", [idempotencyKey])).rows[0].n, 1, "exactly one rejected command row, not one per attempt");
    });

    await t.test("different identities are independent, including the same subject under a different issuer", async () => {
      const a = await syntheticProfileWithWallet(client), b = await syntheticProfileWithWallet(client);
      const sameSubject = "shared-subject-" + randomUUID();
      const x = await profileOnly("https://issuer-x.synthetic.invalid", sameSubject), y = await profileOnly("https://issuer-y.synthetic.invalid", sameSubject);
      const claims = await Promise.all([a, b, x.id, y.id].map(userId => claimPromo(pool, { userId, operationId: operation(), idempotencyKey: key("independent") })));
      assert.equal(new Set(claims.map(c => c.claim.claimId)).size, 4, "four identities, four claims");
      const spent = claims[0]!.claim;
      await markPromoOutcome(pool, { userId: a, claimId: spent.claimId, idempotencyKey: key("indep-out"), outcome: "consumed", evidence: delivered(spent.operationId, "persisted_delivered") });
      assert.equal((await getPromoClaim(pool, a)).state, "consumed");
      assert.equal((await getPromoClaim(pool, b)).state, "claim_reserved", "another identity is unaffected");
      assert.equal((await getPromoClaim(pool, x.id)).state, "claim_reserved");
      await assert.rejects(claimPromo(pool, { userId: a, operationId: operation(), idempotencyKey: key("indep-again") }), rejection("PROMO_ALREADY_USED"));
    });

    await t.test("a promo is never re-offered: claim_reserved, claim_unknown, verified_uncharged_failure and consumed all block a second claim", async () => {
      for (const state of ["claim_reserved", "claim_unknown", "verified_uncharged_failure", "consumed"] as const) {
        const c = await claimFor(state);
        await assert.rejects(claimPromo(pool, { userId: c.userId, operationId: operation(), idempotencyKey: key("again-" + state) }), rejection("PROMO_ALREADY_USED"), state);
        assert.equal((await claimRow(c.claimId)).state, state, "the state is unchanged by the refused claim");
        assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.promo_claims WHERE user_id = $1", [c.userId])).rows[0].n, 1, state);
      }
    });

    await t.test("evidence gate (D6): claim_unknown resolves only with authoritative reconciliation evidence", async () => {
      const outcome = (c: { userId: string; claimId: string }, o: "consumed" | "verified_uncharged_failure" | "claim_unknown", ev: Evidence, idempotencyKey = key("gate")) => markPromoOutcome(pool, { userId: c.userId, claimId: c.claimId, idempotencyKey, outcome: o, evidence: ev });
      const unknown = await claimFor("claim_unknown");
      // first-hand kinds cannot resolve an unknown claim
      await assert.rejects(outcome(unknown, "consumed", delivered(unknown.operationId, "persisted_delivered")), rejection("EVIDENCE_INVALID"));
      await assert.rejects(outcome(unknown, "verified_uncharged_failure", evidence(unknown.operationId, "verified_zero_charge_failure")), rejection("EVIDENCE_INVALID"));
      await assert.rejects(outcome(unknown, "verified_uncharged_failure", evidence(unknown.operationId, "outcome_unknown")), rejection("EVIDENCE_INVALID"));
      // reconciled delivery still needs a verified manifest hash AND verified owner/rights
      await assert.rejects(outcome(unknown, "consumed", evidence(unknown.operationId, "reconciled_delivered")), rejection("EVIDENCE_INVALID"), "no flags");
      await assert.rejects(outcome(unknown, "consumed", evidence(unknown.operationId, "reconciled_delivered", { manifest: true })), rejection("EVIDENCE_INVALID"), "no rights");
      await assert.rejects(outcome(unknown, "consumed", evidence(unknown.operationId, "reconciled_delivered", { rights: true })), rejection("EVIDENCE_INVALID"), "no manifest");
      // an operation id that is not the claim's
      await assert.rejects(outcome(unknown, "consumed", delivered(operation(), "reconciled_delivered")), rejection("EVIDENCE_INVALID"), "operation mismatch");
      // claim_unknown cannot be re-asserted
      await assert.rejects(outcome(unknown, "claim_unknown", evidence(unknown.operationId, "outcome_unknown")), rejection("INVALID_TRANSITION"));
      assert.deepEqual(await claimRow(unknown.claimId), { state: "claim_unknown", event_seq: 2 }, "no refused attempt changed the claim");
      // the two authoritative resolutions
      const resolvedFailure = await outcome(unknown, "verified_uncharged_failure", evidence(unknown.operationId, "reconciled_uncharged_failure"));
      assert.equal(resolvedFailure.claim.state, "verified_uncharged_failure"); assert.equal(resolvedFailure.claim.eventSeq, 3);
      const other = await claimFor("claim_unknown");
      const resolvedDelivery = await outcome(other, "consumed", delivered(other.operationId, "reconciled_delivered"));
      assert.equal(resolvedDelivery.claim.state, "consumed");
      // reconciliation kinds do not apply to a claim that was never unknown, and first-hand evidence has its own requirements
      const reserved = await claimFor("claim_reserved");
      await assert.rejects(outcome(reserved, "consumed", delivered(reserved.operationId, "reconciled_delivered")), rejection("EVIDENCE_INVALID"));
      await assert.rejects(outcome(reserved, "verified_uncharged_failure", evidence(reserved.operationId, "reconciled_uncharged_failure")), rejection("EVIDENCE_INVALID"));
      await assert.rejects(outcome(reserved, "consumed", evidence(reserved.operationId, "persisted_delivered", { manifest: true })), rejection("EVIDENCE_INVALID"), "persisted delivery without verified rights");
      await assert.rejects(outcome(reserved, "claim_unknown", evidence(reserved.operationId, "verified_zero_charge_failure")), rejection("EVIDENCE_INVALID"), "an uncharged failure is not an unknown outcome");
      assert.equal((await outcome(reserved, "claim_unknown", evidence(reserved.operationId, "persistence_failed_under_review"))).claim.state, "claim_unknown");
    });

    await t.test("illegal edges are persisted INVALID_TRANSITION rejections that replay and never change the claim", async () => {
      for (const state of ["consumed", "verified_uncharged_failure"] as const) {
        const c = await claimFor(state), idempotencyKey = key("terminal"), ev = evidence(c.operationId, "outcome_unknown");
        const attempt = () => markPromoOutcome(pool, { userId: c.userId, claimId: c.claimId, idempotencyKey, outcome: "claim_unknown", evidence: ev });
        await assert.rejects(attempt(), rejection("INVALID_TRANSITION", false), state);
        await assert.rejects(attempt(), rejection("INVALID_TRANSITION", true), state + " replay");
        for (const o of ["consumed", "verified_uncharged_failure"] as const) await assert.rejects(markPromoOutcome(pool, { userId: c.userId, claimId: c.claimId, idempotencyKey: key("terminal-" + o), outcome: o, evidence: delivered(c.operationId, "persisted_delivered") }), rejection("INVALID_TRANSITION"), `${state} -> ${o}`);
        assert.equal((await claimRow(c.claimId)).state, state);
      }
      const eligible = await claimFor("eligible");
      await assert.rejects(markPromoOutcome(pool, { userId: eligible.userId, claimId: eligible.claimId, idempotencyKey: key("elig"), outcome: "consumed", evidence: delivered(eligible.operationId, "persisted_delivered") }), rejection("INVALID_TRANSITION"), "eligible cannot skip claim_reserved");
    });

    await t.test("ownership: a foreign or absent claim is the same NOT_FOUND and is never persisted; getPromoClaim is owner-scoped", async () => {
      const owner = await claimFor("claim_reserved"), stranger = await syntheticProfileWithWallet(client);
      const before = await count("ledger_commands");
      await assert.rejects(markPromoOutcome(pool, { userId: stranger, claimId: owner.claimId, idempotencyKey: key("foreign"), outcome: "consumed", evidence: delivered(owner.operationId, "persisted_delivered") }), code("NOT_FOUND"));
      await assert.rejects(markPromoOutcome(pool, { userId: stranger, claimId: randomUUID(), idempotencyKey: key("absent"), outcome: "consumed", evidence: delivered(owner.operationId, "persisted_delivered") }), code("NOT_FOUND"));
      assert.equal(await count("ledger_commands"), before, "NOT_FOUND is not persisted as a rejection");
      assert.equal((await claimRow(owner.claimId)).state, "claim_reserved");
      await assert.rejects(getPromoClaim(pool, stranger), code("NOT_FOUND"));
      assert.equal((await getPromoClaim(pool, owner.userId)).claimId, owner.claimId);
    });

    await t.test("a promo touches no wallet or ledger rows: row counts, bucket values, revisions and row versions are unchanged", async () => {
      const funded = await syntheticProfileWithWallet(client), source = await registerSyntheticGrantSource(client, "promo isolation source");
      await grantSyntheticCredits(pool, { userId: funded, grantSourceId: source, sourceRef: "promo-iso-grant", units: SYNTHETIC_GRANT_UNITS });
      const empty = await syntheticProfileWithWallet(client);
      const before = await ledgerSnapshot();
      const fundedOp = operation(), emptyOp = operation();
      const a = await claimPromo(pool, { userId: funded, operationId: fundedOp, idempotencyKey: key("iso-a") });
      const b = await claimPromo(pool, { userId: empty, operationId: emptyOp, idempotencyKey: key("iso-b") });
      await markPromoOutcome(pool, { userId: funded, claimId: a.claim.claimId, idempotencyKey: key("iso-a1"), outcome: "claim_unknown", evidence: evidence(fundedOp, "outcome_unknown") });
      await markPromoOutcome(pool, { userId: funded, claimId: a.claim.claimId, idempotencyKey: key("iso-a2"), outcome: "consumed", evidence: delivered(fundedOp, "reconciled_delivered") });
      await markPromoOutcome(pool, { userId: empty, claimId: b.claim.claimId, idempotencyKey: key("iso-b1"), outcome: "verified_uncharged_failure", evidence: evidence(emptyOp, "verified_zero_charge_failure") });
      await assert.rejects(claimPromo(pool, { userId: funded, operationId: operation(), idempotencyKey: key("iso-a3") }), rejection("PROMO_ALREADY_USED"));
      assert.deepEqual(await ledgerSnapshot(), before, "wallets (incl. xmin/revision), ledger entries, grant sources and quote tables are unchanged");
      assert.equal(before.wallets.find(w => w.user_id === funded)?.a, String(SYNTHETIC_GRANT_UNITS), "the funded balance is untouched by promo traffic");
    });

    await t.test("a profile with no wallet row yet gets only the empty all-zero wallet (needed for the command lock), never a balance", async () => {
      const { id } = await profileOnly();
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.wallets WHERE user_id = $1", [id])).rows[0].n, 0);
      const entriesBefore = await count("ledger_entries");
      await claimPromo(pool, { userId: id, operationId: operation(), idempotencyKey: key("fresh-wallet") });
      const wallet = (await client.query("SELECT available_units::text a, reserved_units::text r, held_for_review_units::text h, consumed_units::text c, revision::text rev FROM vynvori_ledger.wallets WHERE user_id = $1", [id])).rows[0];
      assert.deepEqual(wallet, { a: "0", r: "0", h: "0", c: "0", rev: "0" });
      assert.equal(await count("ledger_entries"), entriesBefore);
    });

    await t.test("a guest (no profile) cannot claim: NOT_FOUND, and no claim, command or wallet row is left behind", async () => {
      const guest = randomUUID();
      const snapshot = async () => ({ claims: await count("promo_claims"), events: await count("promo_claim_events"), commands: await count("ledger_commands"), wallets: await count("wallets") });
      const before = await snapshot();
      await assert.rejects(claimPromo(pool, { userId: guest, operationId: operation(), idempotencyKey: key("guest") }), code("NOT_FOUND"));
      assert.deepEqual(await snapshot(), before);
      await assert.rejects(getPromoClaim(pool, guest), code("NOT_FOUND"));
      // DB level: no claim row without a verified profile, and no claim row for someone else's identity
      await assert.rejects(client.query("INSERT INTO vynvori_ledger.promo_claims(claim_id,user_id,issuer,subject,operation_id,state,event_seq) VALUES($1,$2,'https://synthetic.invalid',$3,$4,'eligible',0)", [randomUUID(), guest, "guest-" + guest, operation()]), anyOf("23000", "23503"), "no profile, no claim row");
      const a = await profileOnly(), b = await profileOnly();
      await assert.rejects(client.query("INSERT INTO vynvori_ledger.promo_claims(claim_id,user_id,issuer,subject,operation_id,state,event_seq) VALUES($1,$2,$3,$4,$5,'eligible',0)", [randomUUID(), a.id, b.issuer, b.subject, operation()]), sqlCode("23000"), "user_id must own the issuer and subject");
    });

    await t.test("the composite foreign key pins a claim to its verified identity: a claimed profile can be neither deleted nor re-keyed", async () => {
      const c = await claimFor("claim_reserved");
      await assert.rejects(client.query("DELETE FROM vynvori_identity.profiles WHERE id = $1", [c.userId]), sqlCode("23503"));
      await assert.rejects(client.query("UPDATE vynvori_identity.profiles SET subject = subject || '-moved' WHERE id = $1", [c.userId]), sqlCode("23503"), "re-keying the subject would free the unique index for a second claim");
      await assert.rejects(client.query("UPDATE vynvori_identity.profiles SET issuer = issuer || '/moved' WHERE id = $1", [c.userId]), sqlCode("23503"), "re-keying the issuer likewise");
      const unclaimed = await profileOnly();
      await client.query("UPDATE vynvori_identity.profiles SET subject = subject || '-moved' WHERE id = $1", [unclaimed.id]); // control: the FK only protects claimed profiles
    });

    await t.test("an operation id already bound to another claim is DUPLICATE_CAUSE (not persisted, nothing written for the loser)", async () => {
      const first = await claimFor("claim_reserved"), userId = await syntheticProfileWithWallet(client);
      const before = await count("promo_claims");
      await assert.rejects(claimPromo(pool, { userId, operationId: first.operationId, idempotencyKey: key("dup-op") }), code("DUPLICATE_CAUSE"));
      assert.equal(await count("promo_claims"), before);
      await assert.rejects(getPromoClaim(pool, userId), code("NOT_FOUND"));
      assert.equal((await claimPromo(pool, { userId, operationId: operation(), idempotencyKey: key("dup-op-retry") })).claim.state, "claim_reserved", "the identity can still claim with a fresh operation id");
    });

    await t.test("the SQL edge function equals PLANE_C_PROMO_GRAPH for all 25 state pairs", async () => {
      for (const from of STATES) for (const to of STATES) {
        const { rows } = await client.query("SELECT vynvori_ledger.promo_claim_edge_allowed($1, $2) AS ok", [from, to]);
        assert.equal(rows[0].ok, canTransitionPlaneCPromo(from, to), `${from} -> ${to}`);
      }
      assert.equal((await client.query("SELECT vynvori_ledger.promo_claim_edge_allowed('eligible', 'nonsense') AS ok")).rows[0].ok, false);
      assert.deepEqual([...STATES].sort(), ["claim_reserved", "claim_unknown", "consumed", "eligible", "verified_uncharged_failure"], "the graph still has the five states the 0004 CHECK knows");
    });

    await t.test("illegal graph edges are rejected at the database for every (claim state, target state) pair, whatever the evidence", async () => {
      const kinds = ["claim_requested", "persisted_delivered", "verified_zero_charge_failure", "outcome_unknown", "persistence_failed_under_review", "reconciled_delivered", "reconciled_uncharged_failure"];
      for (const from of STATES) {
        const c = await claimFor(from), seq = (await claimRow(c.claimId)).event_seq + 1;
        for (const to of STATES) {
          if (canTransitionPlaneCPromo(from, to)) continue;
          for (const kind of kinds) await assert.rejects(rawEvent(c, { seq, from, to, kind }), anyOf("23000", "23514"), `${from} -> ${to} (${kind}) is rejected by the trail trigger or the edge CHECK`);
        }
        assert.deepEqual(await claimRow(c.claimId), { state: from, event_seq: seq - 1 }, `${from} is unchanged`);
      }
    });

    await t.test("the evidence matrix is a database CHECK: every legal edge with every wrong evidence kind is rejected; each right kind is accepted", async () => {
      const kinds = ["claim_requested", "persisted_delivered", "verified_zero_charge_failure", "outcome_unknown", "persistence_failed_under_review", "reconciled_delivered", "reconciled_uncharged_failure", "vendor_charge_message"];
      const matrix: [PlaneCPromoState, PlaneCPromoState, string[]][] = [
        ["eligible", "claim_reserved", ["claim_requested"]], ["claim_reserved", "consumed", ["persisted_delivered"]], ["claim_reserved", "verified_uncharged_failure", ["verified_zero_charge_failure"]],
        ["claim_reserved", "claim_unknown", ["outcome_unknown", "persistence_failed_under_review"]], ["claim_unknown", "consumed", ["reconciled_delivered"]], ["claim_unknown", "verified_uncharged_failure", ["reconciled_uncharged_failure"]],
      ];
      for (const [from, to, accepted] of matrix) {
        const c = await claimFor(from), seq = (await claimRow(c.claimId)).event_seq + 1;
        for (const kind of kinds.filter(k => !accepted.includes(k))) await assert.rejects(rawEvent(c, { seq, from, to, kind }), sqlCode("23514"), `${from} -> ${to} with ${kind}`);
        assert.deepEqual(await claimRow(c.claimId), { state: from, event_seq: seq - 1 });
        for (const kind of accepted) { // each accepted kind is exercised on its own fresh claim
          const fresh = await claimFor(from), freshSeq = (await claimRow(fresh.claimId)).event_seq + 1;
          await rawEvent(fresh, { seq: freshSeq, from, to, kind });
          assert.deepEqual(await claimRow(fresh.claimId), { state: to, event_seq: freshSeq }, `${from} -> ${to} with ${kind}`);
        }
      }
    });

    await t.test("the trail must continue exactly: wrong from_state, skipped or repeated seq, foreign operation, unknown claim, a rejected or foreign command are all refused", async () => {
      const c = await claimFor("claim_reserved");
      await assert.rejects(rawEvent(c, { seq: 2, from: "claim_unknown", to: "consumed", kind: "reconciled_delivered" }), sqlCode("23000"), "from_state is not the claim's state");
      await assert.rejects(rawEvent(c, { seq: 3, from: "claim_reserved", to: "consumed", kind: "persisted_delivered" }), sqlCode("23000"), "skipped seq");
      await assert.rejects(rawEvent(c, { seq: 1, from: "claim_reserved", to: "consumed", kind: "persisted_delivered" }), sqlCode("23000"), "repeated seq");
      await assert.rejects(client.query("INSERT INTO vynvori_ledger.promo_claim_events(event_id,claim_id,user_id,operation_id,seq,from_state,to_state,evidence_kind,evidence_ref,command_id) VALUES($1,$2,$3,$4,2,'claim_reserved','consumed','persisted_delivered','raw-evidence',$5)",
        [randomUUID(), c.claimId, c.userId, "some-other-operation", await rawCommand(c.userId)]), sqlCode("23503"), "operation id is bound to the claim's by FK");
      await assert.rejects(rawEvent({ ...c, claimId: randomUUID() }, { seq: 2, from: "claim_reserved", to: "consumed", kind: "persisted_delivered" }), sqlCode("23000"), "unknown claim");
      const stranger = await syntheticProfileWithWallet(client);
      await assert.rejects(rawEvent(c, { seq: 2, from: "claim_reserved", to: "consumed", kind: "persisted_delivered", commandId: await rawCommand(stranger) }), anyOf("23000", "23503"), "a command of another user");
      const rejectedCommand = randomUUID();
      await client.query("INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome,rejection_code) VALUES($1,$2,$3,$4,$5,'raw_promo_probe','rejected','PROMO_ALREADY_USED')",
        [rejectedCommand, `${c.userId}:raw_promo_probe`, "raw-rejected-" + randomUUID(), "b".repeat(64), c.userId]);
      await assert.rejects(rawEvent(c, { seq: 2, from: "claim_reserved", to: "consumed", kind: "persisted_delivered", commandId: rejectedCommand }), sqlCode("23000"), "a rejected command is not an applied one");
      const commandId = await rawCommand(c.userId);
      await rawEvent(c, { seq: 2, from: "claim_reserved", to: "consumed", kind: "persisted_delivered", commandId });
      await assert.rejects(rawEvent(c, { seq: 3, from: "consumed", to: "claim_unknown", kind: "outcome_unknown" }), anyOf("23000", "23514"), "no event leaves a terminal state");
      const unknown = await claimFor("claim_unknown");
      await assert.rejects(client.query("INSERT INTO vynvori_ledger.promo_claim_events(event_id,claim_id,user_id,operation_id,seq,from_state,to_state,evidence_kind,evidence_ref,command_id) VALUES($1,$2,$3,$4,3,'claim_unknown','consumed','reconciled_delivered','raw-evidence',$5)",
        [randomUUID(), unknown.claimId, unknown.userId, unknown.operationId, commandId]), anyOf("23000", "23503"), "a command of another user cannot be reused");
    });

    await t.test("claim state changes only through event inserts: direct UPDATE, a depth-2 TEMP-trigger UPDATE, DELETE and TRUNCATE are all rejected, even for a superuser", async () => {
      const c = await claimFor("claim_reserved");
      for (const sql of [
        `UPDATE vynvori_ledger.promo_claims SET state = 'consumed', event_seq = 2 WHERE claim_id = '${c.claimId}'`,
        `UPDATE vynvori_ledger.promo_claims SET state = 'claim_unknown' WHERE claim_id = '${c.claimId}'`,
        `UPDATE vynvori_ledger.promo_claims SET operation_id = 'stolen-op' WHERE claim_id = '${c.claimId}'`,
        `UPDATE vynvori_ledger.promo_claims SET issuer = 'https://other.invalid' WHERE claim_id = '${c.claimId}'`,
      ]) await assert.rejects(client.query(sql), sqlCode("23000"), sql);
      await assert.rejects(client.query(`UPDATE vynvori_ledger.promo_claims SET state = 'eligible', event_seq = 0 WHERE claim_id = '${c.claimId}'`), (e: unknown) => ["23000", "23514"].includes((e as { code?: string }).code ?? ""), "back to eligible");
      // The depth check alone is bypassable by a trigger on a role-owned TEMP table (ADR-0021 D3, S2 addendum). The content check is not.
      await client.query("CREATE TEMP TABLE promo_exploit(x int)");
      await client.query(`CREATE FUNCTION pg_temp.promo_exploit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE vynvori_ledger.promo_claims SET state = 'consumed', event_seq = 2 WHERE claim_id = '${c.claimId}'; RETURN NEW; END $$`);
      await client.query("CREATE TRIGGER promo_exploit_tg AFTER INSERT ON promo_exploit FOR EACH ROW EXECUTE FUNCTION pg_temp.promo_exploit_fn()");
      await assert.rejects(client.query("INSERT INTO promo_exploit VALUES (1)"), (e: unknown) => sqlCode("23000")(e) && /next recorded event/.test((e as Error).message), "depth 2 reaches the guard, which still demands a matching recorded event");
      await client.query("DROP TABLE promo_exploit"); await client.query("DROP FUNCTION IF EXISTS pg_temp.promo_exploit_fn()");
      await assert.rejects(client.query(`DELETE FROM vynvori_ledger.promo_claims WHERE claim_id = '${c.claimId}'`), sqlCode("23000"));
      await assert.rejects(client.query("TRUNCATE vynvori_ledger.promo_claims CASCADE"), sqlCode("23000"));
      await assert.rejects(client.query("TRUNCATE vynvori_ledger.promo_claim_events"), sqlCode("23000"));
      await assert.rejects(client.query(`UPDATE vynvori_ledger.promo_claim_events SET evidence_ref = 'tampered' WHERE claim_id = '${c.claimId}'`), sqlCode("23000"), "events are append-only");
      await assert.rejects(client.query(`DELETE FROM vynvori_ledger.promo_claim_events WHERE claim_id = '${c.claimId}'`), sqlCode("23000"));
      assert.deepEqual(await claimRow(c.claimId), { state: "claim_reserved", event_seq: 1 }, "nothing above changed the claim");
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.promo_claim_events WHERE claim_id = $1", [c.claimId])).rows[0].n, 1);
    });

    await t.test("a claim row is born eligible with no events; the stored state always equals the last event of its trail", async () => {
      const a = await profileOnly(), b = await profileOnly();
      for (const [state, seq] of [["consumed", 0], ["claim_reserved", 1], ["eligible", 1], ["claim_reserved", 0]] as const)
        await assert.rejects(client.query("INSERT INTO vynvori_ledger.promo_claims(claim_id,user_id,issuer,subject,operation_id,state,event_seq) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), a.id, a.issuer, a.subject, operation(), state, seq]), (e: unknown) => ["23000", "23514"].includes((e as { code?: string }).code ?? ""), `${state}/${seq}`);
      await assert.rejects(client.query("INSERT INTO vynvori_ledger.promo_claims(claim_id,user_id,issuer,subject,operation_id,state,event_seq) VALUES($1,$2,$3,$4,'bad op id!','eligible',0)", [randomUUID(), b.id, b.issuer, b.subject]), sqlCode("23514"), "operation id shape");
      const { rows } = await client.query(`SELECT c.claim_id FROM vynvori_ledger.promo_claims c
        LEFT JOIN LATERAL (SELECT e.to_state, e.seq FROM vynvori_ledger.promo_claim_events e WHERE e.claim_id = c.claim_id ORDER BY e.seq DESC LIMIT 1) last ON true
        WHERE c.state IS DISTINCT FROM coalesce(last.to_state, 'eligible') OR c.event_seq IS DISTINCT FROM coalesce(last.seq, 0)`);
      assert.deepEqual(rows, [], "every claim's state and event_seq equal the last event of its trail");
    });

    await t.test("every promo command locks the wallet row FOR UPDATE before touching any promo table (ADR-0021 D10, A4)", async () => {
      const log: string[] = [];
      const spyDb = {
        query: (text: string, values?: unknown[]) => { log.push(text.trim()); return client.query(text, values); },
        acquire: async () => ({ query: (text: string, values?: unknown[]) => { log.push(text.trim()); return client.query(text, values); }, release: () => undefined }),
      };
      const WALLET_LOCK = /^SELECT 1 FROM vynvori_ledger\.wallets WHERE user_id = \$1 FOR UPDATE$/;
      const firstLedgerStatement = () => { const begin = log.findIndex(q => /^BEGIN$/i.test(q)); return log.slice(begin + 1).find(q => /^(SELECT|INSERT|UPDATE|DELETE)\b/i.test(q)); };
      const userId = await syntheticProfileWithWallet(client), op = operation();
      log.length = 0;
      const { claim } = await claimPromo(spyDb, { userId, operationId: op, idempotencyKey: key("lock-claim") });
      assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "promo_claim");
      log.length = 0;
      await markPromoOutcome(spyDb, { userId, claimId: claim.claimId, idempotencyKey: key("lock-outcome"), outcome: "consumed", evidence: delivered(op, "persisted_delivered") });
      assert.match(firstLedgerStatement() ?? "", WALLET_LOCK, "promo_outcome");
    });

    await t.test("restricted runtime role: SELECT/INSERT on the promo tables plus column UPDATE(state, event_seq) is enough; it cannot rewrite history or touch other columns", async () => {
      await client.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`); roleCreated = true;
      for (const sql of [
        `GRANT USAGE ON SCHEMA vynvori_ledger, vynvori_identity TO "${role}"`,
        `GRANT SELECT ON vynvori_identity.profiles TO "${role}"`,
        `GRANT SELECT, INSERT ON vynvori_ledger.wallets, vynvori_ledger.ledger_commands TO "${role}"`,
        `GRANT SELECT ON vynvori_ledger.ledger_entries TO "${role}"`, // runLedgerCommand reconstructs every command's entries after the callback (S2); a promo command has none
        `GRANT UPDATE (user_id) ON vynvori_ledger.wallets TO "${role}"`, // lets SELECT ... FOR UPDATE take the command lock; the guard still rejects any balance change
        `GRANT SELECT, INSERT ON vynvori_ledger.promo_claims, vynvori_ledger.promo_claim_events TO "${role}"`,
        `GRANT UPDATE (state, event_seq) ON vynvori_ledger.promo_claims TO "${role}"`, // the invoker-rights apply trigger needs it; the guard allows only the next recorded event
      ]) await client.query(sql);
      restrictedPool = await ledgerPoolAs("promo", role, { max: 2 });
      const rt = restrictedPool;
      const userId = await syntheticProfileWithWallet(client), op = operation();
      const claimed = await claimPromo(rt, { userId, operationId: op, idempotencyKey: key("rt-claim") });
      assert.equal(claimed.claim.state, "claim_reserved");
      const done = await markPromoOutcome(rt, { userId, claimId: claimed.claim.claimId, idempotencyKey: key("rt-outcome"), outcome: "consumed", evidence: delivered(op, "persisted_delivered") });
      assert.equal(done.claim.state, "consumed");
      await assert.rejects(claimPromo(rt, { userId, operationId: operation(), idempotencyKey: key("rt-again") }), rejection("PROMO_ALREADY_USED"));
      const open = (await claimFor("claim_reserved")).claimId;
      await assert.rejects(rt.query("UPDATE vynvori_ledger.promo_claims SET state = 'consumed', event_seq = 2 WHERE claim_id = $1", [open]), sqlCode("23000"), "a direct state UPDATE passes privileges and is stopped by the guard");
      await assert.rejects(rt.query("UPDATE vynvori_ledger.promo_claims SET operation_id = 'x' WHERE claim_id = $1", [open]), sqlCode("42501"), "no privilege on any other column");
      await assert.rejects(rt.query("UPDATE vynvori_ledger.promo_claim_events SET evidence_ref = 'x'"), sqlCode("42501"));
      await assert.rejects(rt.query("DELETE FROM vynvori_ledger.promo_claims"), sqlCode("42501"));
      await assert.rejects(rt.query("DELETE FROM vynvori_ledger.promo_claim_events"), sqlCode("42501"));
      await assert.rejects(rt.query("TRUNCATE vynvori_ledger.promo_claims"), sqlCode("42501"));
      await assert.rejects(rt.query("INSERT INTO vynvori_ledger.ledger_entries(entry_id) VALUES(gen_random_uuid())"), sqlCode("42501"), "the promo role has no INSERT on ledger entries");
    });
  } finally {
    await restrictedPool?.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    if (roleCreated) { await client.query(`DROP OWNED BY "${role}"`).catch(() => undefined); await client.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined); }
    await client.end().catch(() => undefined);
    await dropLedger("promo");
  }
});
