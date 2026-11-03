import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { compositionHttpHandlers, compositionCookies, type CompositionIdentityPort } from "../src/composition-http";
import { compositionService } from "../src/composition";
import { SYNTHETIC_COMPOSITION_CONFIG, SYNTHETIC_HTTP_LIMITS, SYNTHETIC_GUEST_TTL_SECONDS } from "./composition-synthetic";
import { memoryHarness } from "./composition-suite";
import { memoryStorage, png, sceneWith, textLayer } from "./composition-fixtures";

const ORIGIN = "https://staging.vynvori.test", CSRF = "c".repeat(43), SESSION = "s".repeat(43);
function setup(enabled = true, uploads = true) {
  const h = memoryHarness(), storage = memoryStorage();
  const service = compositionService(h.store, storage, { ...SYNTHETIC_COMPOSITION_CONFIG, uploadsEnabled: uploads });
  const users = new Map<string, string>([[SESSION, randomUUID()]]), claims: string[] = [];
  const identity: CompositionIdentityPort = {
    async verify(secret) { const userId = users.get(secret); if (!userId) throw new Error("no session"); return { userId }; },
    async claimGuest(secret, draftId) { const userId = users.get(secret)!; claims.push(draftId); await h.m1bClaim(draftId, userId); },
  };
  const http = compositionHttpHandlers({ enabled, appOrigin: ORIGIN, ...SYNTHETIC_HTTP_LIMITS }, enabled ? service : undefined, enabled ? identity : undefined);
  return { http, users, claims, h };
}
const req = (path: string, init: { method?: string; cookie?: string; body?: unknown; raw?: Uint8Array; type?: string; headers?: Record<string, string> } = {}) => new Request(ORIGIN + path, {
  method: init.method ?? "GET", body: init.raw ? Buffer.from(init.raw) : init.body === undefined ? null : JSON.stringify(init.body),
  headers: { ...(init.method && init.method !== "GET" ? { origin: ORIGIN, "sec-fetch-site": "same-origin" } : {}), ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.type ? { "content-type": init.type } : {}), ...(init.cookie ? { cookie: init.cookie } : {}), ...init.headers },
});
const guestCookie = (response: Response) => response.headers.get("set-cookie")!.split(";")[0]!;

test("disabled by default: every route answers 503 and touches nothing", async () => {
  const { http } = setup(false);
  for (const response of [await http.create(req("/api/v1/compositions", { method: "POST" })), await http.get(req("/x"), { id: randomUUID() }), await http.list(req("/x"))]) assert.equal(response.status, 503);
});
test("guest create sets an HttpOnly Strict __Host- capability cookie and never returns the capability in JSON", async () => {
  const { http } = setup();
  const response = await http.create(req("/api/v1/compositions", { method: "POST" })); assert.equal(response.status, 201);
  const cookie = response.headers.get("set-cookie")!; assert.match(cookie, new RegExp(`^__Host-vynvori_guest=[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SYNTHETIC_GUEST_TTL_SECONDS}$`));
  const text = await response.text(), capability = cookie.split("=")[1]!.split(".")[1]!.split(";")[0]!;
  assert.equal(text.includes(capability), false); assert.equal(response.headers.get("cache-control")?.includes("no-store"), true);
  assert.equal(JSON.parse(text).draft.ownerKind, "guest_capability");
});
test("mutations require same-origin; session callers also need the M1b CSRF double submit", async () => {
  const { http } = setup();
  const noOrigin = await http.create(new Request(ORIGIN + "/api/v1/compositions", { method: "POST" })); assert.equal(noOrigin.status, 403);
  const cross = await http.create(req("/api/v1/compositions", { method: "POST", headers: { origin: "https://evil.example" } })); assert.equal(cross.status, 403);
  const crossSite = await http.create(req("/api/v1/compositions", { method: "POST", headers: { "sec-fetch-site": "cross-site" } })); assert.equal(crossSite.status, 403);
  const noCsrf = await http.create(req("/api/v1/compositions", { method: "POST", cookie: `${compositionCookies.session}=${SESSION}` })); assert.equal(noCsrf.status, 403);
  const ok = await http.create(req("/api/v1/compositions", { method: "POST", cookie: `${compositionCookies.session}=${SESSION}; ${compositionCookies.csrf}=${CSRF}`, headers: { "x-vynvori-csrf": CSRF } })); assert.equal(ok.status, 201);
  assert.equal((await ok.json()).draft.ownerKind, "authenticated_owner");
});
test("guest journey: save, reload identical geometry, freeze, review binding, restore", async () => {
  const { http } = setup();
  const created = await http.create(req("/api/v1/compositions", { method: "POST" })), cookie = guestCookie(created), id = (await created.json()).draft.compositionId as string;
  const scene = sceneWith([textLayer("t", { xMm: 12.3456, widthMm: 99.9999 })]);
  const saved = await http.save(req(`/api/v1/compositions/${id}`, { method: "POST", cookie, body: { expectedRevision: 0, scene } }), { id }); assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  const reload = await (await http.get(req(`/api/v1/compositions/${id}`, { cookie }), { id })).json();
  assert.deepEqual(reload.scene, savedBody.scene ?? reload.scene); assert.equal(reload.sceneHashSha256, savedBody.sceneHashSha256);
  assert.equal(reload.scene.pages.find((p: any) => p.zoneId === "front").layers[0].xMm, 12.346); // eslint-disable-line @typescript-eslint/no-explicit-any
  const stale = await http.save(req(`/api/v1/compositions/${id}`, { method: "POST", cookie, body: { expectedRevision: 0, scene } }), { id });
  assert.equal(stale.status, 409); assert.equal((await stale.json()).error.currentRevision, 1);
  const frozen = await http.freeze(req(`/api/v1/compositions/${id}/versions`, { method: "POST", cookie, body: { expectedRevision: 1 } }), { id }); assert.equal(frozen.status, 201);
  const versionId = (await frozen.json()).version.versionId as string;
  const review = await (await http.review(req("/x", { cookie }), { id, versionId })).json();
  assert.equal(review.review.screenId, "ED-03"); assert.equal(review.review.identity.compositionVersionId, versionId);
  assert.equal(review.review.validation.sourceCompositionVersionId, versionId); assert.equal(review.review.cartQuote, null); assert.equal(review.review.displayedProof, null);
  assert.notEqual(review.review.validation.state, "passed_pending_human_qa");
  const restored = await http.restore(req(`/api/v1/compositions/${id}/restore`, { method: "POST", cookie, body: { expectedRevision: 1, versionId } }), { id }); assert.equal(restored.status, 200);
});
test("rights: no cookie, forged cookie, another draft's cookie, bad ids and extra fields all fail closed", async () => {
  const { http } = setup();
  const a = await http.create(req("/api/v1/compositions", { method: "POST" })), b = await http.create(req("/api/v1/compositions", { method: "POST" }));
  const aId = (await a.json()).draft.compositionId as string, bCookie = guestCookie(b);
  assert.equal((await http.get(req("/x"), { id: aId })).status, 401);
  assert.equal((await http.get(req("/x", { cookie: bCookie }), { id: aId })).status, 401);
  assert.equal((await http.get(req("/x", { cookie: `${compositionCookies.guest}=${aId}.${"z".repeat(43)}` }), { id: aId })).status, 404);
  assert.equal((await http.get(req("/x", { cookie: bCookie }), { id: "../../etc" })).status, 404);
  assert.equal((await http.get(req("/x", { cookie: `${compositionCookies.session}=${"q".repeat(43)}` }), { id: aId })).status, 401); // present-but-invalid session never downgrades
  const created = await http.create(req("/api/v1/compositions", { method: "POST" })), cookie = guestCookie(created), id = (await created.json()).draft.compositionId as string;
  assert.equal((await http.save(req("/x", { method: "POST", cookie, body: { expectedRevision: 0, scene: sceneWith(), owner: "evil" } }), { id })).status, 400);
  assert.equal((await http.save(req("/x", { method: "POST", cookie, body: { expectedRevision: -1, scene: sceneWith() } }), { id })).status, 400);
  assert.equal((await http.save(req("/x", { method: "POST", cookie, type: "text/plain", raw: Buffer.from("{}") }), { id })).status, 400);
  assert.equal((await http.list(req("/x", { cookie }))).status, 401); // listing is owner-only
});
test("uploads: closed unless enabled; hostile bytes rejected; reads stream with private no-sniff headers", async () => {
  const closed = setup(true, false);
  const c = await closed.http.create(req("/api/v1/compositions", { method: "POST" })), cid = (await c.json()).draft.compositionId as string;
  assert.equal((await closed.http.uploadAsset(req("/x", { method: "POST", cookie: guestCookie(c), raw: png(), type: "image/png" }), { id: cid })).status, 503);
  const { http } = setup();
  const created = await http.create(req("/api/v1/compositions", { method: "POST" })), cookie = guestCookie(created), id = (await created.json()).draft.compositionId as string;
  assert.equal((await http.uploadAsset(req("/x", { method: "POST", cookie, raw: Buffer.from("<svg onload=alert(1)/>"), type: "image/svg+xml" }), { id })).status, 415);
  const big = await http.uploadAsset(new Request(ORIGIN + "/x", { method: "POST", headers: { origin: ORIGIN, cookie, "content-type": "image/png", "content-length": String(30 * 1024 * 1024) }, body: Buffer.alloc(8) }), { id }); assert.equal(big.status, 413);
  const up = await http.uploadAsset(req("/x", { method: "POST", cookie, raw: png(50, 50), type: "image/png" }), { id }); assert.equal(up.status, 201);
  const assetId = (await up.json()).asset.assetId as string;
  const read = await http.readAsset(req("/x", { cookie }), { id, assetId }); assert.equal(read.status, 200);
  assert.equal(read.headers.get("content-type"), "image/png"); assert.equal(read.headers.get("x-content-type-options"), "nosniff");
  assert.match(read.headers.get("content-security-policy")!, /sandbox/); assert.match(read.headers.get("cache-control")!, /no-store/); assert.equal(read.headers.get("cross-origin-resource-policy"), "same-origin");
  const other = await http.create(req("/api/v1/compositions", { method: "POST" }));
  assert.equal((await http.readAsset(req("/x", { cookie: guestCookie(other) }), { id, assetId })).status, 401);
});
test("claim: needs session + CSRF + the guest cookie for that draft; clears the capability and hands over ownership", async () => {
  const { http, claims, users } = setup();
  const created = await http.create(req("/api/v1/compositions", { method: "POST" })), guest = guestCookie(created), id = (await created.json()).draft.compositionId as string;
  const withSession = `${guest}; ${compositionCookies.session}=${SESSION}; ${compositionCookies.csrf}=${CSRF}`;
  assert.equal((await http.claim(req("/x", { method: "POST", cookie: guest }), { id })).status, 401); // no session
  assert.equal((await http.claim(req("/x", { method: "POST", cookie: withSession }), { id })).status, 403); // no CSRF
  const done = await http.claim(req("/x", { method: "POST", cookie: withSession, headers: { "x-vynvori-csrf": CSRF } }), { id });
  assert.equal(done.status, 200); assert.deepEqual(claims, [id]); assert.match(done.headers.get("set-cookie")!, /Max-Age=0/);
  const owner = (await done.json()); assert.equal(owner.draft.ownerKind, "authenticated_owner");
  assert.equal((await http.get(req("/x", { cookie: guest }), { id })).status, 404); // the old capability is dead
  assert.equal((await http.get(req("/x", { cookie: `${compositionCookies.session}=${SESSION}` }), { id })).status, 200);
  const stranger = "t".repeat(43); users.set(stranger, randomUUID());
  assert.equal((await http.get(req("/x", { cookie: `${compositionCookies.session}=${stranger}` }), { id })).status, 404);
});
