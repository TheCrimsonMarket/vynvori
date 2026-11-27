/**
 * ADR-0022 C5 unit and static tests for the scan boundary: the strict result parser, the bounded call, the unconfigured default
 * port, the typed scan limits, and the static separation of scanner-side calls from user-side code (C3b hard gate).
 * Every number is a SYNTHETIC_* fixture.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactScanRequest } from "@vynvori/contracts/composition-port";
import { isScanPortConfigured, parseScanResult, runScan, ScannerNotConfiguredError, unconfiguredScanPort } from "../src/composition-scan";
import { parseCompositionLimits, resolveScanLimits, TIMER_STRUCTURAL_CEILING_MS } from "../src/composition-limits";
import { syntheticLimitEnv, syntheticScanAnswer, syntheticScanPort } from "./composition-synthetic";

const here = new URL(".", import.meta.url).pathname;
const repo = join(here, "..", "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : /\.(ts|tsx)$/.test(name) ? [path] : []; });
const SHA = "a".repeat(64);
const request: ArtifactScanRequest = Object.freeze({ assetId: "00000000-0000-4000-8000-000000000001", sha256: SHA, byteSize: 4, mime: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) });
const parse = (raw: unknown) => parseScanResult(raw, request, "synthetic-scanner");
/** SYNTHETIC timeouts for the bounded-call tests. */
const SYNTHETIC_FAST_TIMEOUT_MS = 30, SYNTHETIC_SLOW_ANSWER_MS = 300;

test("parser: only a complete clean/infected answer for the same hash is clean/quarantined; the scanner id is always the port's", () => {
  assert.deepEqual(parse(syntheticScanAnswer("clean", request)), { toStatus: "clean", scannerId: "synthetic-scanner", engineVersion: "synthetic-engine-0", definitionsVersion: "synthetic-defs-0", evidenceRef: "evidence://synthetic/clean" });
  assert.equal(parse(syntheticScanAnswer("infected", request)).toStatus, "quarantined");
  assert.equal(parse(Object.assign(Object.create(null), syntheticScanAnswer("clean", request))).toStatus, "clean", "a null-prototype object is plain data");
  const unknown = (reasonCode: string) => ({ toStatus: "unknown", reasonCode, scannerId: "synthetic-scanner" });
  const cases: [string, unknown, string][] = [
    ["error verdict", syntheticScanAnswer("error", request), "scanner_error"],
    ["null", null, "scan_result_malformed"], ["string", "clean", "scan_result_malformed"], ["array", [syntheticScanAnswer("clean", request)], "scan_result_malformed"],
    ["upper-case verdict", syntheticScanAnswer("clean", request, { verdict: "CLEAN" }), "scan_result_malformed"],
    ["boolean verdict", syntheticScanAnswer("clean", request, { verdict: true }), "scan_result_malformed"],
    ["extra key", { ...syntheticScanAnswer("clean", request), scannerId: "spoofed" }, "scan_result_malformed"],
    ["missing key", (({ scannedAt: _s, ...rest }) => rest)(syntheticScanAnswer("clean", request)), "scan_result_malformed"],
    ["upper-case hash", syntheticScanAnswer("clean", request, { sha256: SHA.toUpperCase() }), "scan_result_malformed"],
    ["short hash", syntheticScanAnswer("clean", request, { sha256: "a".repeat(63) }), "scan_result_malformed"],
    ["other hash", syntheticScanAnswer("clean", request, { sha256: "b".repeat(64) }), "scan_hash_mismatch"],
    ["empty engine", syntheticScanAnswer("clean", request, { engineVersion: "" }), "scan_result_malformed"],
    ["padded definitions", syntheticScanAnswer("clean", request, { definitionsVersion: " d " }), "scan_result_malformed"],
    ["oversized evidence", syntheticScanAnswer("clean", request, { evidenceRef: "e".repeat(513) }), "scan_result_malformed"],
    ["numeric evidence", syntheticScanAnswer("clean", request, { evidenceRef: 7 }), "scan_result_malformed"],
    ["loose date", syntheticScanAnswer("clean", request, { scannedAt: "yesterday" }), "scan_result_malformed"],
    ["date without offset", syntheticScanAnswer("clean", request, { scannedAt: "2026-01-01T00:00:00" }), "scan_result_malformed"],
    ["impossible date", syntheticScanAnswer("clean", request, { scannedAt: "2026-13-45T99:99:99Z" }), "scan_result_malformed"],
    ["class instance", Object.assign(new (class Result {})(), syntheticScanAnswer("clean", request)), "scan_result_malformed"],
  ];
  for (const [name, raw, reason] of cases) assert.deepEqual(parse(raw), unknown(reason), name);
  const symbolKey = { ...syntheticScanAnswer("clean", request), [Symbol("x")]: 1 };
  assert.deepEqual(parse(symbolKey), unknown("scan_result_malformed"), "symbol keys count as extra keys");
  let touched = false;
  const getter = { ...syntheticScanAnswer("clean", request) } as Record<string, unknown>;
  Object.defineProperty(getter, "verdict", { enumerable: true, get() { touched = true; return "clean"; } });
  assert.deepEqual(parse(getter), unknown("scan_result_malformed"), "an accessor is refused"); assert.equal(touched, false, "and never invoked");
});

test("runScan: one call; a throw, the unconfigured port and a timeout are unknown; the signal is aborted and a late answer is ignored", async () => {
  const port = syntheticScanPort();
  assert.equal((await runScan(port, request, SYNTHETIC_SLOW_ANSWER_MS)).toStatus, "clean"); assert.equal(port.calls.length, 1);
  assert.deepEqual(await runScan(syntheticScanPort(() => { throw new Error("boom"); }), request, SYNTHETIC_SLOW_ANSWER_MS), { toStatus: "unknown", reasonCode: "scanner_threw", scannerId: "synthetic-scanner" });
  assert.deepEqual(await runScan(unconfiguredScanPort, request, SYNTHETIC_SLOW_ANSWER_MS), { toStatus: "unknown", reasonCode: "scanner_not_configured", scannerId: "unconfigured" });
  let aborted = false;
  const slow = syntheticScanPort((r, signal) => new Promise(resolve => { signal.addEventListener("abort", () => { aborted = true; }); setTimeout(() => resolve(syntheticScanAnswer("clean", r)), SYNTHETIC_SLOW_ANSWER_MS); }));
  const started = Date.now(), result = await runScan(slow, request, SYNTHETIC_FAST_TIMEOUT_MS);
  assert.deepEqual(result, { toStatus: "unknown", reasonCode: "scan_timeout", scannerId: "synthetic-scanner" });
  assert.ok(Date.now() - started < SYNTHETIC_SLOW_ANSWER_MS, "the timeout does not wait for the port"); assert.equal(aborted, true);
  const synchronous = syntheticScanPort(); // a port that answers synchronously-shaped values still goes through the parser
  assert.equal((await runScan({ scannerId: synchronous.scannerId, scan: (() => syntheticScanAnswer("infected", request)) as never }, request, SYNTHETIC_SLOW_ANSWER_MS)).toStatus, "quarantined");
});

test("unconfiguredScanPort: never clean, always rejects with SCANNER_NOT_CONFIGURED, and is not a configured port", async () => {
  await assert.rejects(unconfiguredScanPort.scan(request, new AbortController().signal), ScannerNotConfiguredError);
  assert.equal(isScanPortConfigured(unconfiguredScanPort), false);
  assert.equal(isScanPortConfigured({ ...unconfiguredScanPort }), false, "a copy under the same id is not a scanner either");
  assert.equal(isScanPortConfigured(undefined), false); assert.equal(isScanPortConfigured(null), false);
  assert.equal(isScanPortConfigured({ scannerId: "", scan: async () => ({}) as never }), false);
  assert.equal(isScanPortConfigured({ scannerId: " padded ", scan: async () => ({}) as never }), false);
  assert.equal(isScanPortConfigured(syntheticScanPort()), true);
  assert.ok(Object.isFrozen(unconfiguredScanPort));
});

test("scan limits: both keys required, lease strictly longer than the timeout, timeout within a JavaScript timer; never defaulted", () => {
  const env = (timeout: string | undefined, lease: string | undefined) => ({ ...syntheticLimitEnv(), M3_LIMIT_SCAN_TIMEOUT_SECONDS: timeout, M3_LIMIT_SCAN_LEASE_SECONDS: lease });
  // SYNTHETIC values, not policy.
  assert.deepEqual(resolveScanLimits(parseCompositionLimits(env("7", "11"))), { timeoutMs: 7000, leaseMs: 11000 });
  for (const [timeout, lease] of [[undefined, "11"], ["7", undefined], ["7", "7"], ["11", "7"], ["0", "11"], ["7", "-1"]] as const) assert.equal(resolveScanLimits(parseCompositionLimits(env(timeout, lease))), null, `${timeout}/${lease}`);
  const tooLong = String(Math.floor(TIMER_STRUCTURAL_CEILING_MS / 1000) + 1);
  assert.equal(resolveScanLimits(parseCompositionLimits(env(tooLong, String(Number(tooLong) + 1)))), null, "a timeout a timer cannot hold is invalid, not zero");
  assert.equal(TIMER_STRUCTURAL_CEILING_MS, 2147483647);
});

test("static (C3b hard gate): scanner-side store calls are reachable only from the service scan path, never from the HTTP boundary or the web app", () => {
  const scannerSide = /\b(completeScanAttempt|expireScanAttempt|recordLateDetection)\b/;
  const files = [...walk(join(repo, "packages/commerce/src")), ...walk(join(repo, "apps/web/src"))];
  const users = files.filter(file => scannerSide.test(readFileSync(file, "utf8"))).map(file => file.slice(repo.length + 1));
  assert.deepEqual(users, ["packages/commerce/src/composition.ts"], "only the service's scan path names these store methods");
  const service = readFileSync(join(repo, "packages/commerce/src/composition.ts"), "utf8");
  assert.doesNotMatch(service, /recordLateDetection/, "late detection has no caller until a chosen scanner defines its trigger");
  // every completion's result comes from runScan, i.e. from the port, inside the scan path
  const completions = service.split("\n").filter(line => line.includes("completeScanAttempt("));
  assert.equal(completions.length, 1); assert.match(completions[0]!, /\{ attemptId, result \}\)/, "the recorded result is the runScan result");
  assert.match(service, /const result = await runScan\(port,/);
  const httpBoundary = readFileSync(join(repo, "packages/commerce/src/composition-http.ts"), "utf8");
  for (const name of ["openScanAttempt", "requestRescan", "runScan", "parseScanResult", "verdict", "evidenceRef", "scannerId", "toStatus"]) assert.equal(httpBoundary.includes(name), false, `composition-http.ts must not name ${name}`);
});

test("static (ruling QC): no scanner is chosen: the only ArtifactScanPort implementation in src is unconfiguredScanPort, and the scan module imports only contract types", () => {
  const roots = ["packages/commerce/src", "packages/db/src", "packages/shared/src", "apps/web/src", "services/image-processing/src"].map(dir => join(repo, dir));
  const implementers = roots.flatMap(walk).filter(file => { const text = readFileSync(file, "utf8"); return /\bscannerId\s*:/.test(text) && /\bscan\s*(\(|:)/.test(text); }).map(file => file.slice(repo.length + 1));
  assert.deepEqual(implementers, ["packages/commerce/src/composition-scan.ts"]);
  const scan = readFileSync(join(repo, "packages/commerce/src/composition-scan.ts"), "utf8");
  assert.deepEqual([...scan.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map(m => m[1]), ["@vynvori/contracts/composition-port"]);
  assert.match(scan, /^import "server-only";/);
  assert.doesNotMatch(scan, /\bfetch\(|child_process|node:net|node:http|require\(/, "the boundary makes no network or process call");
});
