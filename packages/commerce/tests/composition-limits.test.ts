import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  COMPOSITION_LIMIT_KEYS, IMAGE_BYTES_STRUCTURAL_CEILING, IMAGE_SIDE_STRUCTURAL_CEILING, SECONDS_STRUCTURAL_CEILING, parseCompositionLimits, resolveApiLimits,
  resolveGuestCreateLimits, resolveUploadLimits,
} from "../src/composition-limits";
import { compositionService, CompositionError } from "../src/composition";
import { compositionHttpHandlers, compositionCookies, type CompositionIdentityPort } from "../src/composition-http";
import { memoryHarness } from "./composition-suite";
import { memoryStorage, png } from "./composition-fixtures";
import { SYNTHETIC_COMPOSITION_CONFIG, SYNTHETIC_HTTP_LIMITS, syntheticLimitEnv } from "./composition-synthetic";

const here = new URL(".", import.meta.url).pathname;
const repo = join(here, "..", "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : []; });

test("exactly 31 keys, all M3_LIMIT_*, no VYNVORI_* prefix, no duplicates", () => {
  assert.equal(COMPOSITION_LIMIT_KEYS.length, 31);
  assert.equal(new Set(COMPOSITION_LIMIT_KEYS).size, 31);
  for (const key of COMPOSITION_LIMIT_KEYS) assert.match(key, /^M3_LIMIT_[A-Z][A-Z0-9_]*$/);
});
test("the exported key list equals the keys in the ADR-0022 table", () => {
  const adr = readFileSync(join(repo, "docs/implementation/ADR-0022-M3-Closure-Asset-Access-Scanning-and-Limits.md"), "utf8");
  const documented = [...adr.matchAll(/^\| \d+ \| `(M3_LIMIT_[A-Z0-9_]+)` \|/gm)].map(match => match[1]!);
  assert.deepEqual([...documented].sort(), [...COMPOSITION_LIMIT_KEYS].sort());
});
test(".env.example lists exactly the 31 keys, all commented out and without values", () => {
  const lines = readFileSync(join(repo, ".env.example"), "utf8").split("\n").filter(line => line.includes("M3_LIMIT_"));
  const listed = lines.map(line => /^# (M3_LIMIT_[A-Z0-9_]+)=$/.exec(line)?.[1]);
  assert.ok(listed.every(Boolean), "every M3_LIMIT_ line must be a bare commented assignment with no value");
  assert.deepEqual([...listed].sort(), [...COMPOSITION_LIMIT_KEYS].sort());
});
test("with an empty environment every key is missing and nothing has a default", () => {
  const parsed = parseCompositionLimits({});
  assert.deepEqual([...parsed.missing].sort(), [...COMPOSITION_LIMIT_KEYS].sort());
  assert.deepEqual(parsed.invalid, []); assert.deepEqual(Object.keys(parsed.values), []);
  assert.equal(resolveApiLimits(parsed), null); assert.equal(resolveGuestCreateLimits(parsed), null); assert.equal(resolveUploadLimits(parsed), null);
});
test("a complete synthetic environment parses every key", () => {
  const parsed = parseCompositionLimits(syntheticLimitEnv());
  assert.deepEqual(parsed.missing, []); assert.deepEqual(parsed.invalid, []); assert.equal(Object.keys(parsed.values).length, 31);
  assert.ok(resolveApiLimits(parsed) && resolveGuestCreateLimits(parsed) && resolveUploadLimits(parsed));
});
test("malformed values are invalid, counted as missing for closing, and never echoed", () => {
  const malformed = ["", " 5", "5 ", "05", "0", "-1", "+1", "1.5", "1e3", "1_000", "0x10", "abc", "9007199254740992", "１２"];
  for (const value of malformed) {
    const parsed = parseCompositionLimits({ ...syntheticLimitEnv(), M3_LIMIT_JSON_MAX_BYTES: value });
    assert.ok(parsed.missing.includes("M3_LIMIT_JSON_MAX_BYTES") || parsed.invalid.includes("M3_LIMIT_JSON_MAX_BYTES"), JSON.stringify(value));
    assert.equal(parsed.values.JSON_MAX_BYTES, undefined, JSON.stringify(value));
    assert.equal(resolveApiLimits(parsed), null, JSON.stringify(value));
    assert.ok(!JSON.stringify(parsed).includes("9007199254740992"));
  }
});
test("structural ceilings: image bytes and side above the 0001 CHECK values are invalid, equal values are valid", () => {
  const env = syntheticLimitEnv();
  const over = parseCompositionLimits({ ...env, M3_LIMIT_IMAGE_MAX_BYTES: String(IMAGE_BYTES_STRUCTURAL_CEILING + 1), M3_LIMIT_IMAGE_MAX_SIDE_PX: String(IMAGE_SIDE_STRUCTURAL_CEILING + 1) });
  assert.deepEqual([...over.invalid].sort(), ["M3_LIMIT_IMAGE_MAX_BYTES", "M3_LIMIT_IMAGE_MAX_SIDE_PX"]);
  assert.equal(resolveUploadLimits(over), null);
  const at = parseCompositionLimits({ ...env, M3_LIMIT_IMAGE_MAX_BYTES: String(IMAGE_BYTES_STRUCTURAL_CEILING), M3_LIMIT_IMAGE_MAX_SIDE_PX: String(IMAGE_SIDE_STRUCTURAL_CEILING) });
  assert.deepEqual(at.invalid, []); assert.ok(resolveUploadLimits(at));
});
test("the structural ceilings mirror the 0001 migration CHECKs", () => {
  const sql = readFileSync(join(repo, "packages/db/composition-migrations/0001_composition_scene.sql"), "utf8");
  assert.equal(Number(/byte_size\s+integer NOT NULL CHECK \(byte_size > 0 AND byte_size <= (\d+)\)/.exec(sql)?.[1]), IMAGE_BYTES_STRUCTURAL_CEILING);
  assert.equal(Number(/width_px\s+integer NOT NULL CHECK \(width_px > 0 AND width_px <= (\d+)\)/.exec(sql)?.[1]), IMAGE_SIDE_STRUCTURAL_CEILING);
  assert.equal(Number(/height_px\s+integer NOT NULL CHECK \(height_px > 0 AND height_px <= (\d+)\)/.exec(sql)?.[1]), IMAGE_SIDE_STRUCTURAL_CEILING);
});
test("capabilities close individually: each missing key closes exactly the capabilities that need it", () => {
  const without = (key: string) => { const env = syntheticLimitEnv(); delete env[key]; return parseCompositionLimits(env); };
  assert.equal(resolveApiLimits(without("M3_LIMIT_JSON_MAX_BYTES")), null);
  assert.equal(resolveGuestCreateLimits(without("M3_LIMIT_JSON_MAX_BYTES")), null);
  assert.equal(resolveUploadLimits(without("M3_LIMIT_JSON_MAX_BYTES")), null);
  assert.equal(resolveGuestCreateLimits(without("M3_LIMIT_GUEST_TTL_SECONDS")), null);
  assert.ok(resolveApiLimits(without("M3_LIMIT_GUEST_TTL_SECONDS")) && resolveUploadLimits(without("M3_LIMIT_GUEST_TTL_SECONDS")));
  for (const key of ["IMAGE_MAX_BYTES", "IMAGE_MAX_PIXELS", "IMAGE_MAX_SIDE_PX", "MAX_ASSETS_PER_COMPOSITION", "MAX_BYTES_PER_COMPOSITION"])
    { assert.equal(resolveUploadLimits(without(`M3_LIMIT_${key}`)), null, key); assert.ok(resolveGuestCreateLimits(without(`M3_LIMIT_${key}`)), key); }
  // keys consumed by later steps never close today's capabilities
  assert.ok(resolveUploadLimits(without("M3_LIMIT_RATE_OWNER_WRITE_MAX")) && resolveGuestCreateLimits(without("M3_LIMIT_SCAN_TIMEOUT_SECONDS")));
});

test("static: no removed policy literal and no defaultCompositionConfig remains in commerce or web src", () => {
  const banned = [/24\s*\*\s*3600/, /25\s*\*\s*1024\s*\*\s*1024/, /36_?000_?000/, /\b20_000\b/, /150\s*\*\s*1024/, /256\s*\*\s*1024/, /25 MB/, /24[ -]hours?/i, /defaultCompositionConfig/, /LOCAL_LIMIT/];
  const files = [...walk(join(repo, "packages/commerce/src")), ...walk(join(repo, "apps/web/src"))];
  assert.ok(files.length > 20);
  for (const file of files) { const text = readFileSync(file, "utf8"); for (const pattern of banned) assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`); }
});

// ---- capability closure over the service and HTTP boundary
const ORIGIN = "https://staging.vynvori.test", SESSION = "s".repeat(43);
function http(limits: Partial<typeof SYNTHETIC_HTTP_LIMITS>, serviceConfig = SYNTHETIC_COMPOSITION_CONFIG) {
  const h = memoryHarness(), service = compositionService(h.store, memoryStorage(), { ...serviceConfig, uploadsEnabled: true });
  const identity: CompositionIdentityPort = { async verify() { return { userId: randomUUID() }; }, async claimGuest() {} };
  return compositionHttpHandlers({ enabled: true, appOrigin: ORIGIN, ...SYNTHETIC_HTTP_LIMITS, ...limits }, service, identity);
}
const post = (path = "/api/v1/compositions", extra: Record<string, string> = {}) => new Request(ORIGIN + path, { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", ...extra } });
const get = (cookie?: string) => new Request(ORIGIN + "/x", { headers: cookie ? { cookie } : {} });
async function assertClosed(response: Response) {
  assert.equal(response.status, 503);
  const body = await response.json() as { error: { code: string; retryable: boolean } };
  assert.equal(body.error.code, "COMPOSITION_LIMITS_NOT_CONFIGURED"); assert.equal(body.error.retryable, false);
  assert.equal(response.headers.get("set-cookie"), null);
}
test("*_SECONDS values above the Date-range bound are invalid (an expiry must stay a valid Date)", () => {
  const over = parseCompositionLimits({ ...syntheticLimitEnv(), M3_LIMIT_GUEST_TTL_SECONDS: String(SECONDS_STRUCTURAL_CEILING + 1) });
  assert.deepEqual(over.invalid, ["M3_LIMIT_GUEST_TTL_SECONDS"]); assert.equal(resolveGuestCreateLimits(over), null);
  assert.ok(resolveGuestCreateLimits(parseCompositionLimits({ ...syntheticLimitEnv(), M3_LIMIT_GUEST_TTL_SECONDS: String(SECONDS_STRUCTURAL_CEILING) })));
});
test("HTTP: unset JSON limit closes the API for authenticated callers; unauthenticated and cross-origin callers still get 401/403", async () => {
  const closed = http({ maxJsonBytes: undefined }), session = `${compositionCookies.session}=${SESSION}`;
  await assertClosed(await closed.create(post()));
  await assertClosed(await closed.list(get(session)));
  assert.equal((await closed.get(get(), { id: randomUUID() })).status, 401);
  assert.equal((await closed.list(get())).status, 401);
  assert.equal((await closed.create(new Request(ORIGIN + "/x", { method: "POST", headers: { origin: "https://evil.test" } }))).status, 403);
});
test("HTTP: with uploads off the flag answer comes before the configuration answer", async () => {
  const h = memoryHarness(), storage = memoryStorage(), identity: CompositionIdentityPort = { async verify() { return { userId: randomUUID() }; }, async claimGuest() {} };
  const service = compositionService(h.store, storage, { ...SYNTHETIC_COMPOSITION_CONFIG, uploadsEnabled: false });
  const open = compositionHttpHandlers({ enabled: true, appOrigin: ORIGIN, ...SYNTHETIC_HTTP_LIMITS }, service, identity);
  const closed = compositionHttpHandlers({ enabled: true, appOrigin: ORIGIN, ...SYNTHETIC_HTTP_LIMITS, maxJsonBytes: undefined, maxUploadBytes: undefined }, service, identity);
  const created = await open.create(post()), cookie = created.headers.get("set-cookie")!.split(";")[0]!, id = (await created.json() as { draft: { compositionId: string } }).draft.compositionId;
  const response = await closed.uploadAsset(new Request(ORIGIN + "/x", { method: "POST", headers: { origin: ORIGIN, cookie, "content-type": "image/png" }, body: Buffer.alloc(8) }), { id });
  assert.equal(response.status, 503); assert.equal((await response.json() as { error: { code: string } }).error.code, "COMPOSITION_UPLOADS_DISABLED");
});
test("HTTP: unset guest TTL refuses guest creation with no cookie, while other routes stay open", async () => {
  const closed = http({ guestTtlSeconds: undefined });
  await assertClosed(await closed.create(post()));
  assert.notEqual((await closed.list(get())).status, 503, "list is a normal 401, not a configuration failure");
});
test("HTTP: unset upload body limit refuses uploads before the body is read", async () => {
  const open = http({}), created = await open.create(post());
  const cookie = created.headers.get("set-cookie")!.split(";")[0]!, id = (await created.json() as { draft: { compositionId: string } }).draft.compositionId;
  const closed = http({ maxUploadBytes: undefined });
  const recreated = await closed.create(post()); assert.equal(recreated.status, 201);
  const cookie2 = recreated.headers.get("set-cookie")!.split(";")[0]!, id2 = (await recreated.json() as { draft: { compositionId: string } }).draft.compositionId;
  let bodyRead = false;
  const request = new Request(ORIGIN + "/x", { method: "POST", headers: { origin: ORIGIN, cookie: cookie2, "content-type": "image/png" }, body: new ReadableStream({ pull(controller) { bodyRead = true; controller.close(); } }, { highWaterMark: 0 }), duplex: "half" } as RequestInit);
  await assertClosed(await closed.uploadAsset(request, { id: id2 })); assert.equal(bodyRead, false);
  void cookie; void id; void compositionCookies; void SESSION;
});
test("service: unset TTL, image, asset or byte quota keys each answer LIMITS_NOT_CONFIGURED and never succeed", async () => {
  const code = (promise: Promise<unknown>, expected: CompositionError["code"]) => assert.rejects(promise, (error: unknown) => error instanceof CompositionError && error.code === expected);
  const make = (over: Partial<typeof SYNTHETIC_COMPOSITION_CONFIG>, uploads = true) => compositionService(memoryHarness().store, memoryStorage(), { ...SYNTHETIC_COMPOSITION_CONFIG, ...over, uploadsEnabled: uploads });
  await code(make({ guestTtlMs: undefined }).createGuest(), "LIMITS_NOT_CONFIGURED");
  for (const over of [{ imageLimits: undefined }, { maxAssetsPerComposition: undefined }, { maxBytesPerComposition: undefined }])
    await code(make(over).uploadAsset(randomUUID(), { kind: "guest", capabilityHash: "x" }, png(), "image/png"), "LIMITS_NOT_CONFIGURED");
  await code(make({ imageLimits: undefined }, false).uploadAsset(randomUUID(), { kind: "guest", capabilityHash: "x" }, png(), "image/png"), "UPLOADS_DISABLED");
});
