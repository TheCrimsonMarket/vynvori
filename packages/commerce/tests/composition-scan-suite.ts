/**
 * ADR-0022 C5 conformance: the malware-scan boundary, driven through the real service and HTTP handlers. ONE scenario list, run
 * against the in-memory port (composition.test.ts) and the PostgreSQL store (composition-pg.test.ts, `db-integration`). The scan
 * port here is the SYNTHETIC double from composition-synthetic.ts: it is not a scanner and stands in for no vendor (ruling QC).
 * Every number is a SYNTHETIC_* fixture; none is policy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ArtifactScanPort, CompositionAccess } from "@vynvori/contracts/composition-port";
import { compositionService, CompositionError, secretHash, type CompositionConfig } from "../src/composition";
import { compositionCookies, compositionHttpHandlers, type CompositionIdentityPort } from "../src/composition-http";
import { unconfiguredScanPort } from "../src/composition-scan";
import { imageLayer, memoryStorage, png, sceneWith } from "./composition-fixtures";
import type { StoreHarness } from "./composition-store-suite";
import {
  SYNTHETIC_COMPOSITION_CONFIG, SYNTHETIC_GRANT_TTL_SECONDS, SYNTHETIC_HTTP_LIMITS, SYNTHETIC_RATE_LIMIT, SYNTHETIC_RATE_LIMIT_WINDOW_SECONDS, SYNTHETIC_SCAN_EVIDENCE,
  syntheticRatePolicies, syntheticScanAnswer, syntheticScanPort, type SyntheticScanBehaviour,
} from "./composition-synthetic";

const ORIGIN = "https://staging.vynvori.test", SESSION = "s".repeat(43);
/** SYNTHETIC: a lease only 1 ms longer than the timeout, and an attempt-open delay longer than that margin. */
const SYNTHETIC_TIGHT_TIMEOUT_MS = 200, SYNTHETIC_SLOW_OPEN_MS = 20;
/** SYNTHETIC: a lease short enough to pass on the real (database) clock inside a test, and a timeout shorter than it. */
const SYNTHETIC_SHORT_LEASE_MS = 1000, SYNTHETIC_SHORT_TIMEOUT_MS = 100;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const code = async (promise: Promise<unknown>, expected: CompositionError["code"]) => assert.rejects(promise, (e: unknown) => e instanceof CompositionError && e.code === expected);
const tokenHash = () => createHash("sha256").update(randomBytes(32)).digest("hex");

export function scanConformance(label: string, factory: () => Promise<StoreHarness>, options: { skip?: boolean } = {}) {
  const t = (name: string, fn: () => Promise<void>) => test(`${label}: ${name}`, { skip: options.skip ?? false }, fn);

  async function build(over: { port?: ArtifactScanPort; behaviour?: SyntheticScanBehaviour; config?: Partial<CompositionConfig>; wrapStore?: (store: StoreHarness["store"]) => StoreHarness["store"] } = {}) {
    const h = await factory(), storage = memoryStorage(), synthetic = syntheticScanPort(over.behaviour), port = over.port ?? synthetic;
    const config: CompositionConfig = { ...SYNTHETIC_COMPOSITION_CONFIG, uploadsEnabled: true, scanPort: port, ...over.config };
    const service = compositionService(over.wrapStore ? over.wrapStore(h.store) : h.store, storage, config);
    const users = new Map<string, string>();
    const identity: CompositionIdentityPort = {
      async verify(secret) { const userId = users.get(secret); if (!userId) throw new Error("no session"); return { userId }; },
      async claimGuest(secret, draftId) { await h.m1bClaim(draftId, users.get(secret)!); },
    };
    const http = compositionHttpHandlers({ enabled: true, appOrigin: ORIGIN, ...SYNTHETIC_HTTP_LIMITS }, service, identity);
    const guest = async () => {
      const created = await service.createGuest();
      return { id: created.record.id, capability: created.capability, access: { kind: "guest", capabilityHash: secretHash(created.capability) } as CompositionAccess, cookie: `${compositionCookies.guest}=${created.record.id}.${created.capability}` };
    };
    /** A stored, `pending` asset (the service-level upload does not scan; the HTTP upload route does). */
    const pendingAsset = async (salt = 1) => { const g = await guest(), bytes = png(64, 64, salt); return { ...g, bytes, asset: await service.uploadAsset(g.id, g.access, bytes, "image/png") }; };
    return { h, store: h.store, storage, calls: synthetic.calls, service, http, users, guest, pendingAsset };
  }
  type Ctx = Awaited<ReturnType<typeof build>>;
  const post = (cookie: string | null, init: { raw?: Uint8Array; type?: string; json?: unknown } = {}) => new Request(`${ORIGIN}/x`, {
    method: "POST", body: init.raw ? Buffer.from(init.raw) : init.json !== undefined ? JSON.stringify(init.json) : null,
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...(init.type ? { "content-type": init.type } : {}), ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
  });
  const get = (cookie: string) => new Request(`${ORIGIN}/x`, { headers: { cookie } });
  const history = async (ctx: Ctx, g: { id: string; access: CompositionAccess }, assetId: string) =>
    (await ctx.store.listScanEvents(g.id, assetId, g.access, new Date()))!.map(e => `${e.fromStatus}>${e.toStatus}${e.reasonCode ? `:${e.reasonCode}` : ""}`);

  // ---- default wiring: no scanner, so uploads and rescans stay closed (ruling QC)
  t("with unconfiguredScanPort, uploads answer UPLOADS_DISABLED and rescans SCAN_UNAVAILABLE, after access, writing nothing and calling nothing", async () => {
    const ctx = await build({ port: unconfiguredScanPort }), g = await ctx.guest(), stranger = await ctx.guest();
    await code(ctx.service.uploadAsset(g.id, g.access, png(64, 64), "image/png"), "UPLOADS_DISABLED");
    await code(ctx.service.rescanAsset(g.id, randomUUID(), g.access), "SCAN_UNAVAILABLE");
    const upload = await ctx.http.uploadAsset(post(g.cookie, { raw: png(64, 64), type: "image/png" }), { id: g.id });
    assert.equal(upload.status, 503); assert.equal((await upload.json()).error.code, "COMPOSITION_UPLOADS_DISABLED");
    const rescan = await ctx.http.scanAsset(post(g.cookie), { id: g.id, assetId: randomUUID() });
    assert.equal(rescan.status, 503); assert.equal((await rescan.json()).error.code, "COMPOSITION_SCAN_UNAVAILABLE");
    // a caller without access learns nothing about the scanner either: the same 404 as for any foreign draft
    const forged = `${compositionCookies.guest}=${g.id}.${stranger.capability}`; // well formed, another draft's capability
    assert.equal((await ctx.http.uploadAsset(post(forged, { raw: png(64, 64), type: "image/png" }), { id: g.id })).status, 404);
    assert.equal((await ctx.http.scanAsset(post(forged), { id: g.id, assetId: randomUUID() })).status, 404);
    assert.equal(ctx.storage.objects.size, 0, "no object was stored");
    assert.deepEqual(await ctx.service.listAssets(g.id, g.access), []);
  });
  t("scanning also closes on unset scan limits and on a lease that does not outlive the timeout (LIMITS_NOT_CONFIGURED), never unlimited", async () => {
    for (const config of [{ scanTimeoutMs: undefined }, { scanLeaseMs: undefined }, { scanTimeoutMs: SYNTHETIC_SHORT_LEASE_MS, scanLeaseMs: SYNTHETIC_SHORT_LEASE_MS }]) {
      const ctx = await build({ config }), g = await ctx.guest();
      await code(ctx.service.uploadAsset(g.id, g.access, png(64, 64), "image/png"), "LIMITS_NOT_CONFIGURED");
      await code(ctx.service.rescanAsset(g.id, randomUUID(), g.access), "LIMITS_NOT_CONFIGURED");
      assert.equal(ctx.storage.objects.size, 0);
    }
  });

  // ---- the inline scan on upload
  t("HTTP upload scans inline exactly once with the stored bytes; clean is listed and served; the asset view is whitelisted", async () => {
    const ctx = await build(), g = await ctx.guest(), bytes = png(64, 64, 7);
    const response = await ctx.http.uploadAsset(post(g.cookie, { raw: bytes, type: "image/png" }), { id: g.id });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.asset).sort(), ["assetId", "heightPx", "mime", "scanStatus", "sha256", "widthPx"]);
    assert.equal(body.asset.scanStatus, "clean");
    assert.equal(ctx.calls.length, 1);
    const call = ctx.calls[0]!;
    assert.deepEqual([call.assetId, call.sha256, call.mime, call.byteSize], [body.asset.assetId, body.asset.sha256, "image/png", bytes.byteLength]);
    assert.deepEqual(Buffer.from(call.bytes), Buffer.from(bytes));
    const again = await ctx.http.uploadAsset(post(g.cookie, { raw: bytes, type: "image/png" }), { id: g.id }); // same bytes: the existing clean asset, no second call
    assert.equal((await again.json()).asset.scanStatus, "clean"); assert.equal(ctx.calls.length, 1);
    const listed = await (await ctx.http.get(get(g.cookie), { id: g.id })).json();
    assert.deepEqual(listed.assets.map((a: { scanStatus: string }) => a.scanStatus), ["clean"]);
    for (const a of listed.assets) assert.deepEqual(Object.keys(a).sort(), ["assetId", "heightPx", "mime", "scanStatus", "sha256", "widthPx"]);
    const text = JSON.stringify(listed);
    for (const internal of [SYNTHETIC_SCAN_EVIDENCE.engineVersion, "evidence://", "synthetic-scanner", "objectKey", "private/composition", "attemptId"]) assert.equal(text.includes(internal), false, `${internal} must not be serialised`);
    const read = await ctx.http.readAsset(get(g.cookie), { id: g.id, assetId: body.asset.assetId });
    assert.equal(read.status, 200); assert.deepEqual(Buffer.from(await read.arrayBuffer()), Buffer.from(bytes));
  });

  // ---- result mapping: everything but a well-formed clean/infected answer for the same bytes is `unknown`
  const MAPPING: readonly [string, SyntheticScanBehaviour, string, string][] = [
    ["clean", r => syntheticScanAnswer("clean", r), "clean", "pending>clean"],
    ["infected", r => syntheticScanAnswer("infected", r), "quarantined", "pending>quarantined"],
    ["error verdict", r => syntheticScanAnswer("error", r), "unknown", "pending>unknown:scanner_error"],
    ["unrecognised verdict", r => syntheticScanAnswer("clean", r, { verdict: "probably_fine" }), "unknown", "pending>unknown:scan_result_malformed"],
    ["missing field", r => { const { evidenceRef: _e, ...rest } = syntheticScanAnswer("clean", r); return rest; }, "unknown", "pending>unknown:scan_result_malformed"],
    ["extra field", r => ({ ...syntheticScanAnswer("clean", r), scannerId: "spoofed" }), "unknown", "pending>unknown:scan_result_malformed"],
    ["not an object", () => "clean", "unknown", "pending>unknown:scan_result_malformed"],
    ["wrong hash", r => syntheticScanAnswer("clean", r, { sha256: "0".repeat(64) }), "unknown", "pending>unknown:scan_hash_mismatch"],
    ["throws", () => { throw new Error("synthetic failure"); }, "unknown", "pending>unknown:scanner_threw"],
    ["timeout (a late clean answer is ignored)", (r, signal) => new Promise(resolve => signal.addEventListener("abort", () => setTimeout(() => resolve(syntheticScanAnswer("clean", r)), 5))), "quarantined", "pending>quarantined:scan_timeout"],
  ];
  for (const [name, behaviour, status, event] of MAPPING) {
    t(`result mapping: ${name} -> ${status}`, async () => {
      const ctx = await build({ behaviour }), g = await ctx.pendingAsset();
      assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), status);
      assert.equal((await ctx.store.getAsset(g.id, g.asset.id, g.access, new Date()))!.scanStatus, status);
      assert.deepEqual(await history(ctx, g, g.asset.id), [event]);
      const recorded = (await ctx.store.listScanEvents(g.id, g.asset.id, g.access, new Date()))!.at(-1)!;
      assert.equal(recorded.scannerId, "synthetic-scanner", "the scanner id is the port's, never a value from the result");
      assert.equal(ctx.calls.length, 1, "one call, never retried");
    });
  }
  // ---- M3-F2a: a timed-out scan is an unknown outcome (AGENTS rule 7). It is quarantined and waits for a human; nothing re-checks it.
  const timesOut: SyntheticScanBehaviour = (r, signal) => new Promise(resolve => signal.addEventListener("abort", () => setTimeout(() => resolve(syntheticScanAnswer("clean", r)), 5)));
  t("timed-out scan: quarantined with a reason and honest evidence text, a late clean answer is ignored, nothing is served", async () => {
    const ctx = await build({ behaviour: timesOut }), g = await ctx.pendingAsset();
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "quarantined");
    const [event] = (await ctx.store.listScanEvents(g.id, g.asset.id, g.access, new Date()))!;
    assert.deepEqual([event!.fromStatus, event!.toStatus, event!.reasonCode, event!.scannerId, event!.engineVersion, event!.definitionsVersion], ["pending", "quarantined", "scan_timeout", "synthetic-scanner", "unavailable", "unavailable"]);
    assert.match(event!.evidenceRef ?? "", /human-reconcile-required/); assert.ok(event!.attemptId, "the attempt that timed out is on the event");
    await sleep(50); // the late `clean` answer has arrived by now and must change nothing
    assert.equal((await ctx.store.getAsset(g.id, g.asset.id, g.access, new Date()))!.scanStatus, "quarantined");
    await code(ctx.service.readAsset(g.id, g.asset.id, g.access), "NOT_FOUND");
    const now = new Date();
    assert.deepEqual(await ctx.store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId: randomUUID(), tokenHash: tokenHash(), expiresAt: new Date(now.getTime() + SYNTHETIC_GRANT_TTL_SECONDS * 1000) }), { status: "asset_not_clean", scanStatus: "quarantined" });
  });
  t("timed-out scan: no re-check without a human. An explicit rescan, over the service and over HTTP, reports quarantined, makes no call and records nothing", async () => {
    const ctx = await build({ behaviour: timesOut }), g = await ctx.pendingAsset();
    await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes);
    assert.equal(ctx.calls.length, 1);
    assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "quarantined");
    const res = await ctx.http.scanAsset(post(g.cookie), { id: g.id, assetId: g.asset.id });
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), { asset: { assetId: g.asset.id, scanStatus: "quarantined" } });
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "quarantined");
    assert.equal(ctx.calls.length, 1, "the port was called exactly once, never again");
    assert.deepEqual(await history(ctx, g, g.asset.id), ["pending>quarantined:scan_timeout"]);
  });
  t("timed-out scan: the HTTP views never carry the reason, the evidence text or the scanner id", async () => {
    const ctx = await build({ behaviour: timesOut }), g = await ctx.pendingAsset();
    await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes);
    const listed = JSON.stringify(await (await ctx.http.get(get(g.cookie), { id: g.id })).json());
    assert.match(listed, /"scanStatus":"quarantined"/);
    for (const internal of ["scan_timeout", "unavailable", "reconcile", "synthetic-scanner", "attemptId", "evidenceRef"]) assert.equal(listed.includes(internal), false, `${internal} must not be serialised`);
  });
  t("a port that throws its own TimeoutError or AbortError is a timeout too: quarantined, not a re-checkable unknown", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      const ctx = await build({ behaviour: () => { throw Object.assign(new Error("synthetic deadline"), { name }); } }), g = await ctx.pendingAsset();
      assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "quarantined", name);
      assert.deepEqual(await history(ctx, g, g.asset.id), ["pending>quarantined:scan_timeout"]);
      assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "quarantined"); assert.equal(ctx.calls.length, 1);
    }
  });
  t("a thrown error is still unknown (a retryable failure the owner may re-check), not quarantined", async () => {
    const ctx = await build({ behaviour: () => { throw new Error("synthetic failure"); } }), g = await ctx.pendingAsset();
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "unknown");
    assert.deepEqual(await history(ctx, g, g.asset.id), ["pending>unknown:scanner_threw"]);
  });
  t("bytes that do not match the asset row never reach the scanner (STORAGE_UNAVAILABLE, nothing recorded)", async () => {
    const ctx = await build(), g = await ctx.pendingAsset();
    await code(ctx.service.scanAsset(g.id, g.asset.id, g.access, png(64, 64, 99)), "STORAGE_UNAVAILABLE");
    assert.equal(ctx.calls.length, 0); assert.deepEqual(await history(ctx, g, g.asset.id), []);
  });

  // ---- D5 choke points for every non-clean status
  t("pending, unknown and quarantined assets cannot be read, frozen or granted, and the HTTP read answers the uniform 404", async () => {
    const verdicts: SyntheticScanBehaviour[] = [r => syntheticScanAnswer("error", r), r => syntheticScanAnswer("infected", r)];
    for (const behaviour of [undefined, ...verdicts]) {
      const ctx = await build(behaviour ? { behaviour } : {}), g = await ctx.pendingAsset();
      if (behaviour) await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes);
      const status = (await ctx.store.getAsset(g.id, g.asset.id, g.access, new Date()))!.scanStatus;
      assert.notEqual(status, "clean");
      await code(ctx.service.readAsset(g.id, g.asset.id, g.access), "NOT_FOUND");
      const read = await ctx.http.readAsset(get(g.cookie), { id: g.id, assetId: g.asset.id }), foreign = await ctx.http.readAsset(get(g.cookie), { id: g.id, assetId: randomUUID() });
      const [a, b] = [await read.json(), await foreign.json()];
      assert.equal(read.status, 404); assert.equal(foreign.status, 404);
      assert.deepEqual({ ...a.error, correlationId: null }, { ...b.error, correlationId: null }, `${status}: indistinguishable from an absent asset`);
      const saved = await ctx.service.saveDraft(g.id, g.access, 0, sceneWith([imageLayer("l1", g.asset.id, g.asset.sha256)])); // a draft may reference it
      await code(ctx.service.freeze(g.id, g.access, saved.draftRevision), "ASSET_NOT_CLEAN");
      assert.deepEqual(await ctx.service.listVersions(g.id, g.access), []);
      const now = new Date(), grant = await ctx.store.createDownloadGrant(g.id, g.asset.id, g.access, now, { grantId: randomUUID(), tokenHash: tokenHash(), expiresAt: new Date(now.getTime() + SYNTHETIC_GRANT_TTL_SECONDS * 1000) });
      assert.deepEqual(grant, { status: "asset_not_clean", scanStatus: status });
    }
  });

  // ---- reservations: one attempt, one call
  t("concurrent rescans of a pending asset open exactly one attempt and call the port exactly once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ctx = await build({ behaviour: async r => { await gate; return syntheticScanAnswer("clean", r); } }), g = await ctx.pendingAsset();
    const racing = Array.from({ length: 4 }, () => ctx.service.rescanAsset(g.id, g.asset.id, g.access));
    while (ctx.calls.length === 0) await sleep(5); // the first caller holds the reservation and is inside the port
    await sleep(100); // the others have had time to meet the reservation
    release();
    const outcomes = await Promise.all(racing);
    assert.equal(ctx.calls.length, 1, "the scanner is called once");
    assert.deepEqual(outcomes.sort(), ["clean", "pending", "pending", "pending"]);
    assert.deepEqual(await history(ctx, g, g.asset.id), ["pending>clean"]);
  });
  t("a rescan request meets an open attempt whose lease is active: it reports pending, expires nothing and calls nothing", async () => {
    const ctx = await build(), g = await ctx.pendingAsset(), now = new Date();
    assert.equal((await ctx.store.openScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), leaseExpiresAt: new Date(now.getTime() + SYNTHETIC_SHORT_LEASE_MS * 60) })).status, "opened");
    assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "pending");
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "pending");
    assert.equal(ctx.calls.length, 0); assert.deepEqual(await history(ctx, g, g.asset.id), []);
  });
  t("a lapsed lease is never closed automatically; one explicit request closes it as unknown(lease_expired) without a call, the next scans once", async () => {
    const ctx = await build({ config: { scanTimeoutMs: SYNTHETIC_SHORT_TIMEOUT_MS, scanLeaseMs: SYNTHETIC_SHORT_LEASE_MS } }), g = await ctx.pendingAsset(), now = new Date();
    // a stranded reservation, as after a crash between opening the attempt and recording the result
    assert.equal((await ctx.store.openScanAttempt(g.id, g.asset.id, g.access, now, { attemptId: randomUUID(), leaseExpiresAt: new Date(now.getTime() + SYNTHETIC_SHORT_LEASE_MS) })).status, "opened");
    await sleep(SYNTHETIC_SHORT_LEASE_MS + 150);
    assert.equal((await ctx.store.getAsset(g.id, g.asset.id, g.access, new Date()))!.scanStatus, "pending", "nothing expired it by itself");
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "pending", "the inline upload path never expires a lease");
    assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "unknown");
    assert.equal(ctx.calls.length, 0, "closing a lapsed attempt is not a scan");
    assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "clean");
    assert.equal(ctx.calls.length, 1);
    assert.deepEqual(await history(ctx, g, g.asset.id), ["pending>unknown:lease_expired", "unknown>pending:rescan_requested", "pending>clean"]);
  });
  t("unknown -> explicit rescan -> pending -> one new call; clean and quarantined are only reported", async () => {
    let verdict: "error" | "infected" | "clean" = "error";
    const ctx = await build({ behaviour: r => syntheticScanAnswer(verdict, r) }), g = await ctx.pendingAsset();
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "unknown");
    verdict = "infected";
    assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "quarantined");
    verdict = "clean";
    assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "quarantined", "quarantined is terminal and never auto-released");
    assert.equal(ctx.calls.length, 2);
    const c = await ctx.pendingAsset(2);
    assert.equal(await ctx.service.rescanAsset(c.id, c.asset.id, c.access), "clean");
    assert.equal(await ctx.service.rescanAsset(c.id, c.asset.id, c.access), "clean");
    assert.equal(ctx.calls.length, 3, "a clean asset is not scanned again by this path");
  });
  t("a storage failure on rescan leaves an unknown asset unknown: the bytes are verified before unknown -> pending is recorded", async () => {
    const ctx = await build({ behaviour: r => syntheticScanAnswer("error", r) }), g = await ctx.pendingAsset();
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "unknown");
    ctx.storage.objects.clear();
    await code(ctx.service.rescanAsset(g.id, g.asset.id, g.access), "STORAGE_UNAVAILABLE");
    assert.deepEqual(await history(ctx, g, g.asset.id), ["pending>unknown:scanner_error"]); assert.equal(ctx.calls.length, 1);
  });
  t("if opening the attempt left too little lease for the call, the attempt closes as unknown(scan_not_started) and the scanner is never called", async () => {
    const delayed = (store: StoreHarness["store"]) => new Proxy(store, { get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "openScanAttempt" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return async (...args: unknown[]) => { const opened = await value.apply(target, args); await new Promise(resolve => setTimeout(resolve, SYNTHETIC_SLOW_OPEN_MS)); return opened; };
    } });
    const ctx = await build({ wrapStore: delayed, config: { scanTimeoutMs: SYNTHETIC_TIGHT_TIMEOUT_MS, scanLeaseMs: SYNTHETIC_TIGHT_TIMEOUT_MS + 1 } }), g = await ctx.pendingAsset();
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "unknown");
    assert.equal(ctx.calls.length, 0, "no call that could outlive its lease is started");
    assert.deepEqual(await history(ctx, g, g.asset.id), ["pending>unknown:scan_not_started"]);
  });
  t("an asset row with no scan history (as before 0002, or stranded before its first attempt) is pending and is scanned by a rescan request", async () => {
    const ctx = await build(), g = await ctx.pendingAsset();
    assert.deepEqual(await history(ctx, g, g.asset.id), []);
    assert.equal((await ctx.service.listAssets(g.id, g.access))[0]!.scanStatus, "pending");
    assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "clean");
    assert.equal(ctx.calls.length, 1);
  });
  t("scan results are never shared across compositions: the same bytes are scanned for each composition", async () => {
    const ctx = await build(), a = await ctx.guest(), b = await ctx.guest(), bytes = png(64, 64, 5);
    const assetA = await ctx.service.uploadAsset(a.id, a.access, bytes, "image/png"), assetB = await ctx.service.uploadAsset(b.id, b.access, bytes, "image/png");
    assert.equal(await ctx.service.scanAsset(a.id, assetA.id, a.access, bytes), "clean");
    assert.equal((await ctx.service.listAssets(b.id, b.access))[0]!.scanStatus, "pending");
    assert.equal(await ctx.service.scanAsset(b.id, assetB.id, b.access, bytes), "clean");
    assert.equal(ctx.calls.length, 2);
  });

  // ---- access lost while the scanner runs (the C3b gate: guest expired or claimed during a scan)
  for (const loss of ["expired", "claimed"] as const) {
    t(`guest ${loss} during a scan: the result is dropped (NOT_FOUND), the asset stays pending and the attempt open; nothing retries`, async () => {
      let during: () => Promise<void> = async () => {};
      const ctx = await build({ behaviour: async r => { await during(); return syntheticScanAnswer("clean", r); } }), g = await ctx.pendingAsset(), userId = await ctx.h.newUser();
      during = async () => { if (loss === "expired") await ctx.h.expireGuest(g.id); else { await ctx.h.m1bClaim(g.id, userId); await ctx.service.claim(g.id, userId, g.capability); } };
      await code(ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "NOT_FOUND");
      assert.equal(ctx.calls.length, 1);
      if (loss === "claimed") {
        const owner: CompositionAccess = { kind: "owner", userId };
        assert.equal((await ctx.store.getAsset(g.id, g.asset.id, owner, new Date()))!.scanStatus, "pending");
        assert.deepEqual(await history(ctx, { id: g.id, access: owner }, g.asset.id), [], "the dropped result was never recorded");
        during = async () => {};
        assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, owner), "pending", "the new owner meets the open reservation until its lease passes");
        assert.equal(ctx.calls.length, 1, "no second call while the first attempt's lease is active");
      } else {
        assert.equal(await ctx.store.getAsset(g.id, g.asset.id, g.access, new Date()), null, "an expired guest has no access to anything");
      }
    });
  }

  // ---- the rescan route: no client-supplied verdict can exist
  t("rescan route: refuses any body (even a verdict) after charging, accepts an empty one, and is limited by *_RESCAN", async () => {
    const ctx = await build({ config: { rate: syntheticRatePolicies({ GUEST_RESCAN: { windowSeconds: SYNTHETIC_RATE_LIMIT_WINDOW_SECONDS, max: SYNTHETIC_RATE_LIMIT + 1 } }) } }), g = await ctx.pendingAsset();
    const bodies = [{ verdict: "clean" }, { toStatus: "clean", evidenceRef: "x" }, {}];
    assert.equal(bodies.length, SYNTHETIC_RATE_LIMIT);
    for (const json of bodies) assert.equal((await ctx.http.scanAsset(post(g.cookie, { json }), { id: g.id, assetId: g.asset.id })).status, 413, JSON.stringify(json));
    assert.equal(ctx.calls.length, 0); assert.deepEqual(await history(ctx, g, g.asset.id), [], "a refused request changed nothing");
    const ok = await ctx.http.scanAsset(post(g.cookie), { id: g.id, assetId: g.asset.id }); // the last token in this window
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { asset: { assetId: g.asset.id, scanStatus: "clean" } });
    const limited = await ctx.http.scanAsset(post(g.cookie), { id: g.id, assetId: g.asset.id });
    assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal(ctx.calls.length, 1);
  });
  t("rescan route: no or invalid credentials, a foreign draft and an unknown asset get 401/403/404; callers without access create no bucket row", async () => {
    const ctx = await build(), g = await ctx.pendingAsset(), stranger = await ctx.guest();
    const rows = await ctx.h.bucketCount();
    assert.equal((await ctx.http.scanAsset(post(null), { id: g.id, assetId: g.asset.id })).status, 401);
    assert.equal((await ctx.http.scanAsset(post(stranger.cookie), { id: g.id, assetId: g.asset.id })).status, 401, "a capability cookie for another draft id");
    assert.equal((await ctx.http.scanAsset(post(`${compositionCookies.guest}=${g.id}.${"z".repeat(43)}`), { id: g.id, assetId: g.asset.id })).status, 404);
    assert.equal((await ctx.http.scanAsset(post(`${compositionCookies.guest}=${g.id}.${stranger.capability}`), { id: g.id, assetId: g.asset.id })).status, 404);
    ctx.users.set(SESSION, randomUUID());
    assert.equal((await ctx.http.scanAsset(post(`${compositionCookies.session}=${SESSION}`), { id: g.id, assetId: g.asset.id })).status, 403, "session callers need the CSRF double submit");
    assert.equal(await ctx.h.bucketCount(), rows, "no bucket row for callers without access");
    assert.equal((await ctx.http.scanAsset(post(g.cookie), { id: g.id, assetId: randomUUID() })).status, 404);
    assert.equal((await ctx.http.scanAsset(post(g.cookie), { id: g.id, assetId: "not-a-uuid" })).status, 404);
    assert.equal((await ctx.http.scanAsset(post(stranger.cookie), { id: stranger.id, assetId: g.asset.id })).status, 404, "another composition's asset");
    assert.equal(ctx.calls.length, 0);
  });

  // ---- late detection (clean -> quarantined): a scanner-side store primitive, lock first
  t("late detection primitive: clean -> quarantined with full evidence under the asset lock; any other status is refused and nothing is written", async () => {
    const ctx = await build(), g = await ctx.pendingAsset(), now = new Date(), stranger = await ctx.guest();
    const input = () => ({ attemptId: randomUUID(), startedAt: now, leaseExpiresAt: new Date(now.getTime() + SYNTHETIC_SHORT_LEASE_MS), result: { toStatus: "quarantined" as const, ...SYNTHETIC_SCAN_EVIDENCE, evidenceRef: "evidence://synthetic/late" } });
    assert.deepEqual(await ctx.store.recordLateDetection(g.id, g.asset.id, g.access, now, input()), { status: "rejected", reason: "illegal_transition", scanStatus: "pending" });
    assert.equal(await ctx.service.scanAsset(g.id, g.asset.id, g.access, g.bytes), "clean");
    assert.deepEqual(await ctx.store.recordLateDetection(g.id, g.asset.id, stranger.access, now, input()), { status: "not_found" });
    await assert.rejects(ctx.store.recordLateDetection(g.id, g.asset.id, g.access, now, { ...input(), result: { ...input().result, evidenceRef: "" } }), RangeError);
    await assert.rejects(ctx.store.recordLateDetection(g.id, g.asset.id, g.access, now, { ...input(), result: { toStatus: "clean", ...SYNTHETIC_SCAN_EVIDENCE } as never }), RangeError);
    await assert.rejects(ctx.store.recordLateDetection(g.id, g.asset.id, g.access, now, { ...input(), leaseExpiresAt: now }), RangeError);
    assert.deepEqual(await history(ctx, g, g.asset.id), ["pending>clean"], "refusals wrote nothing");
    const late = await ctx.store.recordLateDetection(g.id, g.asset.id, g.access, new Date(now.getTime() + 1), input());
    assert.equal(late.status, "recorded");
    if (late.status === "recorded") { assert.deepEqual([late.event.fromStatus, late.event.toStatus, late.event.seq], ["clean", "quarantined", 2]); assert.ok(late.event.attemptId); }
    assert.deepEqual(await ctx.store.recordLateDetection(g.id, g.asset.id, g.access, new Date(now.getTime() + 2), input()), { status: "rejected", reason: "illegal_transition", scanStatus: "quarantined" });
    await code(ctx.service.readAsset(g.id, g.asset.id, g.access), "NOT_FOUND");
    assert.equal(await ctx.service.rescanAsset(g.id, g.asset.id, g.access), "quarantined");
    assert.equal(ctx.calls.length, 1);
  });
}
