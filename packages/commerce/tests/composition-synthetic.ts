/**
 * SYNTHETIC test configuration. These numbers are test fixtures only: they are not product policy, not proposals and not
 * founder values (ADR-0022). Never import this file from src.
 */
import type { ArtifactScanPort, ArtifactScanRequest } from "@vynvori/contracts/composition-port";
import type { CompositionConfig } from "../src/composition";
import type { CompositionHttpConfig } from "../src/composition-http";
import { COMPOSITION_LIMIT_KEYS, RATE_LIMITED_OPERATIONS, type RatePolicies } from "../src/composition-limits";

export const SYNTHETIC_GUEST_TTL_SECONDS = 7200;
export const SYNTHETIC_IMAGE_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxPixels: 10_000_000, maxSide: 4000 });
export const SYNTHETIC_MAX_ASSETS = 3;
export const SYNTHETIC_MAX_BYTES_PER_COMPOSITION = 5 * 1024 * 1024;
export const SYNTHETIC_JSON_MAX_BYTES = 64 * 1024;

/**
 * SYNTHETIC C4 rate policy: one generous window for every operation so the pre-C4 suites never meet a limit by accident. Tests that
 * exercise a limit override single operations with `SYNTHETIC_RATE_LIMIT` and `SYNTHETIC_RATE_WINDOW_SECONDS` below.
 */
export const SYNTHETIC_GENEROUS_RATE_MAX = 1000;
export const SYNTHETIC_LIVE_GUEST_DRAFTS_MAX = 1000;
export const SYNTHETIC_RATE_LIMIT = 3;
export const SYNTHETIC_RATE_LIMIT_WINDOW_SECONDS = 3600;
export const syntheticRatePolicies = (over: RatePolicies = {}): RatePolicies =>
  Object.freeze({ ...Object.fromEntries(RATE_LIMITED_OPERATIONS.map(operation => [operation, { windowSeconds: SYNTHETIC_RATE_LIMIT_WINDOW_SECONDS, max: SYNTHETIC_GENEROUS_RATE_MAX }])), ...over });

/**
 * SYNTHETIC C5 scan double. NOT a scanner and not a vendor stand-in (founder ruling QC): it inspects nothing and answers whatever
 * the test asks for, by default a well-formed `clean` answer for the request's own hash. It records every call so tests can prove
 * that the port is called at most once per request. Never import this from src.
 */
export type SyntheticScanBehaviour = (request: ArtifactScanRequest, signal: AbortSignal) => unknown;
export const syntheticScanAnswer = (verdict: "clean" | "infected" | "error", request: Pick<ArtifactScanRequest, "sha256">, over: Record<string, unknown> = {}) => ({
  verdict, sha256: request.sha256, engineVersion: "synthetic-engine-0", definitionsVersion: "synthetic-defs-0", evidenceRef: `evidence://synthetic/${verdict}`, scannedAt: new Date().toISOString(), ...over,
});
export function syntheticScanPort(behaviour: SyntheticScanBehaviour = request => syntheticScanAnswer("clean", request)): ArtifactScanPort & { calls: ArtifactScanRequest[] } {
  const calls: ArtifactScanRequest[] = [];
  return { scannerId: "synthetic-scanner", calls, async scan(request, signal) { calls.push(request); return (await behaviour(request, signal)) as never; } };
}
/** SYNTHETIC scan timeout and lease in milliseconds (the service takes ms; production derives them from `M3_LIMIT_SCAN_*` seconds). */
export const SYNTHETIC_SCAN_TIMEOUT_MS = 250;
export const SYNTHETIC_SCAN_LEASE_MS = 60_000;
/** SYNTHETIC C6 download-grant lifetime in milliseconds (production derives it from `M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS`). */
export const SYNTHETIC_DOWNLOAD_GRANT_TTL_MS = 120_000;

export const SYNTHETIC_COMPOSITION_CONFIG: CompositionConfig = Object.freeze({
  uploadsEnabled: false, guestTtlMs: SYNTHETIC_GUEST_TTL_SECONDS * 1000, imageLimits: SYNTHETIC_IMAGE_LIMITS,
  maxAssetsPerComposition: SYNTHETIC_MAX_ASSETS, maxBytesPerComposition: SYNTHETIC_MAX_BYTES_PER_COMPOSITION,
  rate: syntheticRatePolicies(), liveGuestDraftsMax: SYNTHETIC_LIVE_GUEST_DRAFTS_MAX,
  scanPort: syntheticScanPort(), scanTimeoutMs: SYNTHETIC_SCAN_TIMEOUT_MS, scanLeaseMs: SYNTHETIC_SCAN_LEASE_MS,
  downloadGrantTtlMs: SYNTHETIC_DOWNLOAD_GRANT_TTL_MS,
});
export const SYNTHETIC_HTTP_LIMITS: Pick<CompositionHttpConfig, "guestTtlSeconds" | "maxJsonBytes" | "maxUploadBytes"> = Object.freeze({
  guestTtlSeconds: SYNTHETIC_GUEST_TTL_SECONDS, maxJsonBytes: SYNTHETIC_JSON_MAX_BYTES, maxUploadBytes: SYNTHETIC_IMAGE_LIMITS.maxBytes,
});
/** A complete, valid `M3_LIMIT_*` environment of synthetic values (every one of the 31 keys). */
export function syntheticLimitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  COMPOSITION_LIMIT_KEYS.forEach((key, index) => { env[key] = String(100 + index); });
  Object.assign(env, {
    M3_LIMIT_GUEST_TTL_SECONDS: String(SYNTHETIC_GUEST_TTL_SECONDS), M3_LIMIT_IMAGE_MAX_BYTES: String(SYNTHETIC_IMAGE_LIMITS.maxBytes),
    M3_LIMIT_IMAGE_MAX_PIXELS: String(SYNTHETIC_IMAGE_LIMITS.maxPixels), M3_LIMIT_IMAGE_MAX_SIDE_PX: String(SYNTHETIC_IMAGE_LIMITS.maxSide),
    M3_LIMIT_MAX_ASSETS_PER_COMPOSITION: String(SYNTHETIC_MAX_ASSETS), M3_LIMIT_MAX_BYTES_PER_COMPOSITION: String(SYNTHETIC_MAX_BYTES_PER_COMPOSITION),
    M3_LIMIT_JSON_MAX_BYTES: String(SYNTHETIC_JSON_MAX_BYTES),
  });
  return env;
}

/** SYNTHETIC C3b store-primitive values (ADR-0022 C3b). Test fixtures only; no founder value exists for any of them. */
export const SYNTHETIC_SCAN_LEASE_SECONDS = 60;
export const SYNTHETIC_GRANT_TTL_SECONDS = 300;
export const SYNTHETIC_RATE_WINDOW_SECONDS = 60;
export const SYNTHETIC_RATE_MAX = 3;
/** Synthetic scanner evidence: never a real vendor, engine or signature set (founder ruling QC: no scanner is chosen). */
export const SYNTHETIC_SCAN_EVIDENCE = Object.freeze({ scannerId: "synthetic-scanner", engineVersion: "synthetic-engine-0", definitionsVersion: "synthetic-defs-0", evidenceRef: "evidence://synthetic/clean" });

/** SYNTHETIC C4 store-level quota and live-cap fixtures (ADR-0022). Test fixtures only; no founder value exists for any of them. */
export const SYNTHETIC_LIVE_CAP = 3;
export const SYNTHETIC_QUOTA_MAX_ASSETS = 3;
export const SYNTHETIC_QUOTA_BYTES = 1000;
