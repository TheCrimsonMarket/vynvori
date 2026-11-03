/**
 * SYNTHETIC test configuration. These numbers are test fixtures only: they are not product policy, not proposals and not
 * founder values (ADR-0022). Never import this file from src.
 */
import type { CompositionConfig } from "../src/composition";
import type { CompositionHttpConfig } from "../src/composition-http";
import { COMPOSITION_LIMIT_KEYS } from "../src/composition-limits";

export const SYNTHETIC_GUEST_TTL_SECONDS = 7200;
export const SYNTHETIC_IMAGE_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxPixels: 10_000_000, maxSide: 4000 });
export const SYNTHETIC_MAX_ASSETS = 3;
export const SYNTHETIC_MAX_BYTES_PER_COMPOSITION = 5 * 1024 * 1024;
export const SYNTHETIC_JSON_MAX_BYTES = 64 * 1024;

export const SYNTHETIC_COMPOSITION_CONFIG: CompositionConfig = Object.freeze({
  uploadsEnabled: false, guestTtlMs: SYNTHETIC_GUEST_TTL_SECONDS * 1000, imageLimits: SYNTHETIC_IMAGE_LIMITS,
  maxAssetsPerComposition: SYNTHETIC_MAX_ASSETS, maxBytesPerComposition: SYNTHETIC_MAX_BYTES_PER_COMPOSITION,
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
