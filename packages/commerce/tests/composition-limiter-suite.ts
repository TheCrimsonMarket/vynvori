/**
 * ADR-0022 C4 conformance: rate limits, the live-guest cap and the authorize-before-read order, driven through the real service and
 * HTTP handlers. ONE scenario list, run against the in-memory port (composition.test.ts) and the PostgreSQL store
 * (composition-pg.test.ts, `db-integration`). Every number here is a SYNTHETIC_* fixture; none is policy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { CompositionAccess, CompositionStore } from "@vynvori/contracts/composition-port";
import { compositionService, CompositionError, secretHash } from "../src/composition";
import { compositionCookies, compositionHttpHandlers, type CompositionIdentityPort } from "../src/composition-http";
import { RATE_LIMITED_OPERATIONS, type RateLimitedOperation, type RatePolicies } from "../src/composition-limits";
import { memoryStorage, png, sceneWith, textLayer } from "./composition-fixtures";
import type { StoreHarness } from "./composition-store-suite";
import {
  SYNTHETIC_COMPOSITION_CONFIG, SYNTHETIC_HTTP_LIMITS, SYNTHETIC_LIVE_CAP, SYNTHETIC_RATE_LIMIT, SYNTHETIC_RATE_LIMIT_WINDOW_SECONDS, syntheticRatePolicies,
} from "./composition-synthetic";

const ORIGIN = "https://staging.vynvori.test", CSRF = "c".repeat(43), SESSION = "s".repeat(43), OTHER_SESSION = "t".repeat(43);
const L = SYNTHETIC_RATE_LIMIT, W = SYNTHETIC_RATE_LIMIT_WINDOW_SECONDS;
const rateLimited = (e: unknown) => e instanceof CompositionError && e.code === "RATE_LIMITED";

/** A throwing body stream: if a handler ever reads it, `state.read` flips and the stream errors. Proves "the body is never read". */
function spiedBody() {
  const state = { read: false };
  const body = new ReadableStream({ pull() { state.read = true; throw new Error("the request body must not be read"); } }, { highWaterMark: 0 });
  return { body, state };
}

export function limiterConformance(label: string, factory: () => Promise<StoreHarness>, options: { skip?: boolean } = {}) {
  const t = (name: string, fn: () => Promise<void>) => test(`${label}: ${name}`, { skip: options.skip ?? false }, fn);

  type Config = Partial<typeof SYNTHETIC_COMPOSITION_CONFIG>;
  /** Wires service + HTTP over a spied store. `at` pins the rate window (and the service clock) for rollover tests. */
  async function build(over: { rate?: RatePolicies; at?: () => Date; uploads?: boolean; config?: Config; http?: Partial<typeof SYNTHETIC_HTTP_LIMITS> } = {}) {
    const h = await factory(), calls: { operation: string; subject: string }[] = [];
    const store: CompositionStore = {
      ...h.store,
      async consumeRateToken(input) { calls.push({ operation: input.operation, subject: input.subject }); return h.store.consumeRateToken(over.at ? { ...input, at: over.at() } : input); },
    };
    const config = { ...SYNTHETIC_COMPOSITION_CONFIG, uploadsEnabled: over.uploads ?? true, rate: over.rate ?? syntheticRatePolicies(), ...over.config };
    const service = compositionService(store, memoryStorage(), config, over.at);
    const users = new Map<string, string>(), claims: string[] = [];
    const identity: CompositionIdentityPort = {
      async verify(secret) { const userId = users.get(secret); if (!userId) throw new Error("no session"); return { userId }; },
      async claimGuest(secret, draftId) { claims.push(draftId); await h.m1bClaim(draftId, users.get(secret)!); },
    };
    const http = compositionHttpHandlers({ enabled: true, appOrigin: ORIGIN, ...SYNTHETIC_HTTP_LIMITS, ...over.http }, service, identity);
    const newGuest = async () => {
      const created = await service.createGuest();
      return { id: created.record.id, capability: created.capability, access: { kind: "guest", capabilityHash: secretHash(created.capability) } as CompositionAccess, cookie: `${compositionCookies.guest}=${created.record.id}.${created.capability}` };
    };
    const newOwner = async (secret = SESSION) => {
      const userId = await h.newUser(); users.set(secret, userId);
      const record = await service.createOwned(userId); // the service call is not charged: only the HTTP route admits first
      return { userId, id: record.id, access: { kind: "owner", userId } as CompositionAccess, cookie: `${compositionCookies.session}=${secret}; ${compositionCookies.csrf}=${CSRF}` };
    };
    return { h, calls, service, http, users, claims, newGuest, newOwner };
  }
  type Ctx = Awaited<ReturnType<typeof build>>;
  const post = (cookie: string | null, init: { json?: unknown; raw?: Uint8Array; type?: string; csrf?: boolean; stream?: ReturnType<typeof spiedBody> } = {}) => {
    const headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}) };
    if (init.csrf) headers["x-vynvori-csrf"] = CSRF;
    if (init.json !== undefined) headers["content-type"] = "application/json";
    if (init.type) headers["content-type"] = init.type;
    const body = init.stream ? init.stream.body : init.raw ? Buffer.from(init.raw) : init.json !== undefined ? JSON.stringify(init.json) : null;
    return new Request(`${ORIGIN}/x`, { method: "POST", headers, body, ...(init.stream ? { duplex: "half" } : {}) } as RequestInit);
  };
  const errorOf = async (response: Response) => (await response.json() as { error: { code: string; retryable: boolean; retryAfterSeconds?: number } }).error;

  // ---- every one of the ten operations is limited at exactly SYNTHETIC_RATE_LIMIT
  type Actor = { id: string; access: CompositionAccess };
  const CASES: readonly { operation: RateLimitedOperation; who: "guest" | "owner" | "none"; act: (ctx: Ctx, who: Actor) => Promise<unknown> }[] = [
    { operation: "GUEST_CREATE_GLOBAL", who: "none", act: ctx => ctx.service.createGuest() },
    { operation: "ASSET_UPLOAD_GLOBAL", who: "guest", act: (ctx, w) => ctx.service.admit("assetUpload", w.id, w.access) },
    { operation: "GUEST_WRITE", who: "guest", act: (ctx, w) => ctx.service.admit("write", w.id, w.access) },
    { operation: "GUEST_ASSET_UPLOAD", who: "guest", act: (ctx, w) => ctx.service.admit("assetUpload", w.id, w.access) },
    { operation: "GUEST_DOWNLOAD_GRANT", who: "guest", act: (ctx, w) => ctx.service.admit("downloadGrant", w.id, w.access) },
    { operation: "GUEST_RESCAN", who: "guest", act: (ctx, w) => ctx.service.admit("rescan", w.id, w.access) },
    { operation: "OWNER_WRITE", who: "owner", act: (ctx, w) => ctx.service.admit("write", w.id, w.access) },
    { operation: "OWNER_ASSET_UPLOAD", who: "owner", act: (ctx, w) => ctx.service.admit("assetUpload", w.id, w.access) },
    { operation: "OWNER_DOWNLOAD_GRANT", who: "owner", act: (ctx, w) => ctx.service.admit("downloadGrant", w.id, w.access) },
    { operation: "OWNER_RESCAN", who: "owner", act: (ctx, w) => ctx.service.admit("rescan", w.id, w.access) },
  ];
  t("the case table covers exactly the ten D1 operations", async () => { assert.deepEqual(CASES.map(c => c.operation).sort(), [...RATE_LIMITED_OPERATIONS].sort()); });
  for (const { operation, who, act } of CASES) {
    t(`${operation}: exactly SYNTHETIC_RATE_LIMIT admissions per window, then RATE_LIMITED with a bounded wait; other operations stay open`, async () => {
      // Only this operation is tight. Set-up charges only GUEST_CREATE_GLOBAL (creating a guest), which is tight only in the case that needs no actor.
      const ctx = await build({ rate: syntheticRatePolicies({ [operation]: { windowSeconds: W, max: L } }) });
      const actor: Actor = who === "guest" ? await ctx.newGuest() : who === "owner" ? await ctx.newOwner() : { id: "", access: null as never };
      for (let i = 0; i < L; i += 1) await act(ctx, actor);
      await assert.rejects(act(ctx, actor), (e: unknown) => rateLimited(e) && /^[1-9][0-9]*$/.test((e as CompositionError).detail ?? "") && Number((e as CompositionError).detail) <= W);
      // exhausting this operation never limits a different one
      const other = operation.startsWith("OWNER") ? await ctx.newGuest() : await ctx.newOwner(OTHER_SESSION);
      await ctx.service.admit("write", other.id, other.access);
    });
  }

  t("per-subject buckets are independent: two guests, and two owners, never share a count", async () => {
    const ctx = await build({ rate: syntheticRatePolicies({ GUEST_WRITE: { windowSeconds: W, max: L }, OWNER_WRITE: { windowSeconds: W, max: L } }) });
    const a = await ctx.newGuest(), b = await ctx.newGuest(), x = await ctx.newOwner(SESSION), y = await ctx.newOwner(OTHER_SESSION);
    for (const who of [a, x]) for (let i = 0; i < L; i += 1) await ctx.service.admit("write", who.id, who.access);
    await assert.rejects(ctx.service.admit("write", a.id, a.access), rateLimited);
    await assert.rejects(ctx.service.admit("write", x.id, x.access), rateLimited);
    for (const who of [b, y]) for (let i = 0; i < L; i += 1) await ctx.service.admit("write", who.id, who.access); // untouched by a's and x's exhaustion
    const keys = new Set(ctx.calls.map(c => `${c.operation}:${c.subject}`));
    assert.ok(keys.has(`GUEST_WRITE:${a.id}`) && keys.has(`GUEST_WRITE:${b.id}`) && keys.has(`OWNER_WRITE:${x.userId}`) && keys.has(`OWNER_WRITE:${y.userId}`), "keys are the capability's composition id and the verified user id");
  });

  t("the global upload bucket is shared across compositions, is charged after the per-subject one, and a limited subject never spends it", async () => {
    const ctx = await build({ rate: syntheticRatePolicies({ ASSET_UPLOAD_GLOBAL: { windowSeconds: W, max: L }, GUEST_ASSET_UPLOAD: { windowSeconds: W, max: L - 1 } }) });
    const a = await ctx.newGuest(), b = await ctx.newGuest(), c = await ctx.newGuest();
    for (let i = 0; i < L - 1; i += 1) await ctx.service.admit("assetUpload", a.id, a.access); // a: its own L-1 of L-1; global L-1 of L
    const globalBefore = ctx.calls.filter(x => x.operation === "ASSET_UPLOAD_GLOBAL").length;
    await assert.rejects(ctx.service.admit("assetUpload", a.id, a.access), rateLimited);
    assert.equal(ctx.calls.filter(x => x.operation === "ASSET_UPLOAD_GLOBAL").length, globalBefore, "a caller limited on its own bucket never touches the shared bucket");
    await ctx.service.admit("assetUpload", b.id, b.access); // global L of L
    await assert.rejects(ctx.service.admit("assetUpload", c.id, c.access), rateLimited); // a different guest is stopped by the shared bucket
  });

  // ---- authorize before charge before body: invalid subjects create no bucket row and the body is never read
  t("upload: no, malformed, unknown, foreign, expired, claimed and wrong-owner credentials get 401/404, create no bucket row and never read the body", async () => {
    const ctx = await build(), victim = await ctx.newGuest(), stranger = await ctx.newGuest(), owner = await ctx.newOwner(SESSION), outsider = await ctx.newOwner(OTHER_SESSION);
    const expired = await ctx.newGuest(), claimed = await ctx.newGuest();
    await ctx.h.expireGuest(expired.id); await ctx.h.m1bClaim(claimed.id, await ctx.h.newUser());
    const rowsBefore = await ctx.h.bucketCount(), callsBefore = ctx.calls.length; // set-up guests were charged to the global create bucket only
    const attempts: [string, string, string | null, number][] = [
      ["no credentials", victim.id, null, 401],
      ["malformed guest cookie", victim.id, `${compositionCookies.guest}=${victim.id}.short`, 401],
      ["a well-formed but unknown capability", victim.id, `${compositionCookies.guest}=${victim.id}.${"z".repeat(43)}`, 404],
      ["another draft's capability under this draft's id", victim.id, `${compositionCookies.guest}=${victim.id}.${stranger.capability}`, 404],
      ["an expired guest draft", expired.id, expired.cookie, 404],
      ["a claimed guest draft", claimed.id, claimed.cookie, 404],
      ["an owner session for somebody else's composition", victim.id, outsider.cookie, 404],
      ["an owner session for a guest draft", victim.id, owner.cookie, 404],
      ["an invalid session", victim.id, `${compositionCookies.session}=${"q".repeat(43)}; ${compositionCookies.csrf}=${CSRF}`, 401],
      ["a malformed composition id", "../../etc", victim.cookie, 404],
    ];
    for (const [name, id, cookie, expected] of attempts) {
      const stream = spiedBody(), response = await ctx.http.uploadAsset(post(cookie, { type: "image/png", csrf: true, stream }), { id });
      assert.equal(response.status, expected, name); assert.equal(stream.state.read, false, `${name}: the body must never be read`);
    }
    assert.equal(await ctx.h.bucketCount(), rowsBefore, "no bucket row was created for any of them"); assert.equal(ctx.calls.length, callsBefore, "the limiter was never consulted");
    const ok = await ctx.http.uploadAsset(post(victim.cookie, { raw: png(50, 50), type: "image/png" }), { id: victim.id }); assert.equal(ok.status, 201);
    assert.deepEqual(ctx.calls.slice(callsBefore).map(c => c.operation), ["GUEST_ASSET_UPLOAD", "ASSET_UPLOAD_GLOBAL"], "per-subject first, then the shared bucket");
  });

  t("save, freeze, restore: the same order (access, then charge, then body) for guests and owners", async () => {
    const ctx = await build(), guest = await ctx.newGuest(), owner = await ctx.newOwner();
    const bogusGuest = `${compositionCookies.guest}=${guest.id}.${"z".repeat(43)}`, wrongOwner = (await ctx.newOwner(OTHER_SESSION)).cookie;
    const rows = await ctx.h.bucketCount(), calls = ctx.calls.length;
    for (const route of ["save", "freeze", "restore"] as const) for (const [cookie, id] of [[bogusGuest, guest.id], [wrongOwner, owner.id], [wrongOwner, guest.id]] as const) {
      const stream = spiedBody(), response = await ctx.http[route](post(cookie, { type: "application/json", csrf: true, stream }), { id });
      assert.ok(response.status === 404 || response.status === 401, `${route} ${response.status}`); assert.equal(stream.state.read, false, `${route}: body never read`);
    }
    assert.equal(await ctx.h.bucketCount(), rows); assert.equal(ctx.calls.length, calls);
  });

  t("an authorised but limited caller gets 429 with Retry-After in the header and the body, and the body is never read", async () => {
    const ctx = await build({ rate: syntheticRatePolicies({ GUEST_WRITE: { windowSeconds: W, max: L }, OWNER_WRITE: { windowSeconds: W, max: L }, GUEST_ASSET_UPLOAD: { windowSeconds: W, max: L } }) });
    const guest = await ctx.newGuest(), owner = await ctx.newOwner();
    for (const who of [guest, owner]) {
      for (let i = 0; i < L; i += 1) {
        const saved = await ctx.http.save(post(who.cookie, { json: { expectedRevision: i, scene: sceneWith([textLayer("t", { text: `edit ${i}` })]) }, csrf: true }), { id: who.id });
        assert.equal(saved.status, 200, `save ${i}`);
      }
      const stream = spiedBody(), limited = await ctx.http.save(post(who.cookie, { type: "application/json", csrf: true, stream }), { id: who.id });
      assert.equal(limited.status, 429); assert.equal(stream.state.read, false, "the limited request's body was never read");
      const error = await errorOf(limited.clone()), header = limited.headers.get("retry-after");
      assert.match(header ?? "", /^[1-9][0-9]*$/); assert.equal(Number(header), error.retryAfterSeconds); assert.ok((error.retryAfterSeconds ?? W + 1) <= W);
      assert.equal(error.code, "COMPOSITION_RATE_LIMITED"); assert.equal(error.retryable, true);
      assert.match(limited.headers.get("cache-control") ?? "", /no-store/); assert.equal(limited.headers.get("set-cookie"), null);
    }
    for (let i = 0; i < L; i += 1) assert.equal((await ctx.http.uploadAsset(post(guest.cookie, { raw: png(40 + i, 40), type: "image/png" }), { id: guest.id })).status, 201);
    const stream = spiedBody(), limited = await ctx.http.uploadAsset(post(guest.cookie, { type: "image/png", stream }), { id: guest.id });
    assert.equal(limited.status, 429); assert.equal(stream.state.read, false);
  });

  t("guest creation: the global bucket limits it; a refused attempt sets no cookie and creates nothing", async () => {
    const ctx = await build({ rate: syntheticRatePolicies({ GUEST_CREATE_GLOBAL: { windowSeconds: W, max: L } }) });
    const now = new Date(), live = await ctx.h.store.countLiveGuestDrafts(now);
    for (let i = 0; i < L; i += 1) assert.equal((await ctx.http.create(post(null))).status, 201);
    const limited = await ctx.http.create(post(null));
    assert.equal(limited.status, 429); assert.equal(limited.headers.get("set-cookie"), null); assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
    assert.equal(await ctx.h.store.countLiveGuestDrafts(now), live + L);
  });

  t("owner create and claim are charged to the verified user before any body or M1b claim; a limited claim never reaches M1b", async () => {
    const ctx = await build({ rate: syntheticRatePolicies({ OWNER_WRITE: { windowSeconds: W, max: L } }) });
    const owner = await ctx.newOwner(), guest = await ctx.newGuest();
    for (let i = 0; i < L; i += 1) assert.equal((await ctx.http.create(post(owner.cookie, { csrf: true }))).status, 201);
    const stream = spiedBody(), limited = await ctx.http.create(post(owner.cookie, { type: "application/json", csrf: true, stream }));
    assert.equal(limited.status, 429); assert.equal(stream.state.read, false);
    const claim = await ctx.http.claim(post(`${guest.cookie}; ${owner.cookie}`, { csrf: true }), { id: guest.id });
    assert.equal(claim.status, 429); assert.deepEqual(ctx.claims, [], "M1b claimGuest was never called");
    assert.equal((await ctx.http.get(new Request(`${ORIGIN}/x`, { headers: { cookie: guest.cookie } }), { id: guest.id })).status, 200, "the guest draft is untouched");
    const calls = ctx.calls.length;
    assert.equal((await ctx.http.claim(post(guest.cookie, { csrf: true }), { id: guest.id })).status, 401); assert.equal(ctx.calls.length, calls, "an unauthenticated claim charges nobody");
    const second = await ctx.newOwner(OTHER_SESSION);
    assert.equal((await ctx.http.claim(post(`${guest.cookie}; ${second.cookie}`, { csrf: true }), { id: guest.id })).status, 200); assert.deepEqual(ctx.claims, [guest.id]);
  });

  // ---- never unlimited: an unset policy closes exactly that operation, and only after access
  t("an unset rate policy closes only that operation (503 LIMITS_NOT_CONFIGURED), is never unlimited, and charges nothing", async () => {
    const { OWNER_WRITE: _w, ASSET_UPLOAD_GLOBAL: _g, ...rest } = syntheticRatePolicies();
    const ctx = await build({ rate: rest }), guest = await ctx.newGuest(), owner = await ctx.newOwner();
    const calls = ctx.calls.length, rows = await ctx.h.bucketCount();
    const closed = async (response: Response) => { assert.equal(response.status, 503); const e = await errorOf(response); assert.equal(e.code, "COMPOSITION_LIMITS_NOT_CONFIGURED"); assert.equal(e.retryable, false); };
    await closed(await ctx.http.save(post(owner.cookie, { json: { expectedRevision: 0, scene: sceneWith() }, csrf: true }), { id: owner.id }));
    await closed(await ctx.http.create(post(owner.cookie, { csrf: true })));
    await closed(await ctx.http.uploadAsset(post(guest.cookie, { raw: png(50, 50), type: "image/png" }), { id: guest.id }));
    assert.equal(ctx.calls.length, calls, "nothing was charged while closed"); assert.equal(await ctx.h.bucketCount(), rows);
    assert.equal((await ctx.http.save(post(guest.cookie, { json: { expectedRevision: 0, scene: sceneWith() } }), { id: guest.id })).status, 200, "guest writes are a different operation and stay open");
    // a caller WITHOUT access learns nothing about configuration: 404/401, not 503
    const stranger = `${compositionCookies.guest}=${guest.id}.${"z".repeat(43)}`;
    assert.equal((await ctx.http.uploadAsset(post(stranger, { raw: png(50, 50), type: "image/png" }), { id: guest.id })).status, 404);
    assert.equal((await ctx.http.save(post((await ctx.newOwner(OTHER_SESSION)).cookie, { json: { expectedRevision: 0, scene: sceneWith() }, csrf: true }), { id: owner.id })).status, 404);
    // service level: the policy is checked, never defaulted
    await assert.rejects(ctx.service.admit("write", owner.id, owner.access), (e: unknown) => e instanceof CompositionError && e.code === "LIMITS_NOT_CONFIGURED");
    const none = await build({ rate: {} }); await assert.rejects(none.service.createGuest(), (e: unknown) => e instanceof CompositionError && e.code === "LIMITS_NOT_CONFIGURED");
  });

  t("a forged but well-formed credential learns nothing about configuration: access is proven in SQL before any 503", async () => {
    const closed = await build({ http: { maxJsonBytes: undefined }, uploads: false }), guest = await closed.newGuest(), rows = await closed.h.bucketCount();
    const forged = `${compositionCookies.guest}=${guest.id}.${"z".repeat(43)}`, calls = closed.calls.length;
    const scene = { json: { expectedRevision: 0, scene: sceneWith() } };
    assert.equal((await closed.http.save(post(forged, scene), { id: guest.id })).status, 404, "save, JSON limit unset");
    assert.equal((await closed.http.freeze(post(forged, { json: { expectedRevision: 0 } }), { id: guest.id })).status, 404, "freeze, JSON limit unset");
    assert.equal((await closed.http.restore(post(forged, { json: { expectedRevision: 0, versionId: "00000000-0000-4000-8000-000000000000" } }), { id: guest.id })).status, 404, "restore, JSON limit unset");
    assert.equal((await closed.http.uploadAsset(post(forged, { raw: png(50, 50), type: "image/png" }), { id: guest.id })).status, 404, "upload, uploads disabled");
    assert.equal(closed.calls.length, calls, "no bucket was charged for a caller without access"); assert.equal(await closed.h.bucketCount(), rows);
    // the rightful holder still gets the honest answer
    assert.equal((await closed.http.save(post(guest.cookie, scene), { id: guest.id })).status, 503, "save, JSON limit unset, valid caller");
    assert.equal((await closed.http.uploadAsset(post(guest.cookie, { raw: png(50, 50), type: "image/png" }), { id: guest.id })).status, 503, "upload, uploads disabled, valid caller");
  });

  t("an unset live-guest cap closes guest creation, and a zero cap is never read as unlimited", async () => {
    const ctx = await build({ config: { liveGuestDraftsMax: undefined } });
    await assert.rejects(ctx.service.createGuest(), (e: unknown) => e instanceof CompositionError && e.code === "LIMITS_NOT_CONFIGURED");
    assert.equal(ctx.calls.length, 0, "nothing was charged");
    const zero = await build({ config: { liveGuestDraftsMax: 0 } });
    await assert.rejects(zero.service.createGuest(), RangeError);
  });

  // ---- window rollover with explicit timestamps (the database window is pinned through the store call, never through the service)
  t("window rollover: the limit resets in the next window and Retry-After is the time left in this one", async () => {
    const base = Math.floor(Date.UTC(2030, 0, 1) / (W * 1000)) * W * 1000; let clock = new Date(base + 10_000);
    const ctx = await build({ at: () => clock, rate: syntheticRatePolicies({ GUEST_WRITE: { windowSeconds: W, max: L } }) });
    const g = await ctx.newGuest();
    for (let i = 0; i < L; i += 1) await ctx.service.admit("write", g.id, g.access);
    const limited = await ctx.http.save(post(g.cookie, { json: { expectedRevision: 0, scene: sceneWith() } }), { id: g.id });
    assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), String(W - 10), "the wait is the rest of the fixed window");
    clock = new Date(base + W * 1000 + 1_000);
    for (let i = 0; i < L; i += 1) await ctx.service.admit("write", g.id, g.access); // a new window: exactly L again
    await assert.rejects(ctx.service.admit("write", g.id, g.access), rateLimited);
  });

  // ---- live-guest cap through HTTP
  t("live-guest cap: the next guest is refused with 503 GUEST_CAPACITY and no cookie; expiry or a claim frees a slot", async () => {
    const capped = await build({ config: { liveGuestDraftsMax: SYNTHETIC_LIVE_CAP } }), now = new Date(), cap = SYNTHETIC_LIVE_CAP;
    const made = [];
    for (let i = 0; i < SYNTHETIC_LIVE_CAP; i += 1) { const r = await capped.http.create(post(null)); assert.equal(r.status, 201); made.push((await r.json() as { draft: { compositionId: string } }).draft.compositionId); }
    const refused = await capped.http.create(post(null)), e = await errorOf(refused);
    assert.equal(refused.status, 503); assert.equal(e.code, "COMPOSITION_GUEST_CAPACITY"); assert.equal(e.retryable, true); assert.equal(refused.headers.get("set-cookie"), null);
    assert.equal(await capped.h.store.countLiveGuestDrafts(now), cap);
    await capped.h.expireGuest(made[0]!); assert.equal((await capped.http.create(post(null))).status, 201);
    assert.equal((await capped.http.create(post(null))).status, 503);
    await capped.h.m1bClaim(made[1]!, await capped.h.newUser()); assert.equal((await capped.http.create(post(null))).status, 201);
  });

  // ---- quota through the service (the SQL path is also hit directly by the store suite and the race tests)
  t("upload quota: the (max+1)th distinct image is ASSET_QUOTA (409), a duplicate is idempotent, and the same-bytes retry is never charged to the quota", async () => {
    const ctx = await build(), g = await ctx.newGuest();
    const first = await ctx.service.uploadAsset(g.id, g.access, png(30, 30, 1), "image/png");
    for (let i = 2; i <= SYNTHETIC_COMPOSITION_CONFIG.maxAssetsPerComposition!; i += 1) await ctx.service.uploadAsset(g.id, g.access, png(30, 30, i), "image/png");
    await assert.rejects(ctx.service.uploadAsset(g.id, g.access, png(30, 30, 99), "image/png"), (e: unknown) => e instanceof CompositionError && e.code === "ASSET_QUOTA");
    assert.equal((await ctx.service.uploadAsset(g.id, g.access, png(30, 30, 1), "image/png")).id, first.id);
    const response = await ctx.http.uploadAsset(post(g.cookie, { raw: png(30, 30, 98), type: "image/png" }), { id: g.id });
    assert.equal(response.status, 409); assert.equal((await errorOf(response)).code, "COMPOSITION_ASSET_QUOTA");
  });
}
