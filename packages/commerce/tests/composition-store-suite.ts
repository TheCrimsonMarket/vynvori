/**
 * ADR-0022 C3b store-primitive conformance: ONE scenario list, run against the in-memory port (composition.test.ts) and the
 * PostgreSQL store (composition-pg.test.ts). Setup goes through the service; the primitives are called on the store directly,
 * because no runtime path uses them yet (C4 to C6 wire them).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CompositionAccess, CompositionStore } from "@vynvori/contracts/composition-port";
import { EMPTY_SYNTHETIC_SCENE } from "@vynvori/contracts";
import { compositionService, CompositionError, sceneSha256, secretHash } from "../src/composition";
import type { Harness } from "./composition-suite";
import { imageLayer, memoryStorage, png, sceneWith, textLayer } from "./composition-fixtures";
import {
  SYNTHETIC_COMPOSITION_CONFIG, SYNTHETIC_GRANT_TTL_SECONDS, SYNTHETIC_GUEST_TTL_SECONDS, SYNTHETIC_LIVE_CAP, SYNTHETIC_QUOTA_BYTES, SYNTHETIC_QUOTA_MAX_ASSETS, SYNTHETIC_RATE_MAX, SYNTHETIC_RATE_WINDOW_SECONDS, SYNTHETIC_SCAN_EVIDENCE, SYNTHETIC_SCAN_LEASE_SECONDS,
} from "./composition-synthetic";

const seconds = (date: Date, n: number) => new Date(date.getTime() + n * 1000);
/** SYNTHETIC: a lease short enough to pass on the real (database) clock inside a test. */
const SYNTHETIC_SHORT_LEASE_MS = 1000;
const tokenHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

/** Drives a `pending` asset to `clean` through the reservation path (open attempt, then complete). Used by both suites. */
export async function markClean(store: CompositionStore, compositionId: string, assetId: string, access: CompositionAccess, now = new Date()) {
  const opened = await store.openScanAttempt(compositionId, assetId, access, now, { attemptId: randomUUID(), leaseExpiresAt: seconds(now, SYNTHETIC_SCAN_LEASE_SECONDS) });
  if (opened.status !== "opened") throw new Error(`markClean: ${opened.status}`);
  const done = await store.completeScanAttempt(compositionId, assetId, access, now, { attemptId: opened.attempt.attemptId, result: { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE } });
  if (done.status !== "recorded") throw new Error(`markClean: ${done.status}`);
}

export type StoreHarness = Harness & {
  lateQuarantine(compositionId: string, assetId: string): Promise<void>;
  /** Rows in the rate-bucket table (the in-memory port: distinct buckets). Proves that callers without access never created one (C4). */
  bucketCount(): Promise<number>;
};

export function storeConformance(label: string, factory: () => Promise<StoreHarness>, options: { skip?: boolean } = {}) {
  const t = (name: string, fn: () => Promise<void>) => test(`${label}: ${name}`, { skip: options.skip ?? false }, fn);
  const setup = async () => {
    const h = await factory(), storage = memoryStorage();
    const service = compositionService(h.store, storage, { ...SYNTHETIC_COMPOSITION_CONFIG, uploadsEnabled: true });
    const guest = async () => {
      const created = await service.createGuest();
      return { id: created.record.id, access: { kind: "guest", capabilityHash: secretHash(created.capability) } as CompositionAccess, capability: created.capability };
    };
    const withAsset = async (salt = 1) => {
      const g = await guest(), asset = await service.uploadAsset(g.id, g.access, png(64, 64, salt), "image/png");
      return { ...g, asset };
    };
    return { h, store: h.store, service, guest, withAsset };
  };
  const lease = (now: Date) => ({ attemptId: randomUUID(), leaseExpiresAt: seconds(now, SYNTHETIC_SCAN_LEASE_SECONDS) });

  t("scanStatus is a required, store-derived field: pending on insert, get, list and dedupe; never caller-supplied", async () => {
    const { store, service, withAsset } = await setup(); const g = await withAsset();
    assert.equal(g.asset.scanStatus, "pending");
    assert.equal((await store.getAsset(g.id, g.asset.id, g.access, new Date()))!.scanStatus, "pending");
    assert.deepEqual((await store.listAssets(g.id, g.access, new Date()))!.map(a => a.scanStatus), ["pending"]);
    assert.equal((await service.uploadAsset(g.id, g.access, png(64, 64, 1), "image/png")).scanStatus, "pending"); // dedupe path
    assert.deepEqual(await store.listScanEvents(g.id, g.asset.id, g.access, new Date()), []);
  });

  t("scan reservation: one open attempt, busy for the second, clean recorded with evidence, then not scannable", async () => {
    const { store, withAsset } = await setup(); const g = await withAsset(), now = new Date();
    const first = await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now));
    if (first.status !== "opened") return assert.fail(first.status);
    assert.equal(first.attempt.finishedAt, null); assert.equal(first.attempt.outcome, null);
    const second = await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now));
    assert.equal(second.status, "busy"); if (second.status === "busy") assert.equal(second.attempt.attemptId, first.attempt.attemptId);
    const done = await store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: first.attempt.attemptId, result: { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE } });
    if (done.status !== "recorded") return assert.fail(done.status);
    assert.deepEqual([done.event.seq, done.event.fromStatus, done.event.toStatus, done.event.attemptId, done.event.assetSha256], [1, "pending", "clean", first.attempt.attemptId, g.asset.sha256]);
    assert.equal(done.event.evidenceRef, SYNTHETIC_SCAN_EVIDENCE.evidenceRef);
    assert.equal((await store.getAsset(g.id, g.asset.id, g.access, now))!.scanStatus, "clean");
    const again = await store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: first.attempt.attemptId, result: { toStatus: "quarantined", ...SYNTHETIC_SCAN_EVIDENCE } });
    assert.deepEqual(again, { status: "rejected", reason: "attempt_not_open", scanStatus: "clean" }); // a closed attempt records nothing
    assert.deepEqual(await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now)), { status: "not_scannable", scanStatus: "clean" });
    assert.deepEqual((await store.listScanEvents(g.id, g.asset.id, g.access, now))!.map(e => e.seq), [1]);
  });

  t("unknown -> explicit rescan -> pending -> quarantined is terminal; seq stays gap-free", async () => {
    const { store, withAsset } = await setup(); const g = await withAsset(), now = new Date();
    const a1 = await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now));
    if (a1.status !== "opened") return assert.fail(a1.status);
    assert.equal((await store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: a1.attempt.attemptId, result: { toStatus: "unknown", reasonCode: "scanner_error" } })).status, "recorded");
    assert.deepEqual(await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now)), { status: "not_scannable", scanStatus: "unknown" });
    const rescan = await store.requestRescan(g.id, g.asset.id, g.access, now, { reasonCode: "owner_requested" });
    if (rescan.status !== "recorded") return assert.fail(rescan.status);
    assert.deepEqual([rescan.event.fromStatus, rescan.event.toStatus, rescan.event.reasonCode, rescan.event.attemptId], ["unknown", "pending", "owner_requested", null]);
    assert.deepEqual(await store.requestRescan(g.id, g.asset.id, g.access, now, { reasonCode: "owner_requested" }), { status: "rejected", reason: "illegal_transition", scanStatus: "pending" });
    const a2 = await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now));
    if (a2.status !== "opened") return assert.fail(a2.status);
    assert.equal((await store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: a2.attempt.attemptId, result: { toStatus: "quarantined", ...SYNTHETIC_SCAN_EVIDENCE } })).status, "recorded");
    assert.deepEqual(await store.requestRescan(g.id, g.asset.id, g.access, now, { reasonCode: "owner_requested" }), { status: "rejected", reason: "illegal_transition", scanStatus: "quarantined" });
    assert.deepEqual(await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now)), { status: "not_scannable", scanStatus: "quarantined" });
    const history = (await store.listScanEvents(g.id, g.asset.id, g.access, now))!;
    assert.deepEqual(history.map(e => [e.seq, e.fromStatus, e.toStatus]), [[1, "pending", "unknown"], [2, "unknown", "pending"], [3, "pending", "quarantined"]]);
  });

  t("a quarantine may carry a reason code (M3-F2a); no other clean or quarantined result may carry a malformed one", async () => {
    const { store, withAsset } = await setup(); const g = await withAsset(), now = new Date();
    const rejects = (p: Promise<unknown>) => assert.rejects(p, RangeError);
    await rejects(store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), result: { toStatus: "quarantined", ...SYNTHETIC_SCAN_EVIDENCE, reasonCode: "Bad Reason" } }));
    await rejects(store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), result: { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE, reasonCode: "scan_timeout" } as never }));
    const a = await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now));
    if (a.status !== "opened") return assert.fail(a.status);
    const done = await store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: a.attempt.attemptId, result: { toStatus: "quarantined", ...SYNTHETIC_SCAN_EVIDENCE, reasonCode: "scan_timeout" } });
    if (done.status !== "recorded") return assert.fail(done.status);
    assert.deepEqual([done.event.toStatus, done.event.reasonCode, done.event.evidenceRef], ["quarantined", "scan_timeout", SYNTHETIC_SCAN_EVIDENCE.evidenceRef]);
  });

  t("lease: never expired early or automatically; an explicit expiry after the lease records unknown(lease_expired)", async () => {
    const { store, withAsset } = await setup(); const g = await withAsset(), now = new Date(), until = new Date(now.getTime() + SYNTHETIC_SHORT_LEASE_MS);
    const opened = await store.openScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), leaseExpiresAt: until });
    if (opened.status !== "opened") return assert.fail(opened.status);
    const attemptId = opened.attempt.attemptId;
    assert.deepEqual(await store.expireScanAttempt(g.id, g.asset.id, g.access, seconds(until, -1), { attemptId }), { status: "rejected", reason: "lease_active", scanStatus: "pending" });
    // A caller clock that claims the lease has passed is not enough: the store's own clock must agree (no early expiry by a skewed `now`).
    assert.deepEqual(await store.expireScanAttempt(g.id, g.asset.id, g.access, seconds(until, 3600), { attemptId }), { status: "rejected", reason: "lease_active", scanStatus: "pending" });
    await new Promise(resolve => setTimeout(resolve, SYNTHETIC_SHORT_LEASE_MS + 250));
    assert.equal((await store.getAsset(g.id, g.asset.id, g.access, seconds(until, 1)))!.scanStatus, "pending"); // reading past the lease changes nothing
    assert.equal((await store.openScanAttempt(g.id, g.asset.id, g.access, seconds(until, 1), lease(seconds(until, 1)))).status, "busy");
    const expired = await store.expireScanAttempt(g.id, g.asset.id, g.access, until, { attemptId });
    if (expired.status !== "recorded") return assert.fail(expired.status);
    assert.deepEqual([expired.event.toStatus, expired.event.reasonCode, expired.event.attemptId], ["unknown", "lease_expired", attemptId]);
    assert.deepEqual(await store.completeScanAttempt(g.id, g.asset.id, g.access, until, { attemptId, result: { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE } }), { status: "rejected", reason: "attempt_not_open", scanStatus: "unknown" }); // a late result never lands
    assert.deepEqual(await store.expireScanAttempt(g.id, g.asset.id, g.access, until, { attemptId }), { status: "rejected", reason: "attempt_not_open", scanStatus: "unknown" });
  });

  t("an attempt of another asset cannot complete or expire this asset's scan", async () => {
    const { store, withAsset } = await setup(); const a = await withAsset(1), b = await withAsset(2), now = new Date();
    const opened = await store.openScanAttempt(b.id, b.asset.id, b.access, now, lease(now));
    if (opened.status !== "opened") return assert.fail(opened.status);
    assert.deepEqual(await store.completeScanAttempt(a.id, a.asset.id, a.access, now, { attemptId: opened.attempt.attemptId, result: { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE } }), { status: "rejected", reason: "attempt_not_open", scanStatus: "pending" });
    assert.deepEqual(await store.expireScanAttempt(a.id, a.asset.id, a.access, seconds(now, SYNTHETIC_SCAN_LEASE_SECONDS + 1), { attemptId: opened.attempt.attemptId }), { status: "rejected", reason: "attempt_not_open", scanStatus: "pending" });
    assert.equal((await store.getAsset(b.id, b.asset.id, b.access, now))!.scanStatus, "pending");
  });

  t("scan results are never shared across compositions, even for identical bytes", async () => {
    const { store, withAsset } = await setup(); const a = await withAsset(7), b = await withAsset(7);
    assert.equal(a.asset.sha256, b.asset.sha256); assert.notEqual(a.asset.id, b.asset.id);
    await markClean(store, a.id, a.asset.id, a.access);
    assert.equal((await store.getAsset(a.id, a.asset.id, a.access, new Date()))!.scanStatus, "clean");
    assert.equal((await store.getAsset(b.id, b.asset.id, b.access, new Date()))!.scanStatus, "pending");
  });

  t("ownership: foreign, expired, wrong-composition and malformed callers get the same not_found and change nothing", async () => {
    const { h, store, withAsset, guest } = await setup(); const g = await withAsset(), other = await guest(), stranger: CompositionAccess = { kind: "owner", userId: await h.newUser() };
    const now = new Date();
    const cases: [string, string, CompositionAccess][] = [[g.id, g.asset.id, other.access], [g.id, g.asset.id, stranger], [other.id, g.asset.id, other.access], [g.id, randomUUID(), g.access], ["../etc", g.asset.id, g.access], [g.id, g.asset.id.toUpperCase(), g.access]];
    for (const [cid, aid, access] of cases) {
      assert.deepEqual(await store.openScanAttempt(cid, aid, access, now, lease(now)), { status: "not_found" });
      assert.deepEqual(await store.completeScanAttempt(cid, aid, access, now, { attemptId: randomUUID(), result: { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE } }), { status: "not_found" });
      assert.deepEqual(await store.expireScanAttempt(cid, aid, access, now, { attemptId: randomUUID() }), { status: "not_found" });
      assert.deepEqual(await store.requestRescan(cid, aid, access, now, { reasonCode: "owner_requested" }), { status: "not_found" });
      assert.deepEqual(await store.createDownloadGrant(cid, aid, access, now, { grantId: randomUUID(), tokenHash: tokenHash(), expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) }), { status: "not_found" });
      assert.equal(await store.listScanEvents(cid, aid, access, now), null);
    }
    assert.deepEqual(await store.listScanEvents(g.id, g.asset.id, g.access, now), []);
    await h.expireGuest(g.id);
    assert.deepEqual(await store.openScanAttempt(g.id, g.asset.id, g.access, now, lease(now)), { status: "not_found" });
    assert.equal(await store.listScanEvents(g.id, g.asset.id, g.access, now), null);
  });

  t("invalid primitive input throws (never defaults): ids, leases, expiries, evidence, reasons", async () => {
    const { store, withAsset } = await setup(); const g = await withAsset(), now = new Date();
    const rejects = (p: Promise<unknown>) => assert.rejects(p, RangeError);
    await rejects(store.openScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: "x", leaseExpiresAt: seconds(now, 1) }));
    await rejects(store.openScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), leaseExpiresAt: now }));
    await rejects(store.openScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), leaseExpiresAt: new Date(Number.NaN) }));
    for (const result of [{ toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE, evidenceRef: "" }, { toStatus: "quarantined", scannerId: "s" }, { toStatus: "unknown", reasonCode: "" }, { toStatus: "unknown", reasonCode: "Bad Reason" }, { toStatus: "pending", reasonCode: "x" }, { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE, scannerId: " padded " }])
      await rejects(store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), result: result as never }));
    await rejects(store.requestRescan(g.id, g.asset.id, g.access, now, { reasonCode: "" }));
    await rejects(store.requestRescan(g.id, g.asset.id, g.access, now, { reasonCode: "a".repeat(513) }));
    await rejects(store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), result: { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE, evidenceRef: "x".repeat(513) } }));
    await rejects(store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId: randomUUID(), tokenHash: "not-a-hash", expiresAt: seconds(now, 1) }));
    await rejects(store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId: randomUUID(), tokenHash: tokenHash(), expiresAt: now }));
    assert.equal((await store.getAsset(g.id, g.asset.id, g.access, now))!.scanStatus, "pending");
    assert.deepEqual(await store.listScanEvents(g.id, g.asset.id, g.access, now), []);
    // A reused attempt id or grant id is refused as invalid input on both stores (never a raw driver error echoing key values).
    const reused = randomUUID(), opened = await store.openScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: reused, leaseExpiresAt: seconds(now, SYNTHETIC_SCAN_LEASE_SECONDS) });
    if (opened.status !== "opened") return assert.fail(opened.status);
    await store.completeScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: reused, result: { toStatus: "unknown", reasonCode: "scanner_error" } });
    await store.requestRescan(g.id, g.asset.id, g.access, now, { reasonCode: "owner_requested" });
    await rejects(store.openScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: reused, leaseExpiresAt: seconds(now, SYNTHETIC_SCAN_LEASE_SECONDS) }));
    await markClean(store, g.id, g.asset.id, g.access, now);
    const grantId = randomUUID(), token = tokenHash();
    assert.equal((await store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId, tokenHash: token, expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) })).status, "created");
    await rejects(store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId, tokenHash: tokenHash(), expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) }));
    await rejects(store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId: randomUUID(), tokenHash: token, expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) }));
  });

  t("download grant: mint needs clean; only the minting principal can validate or consume; single use; hashes never returned", async () => {
    const { store, withAsset, guest } = await setup(); const g = await withAsset(), other = await guest(), now = new Date(), token = tokenHash();
    const mint = () => store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId: randomUUID(), tokenHash: token, expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) });
    assert.deepEqual(await mint(), { status: "asset_not_clean", scanStatus: "pending" });
    await markClean(store, g.id, g.asset.id, g.access, now);
    const created = await mint();
    if (created.status !== "created") return assert.fail(created.status);
    assert.deepEqual(Object.keys(created.grant).sort(), ["assetId", "compositionId", "expiresAt", "grantId", "issuedAt", "principalKind", "redeemedAt"]);
    assert.equal(created.grant.principalKind, "guest"); assert.equal(created.grant.redeemedAt, null);
    // Wrong principal (a different valid guest presenting the leaked token): nothing is returned and the grant stays spendable.
    assert.equal(await store.validateDownloadGrant(g.id, g.asset.id, other.access, now, token), null);
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, other.access, now, token), null);
    assert.equal(await store.consumeDownloadGrant(other.id, g.asset.id, other.access, now, token), null);
    // Wrong asset id, unknown and malformed tokens, a check time at expiry.
    assert.equal(await store.consumeDownloadGrant(g.id, randomUUID(), g.access, now, token), null);
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, g.access, now, tokenHash()), null);
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, g.access, now, token.toUpperCase()), null);
    assert.equal(await store.validateDownloadGrant(g.id, g.asset.id, g.access, seconds(now, SYNTHETIC_GRANT_TTL_SECONDS), token), null);
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, g.access, seconds(now, SYNTHETIC_GRANT_TTL_SECONDS), token), null);
    assert.equal((await store.validateDownloadGrant(g.id, g.asset.id, g.access, now, token))?.grantId, created.grant.grantId);
    const consumed = await store.consumeDownloadGrant(g.id, g.asset.id, g.access, now, token);
    assert.equal(consumed?.grantId, created.grant.grantId); assert.ok(consumed?.redeemedAt);
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, g.access, now, token), null); // single use
    assert.equal(await store.validateDownloadGrant(g.id, g.asset.id, g.access, now, token), null);
  });

  t("download grant: an owner grant is bound to that owner; claim moves access, not a guest grant; late quarantine stops redeem", async () => {
    const { h, store, service, withAsset } = await setup(); const g = await withAsset(), now = new Date();
    await markClean(store, g.id, g.asset.id, g.access, now);
    const guestToken = tokenHash();
    assert.equal((await store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId: randomUUID(), tokenHash: guestToken, expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) })).status, "created");
    const user = await h.newUser(), owner: CompositionAccess = { kind: "owner", userId: user }, stranger: CompositionAccess = { kind: "owner", userId: await h.newUser() };
    await h.m1bClaim(g.id, user); await service.claim(g.id, user, g.capability);
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, g.access, now, guestToken), null); // the claimed capability no longer has access
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, owner, now, guestToken), null); // and the owner is a different principal
    const ownerToken = tokenHash(), second = tokenHash();
    const minted = await store.createDownloadGrant(g.id, g.asset.id, owner, now, { grantId: randomUUID(), tokenHash: ownerToken, expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) });
    assert.equal(minted.status === "created" && minted.grant.principalKind, "owner");
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, stranger, now, ownerToken), null);
    assert.ok(await store.consumeDownloadGrant(g.id, g.asset.id, owner, now, ownerToken));
    assert.equal((await store.createDownloadGrant(g.id, g.asset.id, owner, now, { grantId: randomUUID(), tokenHash: second, expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) })).status, "created");
    await h.lateQuarantine(g.id, g.asset.id);
    assert.equal((await store.getAsset(g.id, g.asset.id, owner, now))!.scanStatus, "quarantined");
    assert.equal(await store.validateDownloadGrant(g.id, g.asset.id, owner, now, second), null);
    assert.equal(await store.consumeDownloadGrant(g.id, g.asset.id, owner, now, second), null);
    assert.deepEqual(await store.createDownloadGrant(g.id, g.asset.id, owner, now, { grantId: randomUUID(), tokenHash: tokenHash(), expiresAt: seconds(now, SYNTHETIC_GRANT_TTL_SECONDS) }), { status: "asset_not_clean", scanStatus: "quarantined" });
  });

  t("freeze refuses a non-clean pinned asset on the insert branch AND the idempotent re-point branch, writing nothing", async () => {
    const { h, store, service, withAsset } = await setup(); const g = await withAsset();
    const s1 = await service.saveDraft(g.id, g.access, 0, sceneWith([imageLayer("l1", g.asset.id, g.asset.sha256)]));
    const s1Version = { id: randomUUID(), scene: s1.scene, sceneSha256: s1.sceneSha256, printProfileId: s1.printProfileId, printProfileVersion: s1.printProfileVersion, preflightState: "preview_only" as const, preflightIssues: [] };
    assert.deepEqual(await store.freeze(g.id, g.access, new Date(), { expectedRevision: s1.draftRevision, state: "frozen_version", sourceAssetSha256: [], sourceFontSha256: [], version: s1Version }),
      { status: "asset_not_clean", assetSha256: [g.asset.sha256] }); // a caller that drops the pin cannot skip the check: the store reads the scene's images too
    await assert.rejects(service.freeze(g.id, g.access, s1.draftRevision), (e: unknown) => e instanceof CompositionError && e.code === "ASSET_NOT_CLEAN"); // pending
    assert.deepEqual(await service.listVersions(g.id, g.access), []);
    assert.equal((await service.get(g.id, g.access)).lifecycleState, "editable_scene");
    await markClean(store, g.id, g.asset.id, g.access);
    const v1 = await service.freeze(g.id, g.access, s1.draftRevision);
    const s2 = await service.saveDraft(g.id, g.access, s1.draftRevision, sceneWith([textLayer("t")]));
    const v2 = await service.freeze(g.id, g.access, s2.draftRevision);
    await h.lateQuarantine(g.id, g.asset.id);
    const restored = await service.restore(g.id, g.access, v1.version.id, s2.draftRevision); // draft scene hash == v1: freeze takes the re-point branch
    await assert.rejects(service.freeze(g.id, g.access, restored.draftRevision), (e: unknown) => e instanceof CompositionError && e.code === "ASSET_NOT_CLEAN");
    const after = await service.get(g.id, g.access);
    assert.equal(after.currentVersionId, v2.version.id); assert.notEqual(after.lifecycleState, "frozen_version");
    assert.deepEqual((await service.listVersions(g.id, g.access)).map(v => v.versionNo), [1, 2]);
    const direct = await store.freeze(g.id, g.access, new Date(), { expectedRevision: restored.draftRevision, state: "frozen_version", sourceAssetSha256: [], sourceFontSha256: [],
      version: { id: randomUUID(), scene: restored.scene, sceneSha256: restored.sceneSha256, printProfileId: v1.version.printProfileId, printProfileVersion: v1.version.printProfileVersion, preflightState: "preview_only", preflightIssues: [] } });
    assert.deepEqual(direct, { status: "asset_not_clean", assetSha256: [g.asset.sha256] }); // the re-point branch checks the EXISTING version's pins, not the caller's list
  });

  t("rate tokens: exactly SYNTHETIC_RATE_MAX per window and subject, next window resets, policy is never defaulted", async () => {
    const { store } = await setup(); const subject = randomUUID(), base = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const at = (s: number) => seconds(base, s);
    const take = (s: number, over: Record<string, unknown> = {}) => store.consumeRateToken({ operation: "GUEST_WRITE", subject, windowSeconds: SYNTHETIC_RATE_WINDOW_SECONDS, max: SYNTHETIC_RATE_MAX, at: at(s), ...over } as never);
    const results = [];
    for (let i = 0; i < SYNTHETIC_RATE_MAX + 2; i += 1) results.push(await take(i));
    assert.deepEqual(results.map(r => r.admitted), [...Array(SYNTHETIC_RATE_MAX).fill(true), false, false]);
    assert.deepEqual(results.filter(r => r.admitted).map(r => (r as { count: number }).count), Array.from({ length: SYNTHETIC_RATE_MAX }, (_, i) => i + 1));
    for (const r of results) { assert.equal(r.windowStart.getTime(), base.getTime()); assert.equal(r.resetAt.getTime(), at(SYNTHETIC_RATE_WINDOW_SECONDS).getTime()); }
    const next = await take(SYNTHETIC_RATE_WINDOW_SECONDS);
    assert.equal(next.admitted && next.count, 1); assert.equal(next.windowStart.getTime(), at(SYNTHETIC_RATE_WINDOW_SECONDS).getTime());
    assert.equal((await take(1, { subject: randomUUID() })).admitted, true); // subjects are independent
    assert.equal((await take(1, { operation: "OWNER_WRITE" })).admitted, true); // operations are independent
    assert.equal((await store.consumeRateToken({ operation: "GUEST_CREATE_GLOBAL", subject: "global", windowSeconds: SYNTHETIC_RATE_WINDOW_SECONDS, max: SYNTHETIC_RATE_MAX })).admitted, true); // database clock
    for (const over of [{ max: 0 }, { max: -1 }, { max: 1.5 }, { max: undefined }, { max: Number.NaN }, { max: 2147483648 }, { windowSeconds: 0 }, { windowSeconds: 2147483648 }, { windowSeconds: undefined }, { subject: "global" }, { subject: "../x" }, { operation: "NOT_AN_OP" }, { at: new Date(Number.NaN) }])
      await assert.rejects(take(0, over), RangeError);
    await assert.rejects(store.consumeRateToken({ operation: "ASSET_UPLOAD_GLOBAL", subject: randomUUID(), windowSeconds: SYNTHETIC_RATE_WINDOW_SECONDS, max: SYNTHETIC_RATE_MAX }), RangeError);
  });

  t("pruneRateBuckets: required cut-off, never after now, removes only windows older than the cut-off", async () => {
    const { store } = await setup(); const subject = randomUUID(), base = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const take = (s: number) => store.consumeRateToken({ operation: "OWNER_RESCAN", subject, windowSeconds: SYNTHETIC_RATE_WINDOW_SECONDS, max: SYNTHETIC_RATE_MAX, at: seconds(base, s) });
    await take(0); await take(SYNTHETIC_RATE_WINDOW_SECONDS);
    const W = SYNTHETIC_RATE_WINDOW_SECONDS, prune = (olderThan: Date, now: Date, longestWindowSeconds: unknown = W) => store.pruneRateBuckets({ olderThan, now, longestWindowSeconds } as never);
    await assert.rejects(prune(seconds(base, 10), base), RangeError); // after now
    await assert.rejects(prune(seconds(base, 1), seconds(base, 1)), RangeError); // would delete the window that is still active at `now`
    await assert.rejects(prune(undefined as never, base), RangeError);
    await assert.rejects(store.pruneRateBuckets({ olderThan: base, now: seconds(base, 2 * W) } as never), RangeError); // longest window is required
    await assert.rejects(prune(base, seconds(base, 2 * W), 0), RangeError);
    assert.equal(await prune(seconds(base, 1), seconds(base, W + 1)), 1); // only the first window, which ended at base + W
    assert.equal(await prune(seconds(base, 1), seconds(base, W + 1)), 0);
    const after = await take(SYNTHETIC_RATE_WINDOW_SECONDS); // the newer window survived the prune
    assert.equal(after.admitted && after.count, 2);
  });

  t("countLiveGuestDrafts counts only unexpired, unclaimed, unowned guest compositions", async () => {
    const { h, service, guest } = await setup(); const now = new Date();
    const base = await h.store.countLiveGuestDrafts(now);
    const a = await guest(), b = await guest();
    await guest();
    await service.createOwned(await h.newUser());
    assert.equal(await h.store.countLiveGuestDrafts(now), base + 3);
    const user = await h.newUser(); await h.m1bClaim(a.id, user);
    assert.equal(await h.store.countLiveGuestDrafts(now), base + 2); // claimed in M1b: no longer live
    await service.claim(a.id, user, a.capability);
    await h.expireGuest(b.id);
    assert.equal(await h.store.countLiveGuestDrafts(now), base + 1);
    await assert.rejects(h.store.countLiveGuestDrafts(new Date(Number.NaN)), RangeError);
  });

  // ---- ADR-0022 C4: quota and live-guest cap enforced in the store (SQL), independent of any service pre-check.
  const newGuestInput = (now: Date) => {
    const scene = EMPTY_SYNTHETIC_SCENE(), id = randomUUID(), capability = randomBytes(32).toString("base64url");
    return { id, capability, input: { id, capabilityHash: secretHash(capability), guestExpiresAt: seconds(now, SYNTHETIC_GUEST_TTL_SECONDS), scene, sceneSha256: sceneSha256(scene), state: "guest_draft" as const, now, liveGuestDraftsMax: SYNTHETIC_LIVE_CAP } };
  };

  t("createGuest: the live cap admits exactly the cap, refuses the next without writing anything, and expiry or an M1b claim frees a slot", async () => {
    const { h, store, guest } = await setup(); await guest(); // creating one through the service also ensures the print profile (FK)
    const now = new Date(), base = await store.countLiveGuestDrafts(now), cap = base + SYNTHETIC_LIVE_CAP;
    const made = [];
    for (let i = 0; i < SYNTHETIC_LIVE_CAP; i += 1) { const g = newGuestInput(now); const out = await store.createGuest({ ...g.input, liveGuestDraftsMax: cap }); assert.equal(out.status, "created"); made.push(g); }
    const refused = newGuestInput(now), out = await store.createGuest({ ...refused.input, liveGuestDraftsMax: cap });
    assert.deepEqual(out, { status: "cap_reached" });
    assert.equal(await store.get(refused.id, { kind: "guest", capabilityHash: secretHash(refused.capability) }, now), null, "nothing was written for the refused draft");
    assert.equal(await store.countLiveGuestDrafts(now), cap);
    await h.expireGuest(made[0]!.id); // an expired draft is not live
    assert.equal((await store.createGuest({ ...newGuestInput(now).input, liveGuestDraftsMax: cap })).status, "created");
    assert.deepEqual(await store.createGuest({ ...newGuestInput(now).input, liveGuestDraftsMax: cap }), { status: "cap_reached" });
    await h.m1bClaim(made[1]!.id, await h.newUser()); // claimed in M1b: not live either
    assert.equal((await store.createGuest({ ...newGuestInput(now).input, liveGuestDraftsMax: cap })).status, "created");
  });

  t("createGuest: an unset, zero, negative, fractional or non-numeric cap throws and is never unlimited; a bad time throws", async () => {
    const { store, guest } = await setup(); await guest(); const now = new Date();
    for (const bad of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(store.createGuest({ ...newGuestInput(now).input, liveGuestDraftsMax: bad as number }), RangeError, String(bad));
    await assert.rejects(store.createGuest({ ...newGuestInput(now).input, now: new Date(Number.NaN) }), RangeError);
    assert.equal((await store.createGuest(newGuestInput(now).input)).status, "created", "the same input with a valid cap works");
  });

  const quota = { maxAssets: SYNTHETIC_QUOTA_MAX_ASSETS, maxBytes: SYNTHETIC_QUOTA_BYTES };
  /** The object key must match the 0001 CHECK: private/composition/v1/<composition id>/<sha256>. */
  const assetInput = (compositionId: string, byteSize: number, sha = createHash("sha256").update(randomUUID()).digest("hex")) =>
    ({ id: randomUUID(), sha256: sha, mime: "image/png", byteSize, widthPx: 4, heightPx: 4, objectKey: `private/composition/v1/${compositionId}/${sha}` });

  t("insertAsset quota: count and bytes are enforced in SQL; the same bytes are idempotent even at the quota; no access means not_found", async () => {
    const { h, store, guest } = await setup(); const g = await guest(), now = new Date();
    const first = await store.insertAsset(g.id, g.access, now, assetInput(g.id, 10), quota);
    assert.equal(first.status, "inserted"); assert.equal(first.status === "inserted" && first.asset.scanStatus, "pending");
    for (let i = 2; i <= SYNTHETIC_QUOTA_MAX_ASSETS; i += 1) assert.equal((await store.insertAsset(g.id, g.access, now, assetInput(g.id, 10), quota)).status, "inserted");
    assert.deepEqual(await store.insertAsset(g.id, g.access, now, assetInput(g.id, 10), quota), { status: "quota_exceeded" });
    assert.equal((await store.listAssets(g.id, g.access, now))!.length, SYNTHETIC_QUOTA_MAX_ASSETS);
    const again = await store.insertAsset(g.id, g.access, now, assetInput(g.id, 10, first.status === "inserted" ? first.asset.sha256 : ""), quota);
    assert.equal(again.status, "existing"); assert.equal(again.status === "existing" && again.asset.id, first.status === "inserted" ? first.asset.id : "", "a duplicate never counts against the quota");
    // bytes: a single new asset that would pass the byte maximum is refused even though the count has room
    const b = await guest();
    assert.equal((await store.insertAsset(b.id, b.access, now, assetInput(b.id, SYNTHETIC_QUOTA_BYTES), quota)).status, "inserted");
    assert.deepEqual(await store.insertAsset(b.id, b.access, now, assetInput(b.id, 1), quota), { status: "quota_exceeded" });
    const c = await guest();
    assert.deepEqual(await store.insertAsset(c.id, c.access, now, assetInput(c.id, SYNTHETIC_QUOTA_BYTES + 1), quota), { status: "quota_exceeded" });
    // access: foreign, expired, claimed and malformed ids are all the same not_found, and nothing is written
    const other = await guest(), user = await h.newUser();
    for (const [id, access] of [[c.id, other.access], [randomUUID(), c.access], ["not-a-uuid", c.access], [c.id, { kind: "owner", userId: user } as CompositionAccess]] as const)
      assert.deepEqual(await store.insertAsset(id, access, now, assetInput(id, 1), quota), { status: "not_found" });
    await h.expireGuest(c.id); assert.deepEqual(await store.insertAsset(c.id, c.access, now, assetInput(c.id, 1), quota), { status: "not_found" });
    const d = await guest(); await h.m1bClaim(d.id, user); assert.deepEqual(await store.insertAsset(d.id, d.access, now, assetInput(d.id, 1), quota), { status: "not_found" });
  });

  t("insertAsset quota: unset, zero, negative or fractional maxima throw and are never unlimited", async () => {
    const { store, guest } = await setup(); const g = await guest(), now = new Date();
    for (const bad of [undefined, null, 0, -1, 1.5, Number.NaN, "3"])
      for (const key of ["maxAssets", "maxBytes"] as const) await assert.rejects(store.insertAsset(g.id, g.access, now, assetInput(g.id, 1), { ...quota, [key]: bad } as never), RangeError, `${key}=${String(bad)}`);
    await assert.rejects(store.insertAsset(g.id, g.access, now, assetInput(g.id, 1), undefined as never), RangeError);
    await assert.rejects(store.insertAsset(g.id, g.access, now, assetInput(g.id, 0), quota), RangeError);
    assert.deepEqual(await store.listAssets(g.id, g.access, now), []);
  });
}
