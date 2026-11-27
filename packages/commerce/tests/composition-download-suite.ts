/**
 * ADR-0022 C6 conformance: short-lived, principal-bound, single-use download grants, driven through the real service and HTTP
 * handlers. ONE scenario list, run against the in-memory port (composition.test.ts) and the PostgreSQL store (composition-pg.test.ts,
 * `db-integration`, same single 4-client pool). The scan port is a SYNTHETIC double (ruling QC: no scanner is chosen). Every
 * number is a SYNTHETIC_* fixture; none is policy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { CompositionAccess } from "@vynvori/contracts/composition-port";
import { compositionService, secretHash, type CompositionConfig } from "../src/composition";
import type { CompositionAssetStorage } from "../src/composition-storage";
import { compositionCookies, compositionHttpHandlers, type CompositionIdentityPort } from "../src/composition-http";
import { memoryStorage, png } from "./composition-fixtures";
import type { StoreHarness } from "./composition-store-suite";
import {
  SYNTHETIC_COMPOSITION_CONFIG, SYNTHETIC_DOWNLOAD_GRANT_TTL_MS, SYNTHETIC_HTTP_LIMITS, SYNTHETIC_RATE_LIMIT, SYNTHETIC_RATE_LIMIT_WINDOW_SECONDS, syntheticRatePolicies,
  syntheticScanPort, syntheticScanAnswer,
} from "./composition-synthetic";

const ORIGIN = "https://staging.vynvori.test", CSRF = "c".repeat(43);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** The uniform not-found error, without its per-request correlation id. */
const NOT_FOUND = { code: "COMPOSITION_NOT_FOUND", message: "The requested composition was not found.", retryable: false };

export function downloadConformance(label: string, factory: () => Promise<StoreHarness>, options: { skip?: boolean } = {}) {
  const t = (name: string, fn: () => Promise<void>) => test(`${label}: ${name}`, { skip: options.skip ?? false }, fn);

  async function build(over: { config?: Partial<CompositionConfig>; storage?: null } = {}) {
    const h = await factory(), objects = memoryStorage();
    // A storage wrapper whose next read can be made to fail or to return other bytes, to prove a storage fault never burns a grant.
    const fault = { next: null as null | "throw" | "corrupt" };
    const storage: CompositionAssetStorage = {
      put: (key, bytes, mime, hash) => objects.put(key, bytes, mime, hash),
      async get(key, hash, size) {
        const mode = fault.next; fault.next = null;
        if (mode === "throw") throw new Error("injected storage failure");
        const bytes = await objects.get(key, hash, size);
        return mode === "corrupt" ? Uint8Array.from(bytes, (b, i) => (i === bytes.length - 1 ? b ^ 1 : b)) : bytes;
      },
    };
    let offsetMs = 0;
    const clock = () => new Date(Date.now() + offsetMs);
    const config: CompositionConfig = { ...SYNTHETIC_COMPOSITION_CONFIG, uploadsEnabled: true, scanPort: syntheticScanPort(), ...over.config };
    const service = compositionService(h.store, over.storage === null ? null : storage, config, clock);
    // Assets are created through a second service that always has storage, so the no-storage case still has a clean asset to ask for.
    const setup = over.storage === null ? compositionService(h.store, storage, config, clock) : service;
    const users = new Map<string, string>();
    const identity: CompositionIdentityPort = {
      async verify(secret) { const userId = users.get(secret); if (!userId) throw new Error("no session"); return { userId }; },
      async claimGuest(secret, draftId) { await h.m1bClaim(draftId, users.get(secret)!); },
    };
    const http = compositionHttpHandlers({ enabled: true, appOrigin: ORIGIN, ...SYNTHETIC_HTTP_LIMITS }, service, identity);
    const guest = async () => {
      const created = await setup.createGuest();
      return { id: created.record.id, capability: created.capability, access: { kind: "guest", capabilityHash: secretHash(created.capability) } as CompositionAccess, cookie: `${compositionCookies.guest}=${created.record.id}.${created.capability}` };
    };
    /** A guest composition with one stored asset: scanned `clean` by the synthetic double, left `pending`, or `quarantined`. */
    const guestAsset = async (salt = 1, verdict: "clean" | "infected" | "pending" = "clean") => {
      const g = await guest(), bytes = png(64, 64, salt), asset = await setup.uploadAsset(g.id, g.access, bytes, "image/png");
      if (verdict !== "pending") {
        const scanner = compositionService(h.store, storage, { ...config, scanPort: syntheticScanPort(r => syntheticScanAnswer(verdict, r)) }, clock);
        assert.equal(await scanner.scanAsset(g.id, asset.id, g.access, bytes), verdict === "clean" ? "clean" : "quarantined");
      }
      return { ...g, bytes, asset };
    };
    /** A verified owner with a session secret, an owned composition and one clean asset. */
    const ownerAsset = async (salt = 2) => {
      const userId = await h.newUser(), session = randomUUID().replaceAll("-", "").padEnd(43, "o");
      users.set(session, userId);
      const access: CompositionAccess = { kind: "owner", userId }, record = await setup.createOwned(userId), bytes = png(64, 64, salt);
      const asset = await setup.uploadAsset(record.id, access, bytes, "image/png");
      assert.equal(await setup.scanAsset(record.id, asset.id, access, bytes), "clean");
      return { id: record.id, userId, session, access, bytes, asset, cookie: `${compositionCookies.session}=${session}; ${compositionCookies.csrf}=${CSRF}` };
    };
    return { h, store: h.store, service, http, users, guest, guestAsset, ownerAsset, fault, advance(ms: number) { offsetMs += ms; } };
  }
  type Ctx = Awaited<ReturnType<typeof build>>;
  const mintRequest = (cookie: string | null, init: { body?: string; headers?: Record<string, string> } = {}) => new Request(`${ORIGIN}/x`, {
    method: "POST", body: init.body ?? null,
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...(cookie?.includes(compositionCookies.csrf) ? { "x-vynvori-csrf": CSRF } : {}), ...init.headers },
  });
  const redeemRequest = (cookie: string | null, path: string, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${path}`, { headers: { "sec-fetch-site": "same-origin", ...(cookie ? { cookie } : {}), ...headers } });
  /** Mint through HTTP and return the parsed answer (asserting 201). */
  async function mint(ctx: Ctx, who: { id: string; cookie: string }, assetId: string) {
    const response = await ctx.http.mintDownloadGrant(mintRequest(who.cookie), { id: who.id, assetId });
    assert.equal(response.status, 201, await response.clone().text());
    const body = await response.json() as { downloadUrl: string; expiresAt: string };
    const url = new URL(body.downloadUrl, ORIGIN);
    return { ...body, path: `${url.pathname}${url.search}`, token: url.searchParams.get("grant")! };
  }
  const redeem = (ctx: Ctx, who: { cookie: string | null }, id: string, assetId: string, path: string, headers?: Record<string, string>) =>
    ctx.http.downloadAsset(redeemRequest(who.cookie, path, headers), { id, assetId });
  /** Assert the uniform 404 body, and that it never carries the token. */
  async function uniform404(response: Response, token: string, why: string) {
    assert.equal(response.status, 404, why);
    const text = await response.text();
    assert.equal(text.includes(token), false, `${why}: the token is never echoed`);
    const { correlationId, ...error } = JSON.parse(text).error;
    assert.deepEqual(error, NOT_FOUND, why); assert.match(correlationId, /^[0-9a-f-]{36}$/);
  }
  const stillSpendable = async (ctx: Ctx, g: { id: string; access: CompositionAccess }, assetId: string, token: string) =>
    assert.ok(await ctx.store.validateDownloadGrant(g.id, assetId, g.access, new Date(), secretHash(token)), "the grant is still spendable");

  // ---- happy paths
  for (const who of ["guest", "owner"] as const) {
    t(`${who}: mint returns a same-origin download URL and the TTL expiry; redeem returns the unchanged original once, with download headers`, async () => {
      const ctx = await build(), w = who === "guest" ? await ctx.guestAsset() : await ctx.ownerAsset(), before = Date.now();
      const minted = await mint(ctx, w, w.asset.id);
      assert.deepEqual(Object.keys(minted).sort(), ["downloadUrl", "expiresAt", "path", "token"]);
      assert.match(minted.downloadUrl, new RegExp(`^/api/v1/compositions/${w.id}/assets/${w.asset.id}/download\\?grant=[A-Za-z0-9_-]{43}$`));
      const expires = Date.parse(minted.expiresAt);
      assert.ok(expires >= before + SYNTHETIC_DOWNLOAD_GRANT_TTL_MS - 1000 && expires <= Date.now() + SYNTHETIC_DOWNLOAD_GRANT_TTL_MS, "expiry = issue time + configured TTL");
      if (/^[0-9a-f]{64}$/.test(minted.token)) assert.fail("a token is not a hash");
      assert.equal(await ctx.store.validateDownloadGrant(w.id, w.asset.id, w.access, new Date(), sha256(Buffer.from("x"))), null);
      await stillSpendable(ctx, w, w.asset.id, minted.token); // only the SHA-256 of the token is the stored key
      const response = await redeem(ctx, w, w.id, w.asset.id, minted.path);
      assert.equal(response.status, 200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.deepEqual(Buffer.from(bytes), Buffer.from(w.bytes), "the unchanged original");
      assert.equal(sha256(bytes), w.asset.sha256);
      assert.equal(response.headers.get("content-type"), "image/png");
      assert.equal(response.headers.get("content-length"), String(w.bytes.byteLength));
      assert.equal(response.headers.get("content-disposition"), `attachment; filename="original-${w.asset.sha256.slice(0, 12)}.png"`);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
      await uniform404(await redeem(ctx, w, w.id, w.asset.id, minted.path), minted.token, "a second redeem (single use)");
      const again = await mint(ctx, w, w.asset.id); // re-mintable
      assert.notEqual(again.token, minted.token);
      assert.equal((await redeem(ctx, w, w.id, w.asset.id, again.path)).status, 200);
    });
  }

  // ---- every authenticated-but-not-entitled redeem gets the identical NOT_FOUND
  t("expired, unknown, malformed, repeated or missing tokens, and the wrong asset, all get the identical 404", async () => {
    const ctx = await build(), g = await ctx.guestAsset(), otherBytes = png(64, 64, 42);
    const other = await ctx.service.uploadAsset(g.id, g.access, otherBytes, "image/png");
    assert.equal(await ctx.service.scanAsset(g.id, other.id, g.access, otherBytes), "clean");
    const minted = await mint(ctx, g, g.asset.id), base = `/api/v1/compositions/${g.id}/assets/${g.asset.id}/download`;
    const cases: [string, string, string][] = [
      ["unknown token", g.asset.id, `${base}?grant=${"A".repeat(43)}`],
      ["malformed token", g.asset.id, `${base}?grant=${minted.token.slice(1)}`],
      ["token with a padding byte", g.asset.id, `${base}?grant=${minted.token}=`],
      ["repeated grant parameter", g.asset.id, `${base}?grant=${minted.token}&grant=${minted.token}`],
      ["missing grant parameter", g.asset.id, base],
      ["another asset of the same composition", other.id, `/api/v1/compositions/${g.id}/assets/${other.id}/download?grant=${minted.token}`],
      ["a malformed asset id", "not-a-uuid", `/api/v1/compositions/${g.id}/assets/not-a-uuid/download?grant=${minted.token}`],
    ];
    for (const [why, assetId, path] of cases) await uniform404(await redeem(ctx, g, g.id, assetId, path), minted.token, why);
    await stillSpendable(ctx, g, g.asset.id, minted.token);
    ctx.advance(SYNTHETIC_DOWNLOAD_GRANT_TTL_MS + 1000);
    await uniform404(await redeem(ctx, g, g.id, g.asset.id, minted.path), minted.token, "an expired grant");
  });
  t("a different valid principal presenting a leaked token gets 404 and leaves the grant unspent; the rightful owner still redeems", async () => {
    const ctx = await build(), a = await ctx.ownerAsset(3), b = await ctx.ownerAsset(4), g = await ctx.guestAsset(5);
    const minted = await mint(ctx, a, a.asset.id);
    await uniform404(await redeem(ctx, b, a.id, a.asset.id, minted.path), minted.token, "another signed-in user");
    await uniform404(await redeem(ctx, b, b.id, a.asset.id, `/api/v1/compositions/${b.id}/assets/${a.asset.id}/download?grant=${minted.token}`), minted.token, "the token replayed on the other user's own composition");
    const wrongDraft = await redeem(ctx, g, a.id, a.asset.id, minted.path); // a guest cookie names its own draft id
    assert.equal(wrongDraft.status, 401); assert.equal((await wrongDraft.text()).includes(minted.token), false);
    await stillSpendable(ctx, a, a.asset.id, minted.token);
    assert.equal((await redeem(ctx, a, a.id, a.asset.id, minted.path)).status, 200);
  });
  t("a claimed guest: the old capability gets 404, and the new owner cannot spend the guest's grant (a different principal)", async () => {
    const ctx = await build(), g = await ctx.guestAsset(6), minted = await mint(ctx, g, g.asset.id), userId = await ctx.h.newUser();
    await ctx.h.m1bClaim(g.id, userId); await ctx.service.claim(g.id, userId, g.capability);
    await uniform404(await redeem(ctx, g, g.id, g.asset.id, minted.path), minted.token, "the claimed capability");
    const session = "n".repeat(43); ctx.users.set(session, userId);
    const owner = { cookie: `${compositionCookies.session}=${session}` };
    await uniform404(await redeem(ctx, owner, g.id, g.asset.id, minted.path), minted.token, "the new owner presenting the guest's token");
    const own = await ctx.http.mintDownloadGrant(mintRequest(`${owner.cookie}; ${compositionCookies.csrf}=${CSRF}`), { id: g.id, assetId: g.asset.id });
    assert.equal(own.status, 201, "the new owner mints a grant of their own");
    assert.equal((await redeem(ctx, owner, g.id, g.asset.id, (await own.json()).downloadUrl)).status, 200);
  });
  t("an expired guest draft gets 404 on mint and on redeem", async () => {
    const ctx = await build(), g = await ctx.guestAsset(7), minted = await mint(ctx, g, g.asset.id);
    await ctx.h.expireGuest(g.id);
    await uniform404(await redeem(ctx, g, g.id, g.asset.id, minted.path), minted.token, "expired capability, redeem");
    assert.equal((await ctx.http.mintDownloadGrant(mintRequest(g.cookie), { id: g.id, assetId: g.asset.id })).status, 404);
  });

  // ---- clean only (D5)
  t("mint needs a clean asset: pending and quarantined answer 409 ASSET_NOT_AVAILABLE to the owner, a foreign asset the uniform 404", async () => {
    const ctx = await build(), pending = await ctx.guestAsset(8, "pending"), quarantined = await ctx.guestAsset(9, "infected"), clean = await ctx.guestAsset(10);
    for (const [why, w] of [["pending", pending], ["quarantined", quarantined]] as const) {
      const response = await ctx.http.mintDownloadGrant(mintRequest(w.cookie), { id: w.id, assetId: w.asset.id });
      assert.equal(response.status, 409, why); assert.equal((await response.json()).error.code, "COMPOSITION_ASSET_NOT_AVAILABLE");
    }
    const foreign = await ctx.http.mintDownloadGrant(mintRequest(pending.cookie), { id: pending.id, assetId: clean.asset.id });
    const absent = await ctx.http.mintDownloadGrant(mintRequest(pending.cookie), { id: pending.id, assetId: randomUUID() });
    assert.equal(foreign.status, 404); assert.equal(absent.status, 404);
    assert.deepEqual({ ...(await foreign.json()).error, correlationId: null }, { ...(await absent.json()).error, correlationId: null }, "another draft's clean asset is indistinguishable from an absent one");
  });
  t("a grant minted while clean is refused (404) once the asset is quarantined, and minting is then refused too", async () => {
    const ctx = await build(), g = await ctx.guestAsset(11), minted = await mint(ctx, g, g.asset.id);
    await ctx.h.lateQuarantine(g.id, g.asset.id);
    await uniform404(await redeem(ctx, g, g.id, g.asset.id, minted.path), minted.token, "quarantined after mint");
    assert.equal((await ctx.http.mintDownloadGrant(mintRequest(g.cookie), { id: g.id, assetId: g.asset.id })).status, 409);
  });

  // ---- request context: unauthenticated, prefetch, cross-site
  t("unauthenticated redeem is 401 before any lookup; a speculative (prefetch/prerender) request is 404 and never spends the grant; cross-site is 403", async () => {
    const ctx = await build(), g = await ctx.guestAsset(12), minted = await mint(ctx, g, g.asset.id);
    const anonymous = await redeem(ctx, { cookie: null }, g.id, g.asset.id, minted.path);
    assert.equal(anonymous.status, 401); assert.equal((await anonymous.json()).error.code, "COMPOSITION_AUTH_REQUIRED");
    assert.equal((await redeem(ctx, { cookie: `${compositionCookies.session}=${"x".repeat(43)}` }, g.id, g.asset.id, minted.path)).status, 401, "an invalid session is never downgraded");
    for (const headers of [{ "sec-purpose": "prefetch" }, { "sec-purpose": "prefetch;prerender" }, { purpose: "prefetch" }, { "x-moz": "prefetch" }]) {
      await uniform404(await redeem(ctx, g, g.id, g.asset.id, minted.path, headers), minted.token, JSON.stringify(headers));
    }
    for (const site of ["cross-site", "same-site"]) {
      const response = await redeem(ctx, g, g.id, g.asset.id, minted.path, { "sec-fetch-site": site });
      assert.equal(response.status, 403, site); assert.equal((await response.text()).includes(minted.token), false);
    }
    await stillSpendable(ctx, g, g.asset.id, minted.token);
    assert.equal((await redeem(ctx, g, g.id, g.asset.id, minted.path, { "sec-fetch-site": "none" })).status, 200, "a typed or pasted URL (no initiator) still works for its owner");
  });

  // ---- storage faults never burn a grant
  t("a storage failure, or bytes that do not match the asset row, answer 503 STORAGE_UNAVAILABLE and leave the grant spendable", async () => {
    const ctx = await build(), g = await ctx.guestAsset(13), minted = await mint(ctx, g, g.asset.id);
    for (const mode of ["throw", "corrupt"] as const) {
      ctx.fault.next = mode;
      const response = await redeem(ctx, g, g.id, g.asset.id, minted.path);
      assert.equal(response.status, 503, mode); const text = await response.text();
      assert.equal(JSON.parse(text).error.code, "COMPOSITION_STORAGE_UNAVAILABLE"); assert.equal(text.includes(minted.token), false);
      await stillSpendable(ctx, g, g.asset.id, minted.token);
    }
    assert.equal((await redeem(ctx, g, g.id, g.asset.id, minted.path)).status, 200);
  });

  // ---- concurrency: one winner
  t("concurrent redeems of one grant have exactly one winner", async () => {
    const ctx = await build(), g = await ctx.guestAsset(14), minted = await mint(ctx, g, g.asset.id);
    const statuses = (await Promise.all(Array.from({ length: 4 }, () => redeem(ctx, g, g.id, g.asset.id, minted.path)))).map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 404, 404, 404]);
  });

  // ---- mint: order, configuration, limits, body, CSRF
  t("mint closes without a grant TTL (503 LIMITS_NOT_CONFIGURED) or storage (503 DOWNLOAD_UNAVAILABLE), only after access; callers without access create no bucket row", async () => {
    for (const [over, codeName] of [[{ config: { downloadGrantTtlMs: undefined } }, "COMPOSITION_LIMITS_NOT_CONFIGURED"], [{ storage: null }, "COMPOSITION_DOWNLOAD_UNAVAILABLE"]] as const) {
      const ctx = await build(over), g = await ctx.guestAsset(21), stranger = await ctx.guest(), rows = await ctx.h.bucketCount();
      const forged = `${compositionCookies.guest}=${g.id}.${stranger.capability}`;
      assert.equal((await ctx.http.mintDownloadGrant(mintRequest(forged), { id: g.id, assetId: g.asset.id })).status, 404, codeName);
      assert.equal((await ctx.http.mintDownloadGrant(mintRequest(null), { id: g.id, assetId: g.asset.id })).status, 401, codeName);
      assert.equal(await ctx.h.bucketCount(), rows, "no bucket row for callers without access");
      const closed = await ctx.http.mintDownloadGrant(mintRequest(g.cookie), { id: g.id, assetId: g.asset.id });
      assert.equal(closed.status, 503); assert.equal((await closed.json()).error.code, codeName);
      assert.equal(await ctx.h.bucketCount(), rows, "nothing is charged while the capability is closed");
    }
  });
  t("redeem without storage answers 503 DOWNLOAD_UNAVAILABLE only to a caller with access, and spends nothing", async () => {
    const ctx = await build({ storage: null }), g = await ctx.guestAsset(22), stranger = await ctx.guest(), token = "B".repeat(43);
    const path = `/api/v1/compositions/${g.id}/assets/${g.asset.id}/download?grant=${token}`;
    await uniform404(await redeem(ctx, { cookie: `${compositionCookies.guest}=${g.id}.${stranger.capability}` }, g.id, g.asset.id, path), token, "a forged capability");
    const closed = await redeem(ctx, g, g.id, g.asset.id, path);
    assert.equal(closed.status, 503); assert.equal((await closed.json()).error.code, "COMPOSITION_DOWNLOAD_UNAVAILABLE");
  });
  for (const who of ["guest", "owner"] as const) {
    const operation = who === "guest" ? "GUEST_DOWNLOAD_GRANT" : "OWNER_DOWNLOAD_GRANT";
    t(`${who}: mint is limited by ${operation} (429 with Retry-After), refuses any body (413) after charging, and an unset policy closes it`, async () => {
      const ctx = await build({ config: { rate: syntheticRatePolicies({ [operation]: { windowSeconds: SYNTHETIC_RATE_LIMIT_WINDOW_SECONDS, max: SYNTHETIC_RATE_LIMIT } }) } });
      const w = who === "guest" ? await ctx.guestAsset(15) : await ctx.ownerAsset(16);
      const withBody = await ctx.http.mintDownloadGrant(mintRequest(w.cookie, { body: JSON.stringify({ expiresAt: "2999-01-01T00:00:00Z" }), headers: { "content-type": "application/json" } }), { id: w.id, assetId: w.asset.id });
      assert.equal(withBody.status, 413, "no client-chosen expiry or anything else");
      for (let i = 1; i < SYNTHETIC_RATE_LIMIT; i += 1) await mint(ctx, w, w.asset.id);
      const limited = await ctx.http.mintDownloadGrant(mintRequest(w.cookie), { id: w.id, assetId: w.asset.id });
      assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      assert.equal((await limited.json()).error.code, "COMPOSITION_RATE_LIMITED");
      const { [operation]: _dropped, ...rest } = syntheticRatePolicies();
      const closedCtx = await build({ config: { rate: rest } }), c = who === "guest" ? await closedCtx.guestAsset(17) : await closedCtx.ownerAsset(18);
      const closed = await closedCtx.http.mintDownloadGrant(mintRequest(c.cookie), { id: c.id, assetId: c.asset.id });
      assert.equal(closed.status, 503); assert.equal((await closed.json()).error.code, "COMPOSITION_LIMITS_NOT_CONFIGURED");
    });
  }
  t("mint is a guarded mutation: a wrong origin or cross-site is 403, and a session without the CSRF double submit is 403", async () => {
    const ctx = await build(), g = await ctx.guestAsset(19), o = await ctx.ownerAsset(20);
    for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }]) assert.equal((await ctx.http.mintDownloadGrant(mintRequest(g.cookie, { headers }), { id: g.id, assetId: g.asset.id })).status, 403);
    const noCsrf = new Request(`${ORIGIN}/x`, { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${compositionCookies.session}=${o.session}` } });
    assert.equal((await ctx.http.mintDownloadGrant(noCsrf, { id: o.id, assetId: o.asset.id })).status, 403);
  });
}
