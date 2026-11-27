import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_RETRY_AFTER_SECONDS, classifyApiFailure, describeGuestCapacity, describeNotConfigured, describeRateLimited } from "../src/components/editor/model";

// SYNTHETIC numbers only: not product policy and not founder values (ADR-0022).
const body = (error: Record<string, unknown>) => ({ error });

test("429 is a rate limit, with the server's own wait; a missing or bad wait is null, never a local default", () => {
  assert.deepEqual(classifyApiFailure(429, body({ code: "COMPOSITION_RATE_LIMITED", retryAfterSeconds: 17 })), { kind: "rate_limited", retryAfterSeconds: 17 });
  assert.deepEqual(classifyApiFailure(429, null), { kind: "rate_limited", retryAfterSeconds: null });
  for (const bad of [0, -3, 1.5, Number.NaN, "9", null, undefined, Number.MAX_SAFE_INTEGER + 1]) assert.equal(classifyApiFailure(429, body({ code: "COMPOSITION_RATE_LIMITED", retryAfterSeconds: bad })).retryAfterSeconds, null, String(bad));
  assert.equal(classifyApiFailure(200, body({ code: "COMPOSITION_RATE_LIMITED", retryAfterSeconds: 4 })).kind, "rate_limited", "the code alone is enough");
});
test("a hostile or buggy wait is clamped to what a browser timer can hold", () => {
  assert.equal(classifyApiFailure(429, body({ retryAfterSeconds: Number.MAX_SAFE_INTEGER })).retryAfterSeconds, MAX_RETRY_AFTER_SECONDS);
  assert.ok(MAX_RETRY_AFTER_SECONDS * 1000 <= 2 ** 31 - 1);
});
test("the closed-capability 503 and the guest cap are told apart from every other failure", () => {
  assert.deepEqual(classifyApiFailure(503, body({ code: "COMPOSITION_LIMITS_NOT_CONFIGURED", retryable: false })), { kind: "not_configured", retryAfterSeconds: null });
  assert.deepEqual(classifyApiFailure(503, body({ code: "COMPOSITION_GUEST_CAPACITY", retryable: true })), { kind: "capacity", retryAfterSeconds: null });
  for (const [status, data] of [[503, body({ code: "COMPOSITION_UNAVAILABLE" })], [500, null], [401, body({ code: "COMPOSITION_AUTH_REQUIRED" })], [409, "text"], [0, undefined], [503, { error: "string" }], [503, { error: null }]] as const)
    assert.equal(classifyApiFailure(status, data).kind, "other", JSON.stringify([status, data]));
});
test("status-line wording takes its number from the server and never invents one", () => {
  assert.match(describeRateLimited(17, "automatic"), /saving will try again in about 17 seconds/);
  assert.match(describeRateLimited(1, "automatic"), /about 1 second\./);
  assert.match(describeRateLimited(null, "automatic"), /Press Save to try again/); assert.doesNotMatch(describeRateLimited(null, "automatic"), /\d|will try again/);
  assert.match(describeRateLimited(null, "manual"), /Try again shortly/);
  assert.match(describeRateLimited(9, "manual"), /Try again in about 9 seconds/); assert.doesNotMatch(describeRateLimited(9, "manual"), /saving will/);
  assert.match(describeNotConfigured("saving"), /not set up yet/); assert.match(describeNotConfigured("artwork upload"), /^Artwork upload is not set up yet/);
  assert.doesNotMatch(describeGuestCapacity(), /\d/);
});
test("the editor never retries in a storm: a 429 pauses autosave and arms one timer, and closed or paused states skip the autosave effect", () => {
  const source = readFileSync(new URL("../src/components/editor/editor.tsx", import.meta.url), "utf8");
  assert.match(source, /autosave: "idle" \| "pending" \| "conflict" \| "failed" \| "unavailable" \| "limited" \| "blocked"/);
  assert.match(source, /server\.autosave === "limited" \|\| server\.autosave === "unavailable" \|\| server\.autosave === "blocked"\) return;/, "the debounced autosave skips paused and closed states");
  assert.equal((source.match(/limitTimer\.current = setTimeout/g) ?? []).length, 1, "exactly one timer is armed per limit");
  assert.doesNotMatch(source, /setInterval/);
  assert.match(source, /const terminal = /, "a terminal 4xx closes the loop (blocked); only 5xx and network errors keep it");
  assert.match(source, /uploaded\.current\.get\(cacheKey\)/, "an upload that succeeded is never repeated by a later save attempt");
  assert.match(source, /classifyApiFailure\(created\.status/); assert.match(source, /classifyApiFailure\(up\.status/); assert.match(source, /classifyApiFailure\(saved\.status/);
});
