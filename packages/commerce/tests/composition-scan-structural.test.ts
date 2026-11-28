/**
 * M3-F2b: the interim stage-1 structural adapter behind ArtifactScanPort. It is NOT malware scanning, and these tests pin the honesty
 * of what it records. Every number is a SYNTHETIC fixture, not policy. The service-level scenarios (upload, rescan, serve, grant) live
 * in composition-scan-suite.ts so they also run against PostgreSQL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactScanRequest } from "@vynvori/contracts/composition-port";
import { isScanPortConfigured, runScan } from "../src/composition-scan";
import { STRUCTURAL_SCANNER_ID, structuralInspectScanPort } from "../src/composition-scan-structural";
import { jpeg, png, sha256, webp } from "./composition-fixtures";

const repo = join(new URL(".", import.meta.url).pathname, "..", "..", "..");
/** SYNTHETIC limits, not policy. */
const LIMITS = Object.freeze({ maxBytes: 4096, maxPixels: 10_000, maxSide: 200 });
const TIMEOUT_MS = 2000; // SYNTHETIC
const port = structuralInspectScanPort(LIMITS);
const requestFor = (bytes: Uint8Array, mime = "image/png"): ArtifactScanRequest => Object.freeze({ assetId: "00000000-0000-4000-8000-000000000001", sha256: sha256(bytes), byteSize: bytes.byteLength, mime, bytes });

test("the port names itself honestly and is a configured, frozen port", () => {
  assert.equal(port.scannerId, "structural-inspect"); assert.equal(STRUCTURAL_SCANNER_ID, "structural-inspect");
  assert.ok(Object.isFrozen(port)); assert.equal(isScanPortConfigured(port), true);
  assert.doesNotMatch(JSON.stringify([port.scannerId, STRUCTURAL_SCANNER_ID]), /virus|malware|clam|antivirus|av\b/i, "never labelled as a malware scanner");
});

test("a valid PNG, JPEG and WebP pass as clean, with evidence that says structural inspection and no definitions", async () => {
  for (const [bytes, mime] of [[png(64, 64, 3), "image/png"], [jpeg(32, 32), "image/jpeg"], [webp(32, 32), "image/webp"]] as const) {
    const result = await runScan(port, requestFor(bytes, mime), TIMEOUT_MS);
    assert.deepEqual(result, { toStatus: "clean", scannerId: "structural-inspect", engineVersion: "structural-inspect/1", definitionsVersion: "none", evidenceRef: "structural-inspect:passed" }, mime);
  }
});

test("structural rejections are quarantined (terminal) with the reason in the evidence reference, never a pass", async () => {
  const trailing = Buffer.concat([png(64, 64), Buffer.from("MZ-trailing-polyglot")]);
  const badCrc = Buffer.from(png(64, 64)); badCrc[badCrc.length - 1] = badCrc[badCrc.length - 1]! ^ 0xff;
  const cases: readonly [string, Uint8Array, string, string][] = [
    ["trailing bytes", trailing, "image/png", "MALFORMED"], ["bad CRC", badCrc, "image/png", "MALFORMED"], ["empty", new Uint8Array(0), "image/png", "EMPTY"],
    ["svg", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/svg+xml", "UNSUPPORTED"], ["gif", Buffer.from("GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;"), "image/gif", "UNSUPPORTED"],
    ["animated webp", webp(16, 16, true), "image/webp", "ANIMATED"], ["too many pixels", png(150, 150), "image/png", "DIMENSIONS"], ["side too long", png(201, 1), "image/png", "DIMENSIONS"],
    ["too many bytes", Buffer.concat([png(8, 8), Buffer.alloc(LIMITS.maxBytes)]), "image/png", "TOO_LARGE"],
  ];
  for (const [name, bytes, mime, reason] of cases) {
    const result = await runScan(port, requestFor(bytes, mime), TIMEOUT_MS);
    assert.deepEqual(result, { toStatus: "quarantined", scannerId: "structural-inspect", engineVersion: "structural-inspect/1", definitionsVersion: "none", evidenceRef: `structural-inspect:rejected:${reason}` }, name);
  }
});

test("a declared type that is not the real type is quarantined; a hash that is not the bytes' is unknown, never a verdict", async () => {
  const bytes = png(64, 64);
  assert.deepEqual(await runScan(port, requestFor(bytes, "image/jpeg"), TIMEOUT_MS), { toStatus: "quarantined", scannerId: "structural-inspect", engineVersion: "structural-inspect/1", definitionsVersion: "none", evidenceRef: "structural-inspect:rejected:MIME_MISMATCH" });
  assert.deepEqual(await runScan(port, { ...requestFor(bytes), sha256: "0".repeat(64) }, TIMEOUT_MS), { toStatus: "unknown", reasonCode: "scan_hash_mismatch", scannerId: "structural-inspect" });
});

test("an already aborted signal does no work and is a timeout outcome; an unexpected error is unknown, not a verdict", async () => {
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(port.scan(requestFor(png(8, 8)), aborted.signal), (error: unknown) => error instanceof Error && error.name === "AbortError");
  const broken = structuralInspectScanPort(null as never); // a programming error inside inspection must not become a verdict
  assert.deepEqual(await runScan(broken, requestFor(png(8, 8)), TIMEOUT_MS), { toStatus: "unknown", reasonCode: "scanner_threw", scannerId: "structural-inspect" });
});

test("static (M3-F2b): the adapter is inline and inert: contracts types and image-inspect only, no network, process or filesystem, no secret, no environment", () => {
  const source = readFileSync(join(repo, "packages/commerce/src/composition-scan-structural.ts"), "utf8");
  assert.deepEqual([...source.matchAll(/^import\s.*?from\s+"([^"]+)"/gm)].map(m => m[1]), ["@vynvori/contracts/composition-port", "./image-inspect"]);
  assert.match(source, /^import "server-only";/);
  assert.doesNotMatch(source, /\bfetch\(|child_process|node:net|node:http|node:fs|process\.env|require\(|setTimeout|setInterval/);
});
