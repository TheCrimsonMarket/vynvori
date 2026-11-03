import test from "node:test";
import assert from "node:assert/strict";
import { grantSyntheticCredits, dropLedger, freshLedger, ledgerPool, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet } from "./ledger-fixture";
import { getWalletSummary } from "../src/ledger-core";

/**
 * The ONLY ledger test file allowed more than 5 pool connections (ADR-0021 D15): up to 110 over one disposable database.
 * Later M7 steps add their 100-way scenarios here. Under CI_REQUIRE_PG_TESTS=1 a degraded pool FAILS the file; locally a
 * degraded pool skips it and the 100-connection row stays NOT_RUN.
 */
const IN_FLIGHT = 100;
// SYNTHETIC_* values: test-only, never exported from src/.
const SYNTHETIC_UNITS = 3;

test("100-way concurrent grants in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client = await freshLedger("concurrency");
  let pool!: Awaited<ReturnType<typeof ledgerPool>>["pool"];
  try {
    const sized = await ledgerPool("concurrency", "concurrency"); pool = sized.pool;
    if (sized.degraded) {
      if (ledgerTarget.required) assert.fail(`pool degraded: server allows ${sized.serverMax} connections, ${IN_FLIGHT}-way test needs more (set max_connections)`);
      t.skip("degraded pool: 100-connection row is NOT_RUN"); return;
    }
    assert.ok(sized.max >= IN_FLIGHT && sized.max <= 110, `pool max ${sized.max}`);
    const source = await registerSyntheticGrantSource(client);

    await t.test("100 identical grant commands in flight -> exactly one entry; every caller sees the same command", async () => {
      const user = await syntheticProfileWithWallet(client), idempotencyKey = "concurrent-identical-grant";
      const results = await Promise.all(Array.from({ length: IN_FLIGHT }, () => grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "same-ref", units: SYNTHETIC_UNITS, idempotencyKey })));
      assert.equal(new Set(results.map(r => r.commandId)).size, 1);
      assert.equal(results.filter(r => !r.replayed).length, 1, "exactly one execution; the rest replayed");
      assert.ok(results.every(r => r.entries.length === 1 && r.entries[0]!.entryId === results[0]!.entries[0]!.entryId));
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_entries WHERE user_id=$1", [user])).rows[0].n, 1);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_commands WHERE user_id=$1", [user])).rows[0].n, 1);
      const summary = await getWalletSummary(client, user);
      assert.equal(summary.availableUnits, SYNTHETIC_UNITS); assert.equal(summary.walletRevision, "1");
    });

    await t.test("100 distinct grants in flight -> exact total, 100 revisions, no lost update", async () => {
      const user = await syntheticProfileWithWallet(client);
      const units = Array.from({ length: IN_FLIGHT }, (_, i) => i + 1);
      await Promise.all(units.map(n => grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "distinct-" + n, units: n })));
      const total = units.reduce((a, b) => a + b, 0);
      const summary = await getWalletSummary(client, user);
      assert.equal(summary.availableUnits, total); assert.equal(summary.walletRevision, String(IN_FLIGHT));
      const row = (await client.query("SELECT count(*)::int n, sum(delta_available)::text s, sum(delta_external)::text e FROM vynvori_ledger.ledger_entries WHERE user_id=$1", [user])).rows[0];
      assert.deepEqual({ n: row.n, s: row.s, e: row.e }, { n: IN_FLIGHT, s: String(total), e: String(-total) });
    });

    await t.test("100 same-source_ref grants under distinct keys -> exactly one wins; the rest are DUPLICATE_CAUSE", async () => {
      const user = await syntheticProfileWithWallet(client);
      const settled = await Promise.allSettled(Array.from({ length: IN_FLIGHT }, (_, i) => grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "one-cause", units: SYNTHETIC_UNITS, idempotencyKey: "distinct-key-number-" + i })));
      assert.equal(settled.filter(r => r.status === "fulfilled").length, 1);
      assert.ok(settled.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason?.code === "DUPLICATE_CAUSE"));
      assert.equal((await getWalletSummary(client, user)).availableUnits, SYNTHETIC_UNITS);
    });
  } finally { await pool?.end().catch(() => undefined); await client.end().catch(() => undefined); await dropLedger("concurrency"); }
});
