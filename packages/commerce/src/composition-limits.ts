/**
 * Typed M3 composition limits (ADR-0022 D1). Every POLICY number comes from `M3_LIMIT_*` configuration supplied by the
 * founder. There is NO default for any key: a missing or invalid key closes the capability that needs it
 * (`COMPOSITION_LIMITS_NOT_CONFIGURED`). Errors and logs name KEYS only, never values.
 */
import type { ImageLimits } from "./image-inspect";

/** Structural ceilings. They mirror the `0001` composition-schema CHECKs on `assets`; a test reads the SQL and fails on drift. */
export const IMAGE_BYTES_STRUCTURAL_CEILING = 26214400;
export const IMAGE_SIDE_STRUCTURAL_CEILING = 20000;

export const RATE_LIMITED_OPERATIONS = Object.freeze([
  "GUEST_CREATE_GLOBAL", "ASSET_UPLOAD_GLOBAL",
  "GUEST_WRITE", "GUEST_ASSET_UPLOAD", "GUEST_DOWNLOAD_GRANT", "GUEST_RESCAN",
  "OWNER_WRITE", "OWNER_ASSET_UPLOAD", "OWNER_DOWNLOAD_GRANT", "OWNER_RESCAN",
] as const);
export type RateLimitedOperation = (typeof RATE_LIMITED_OPERATIONS)[number];

const SINGLE_NAMES = [
  "GUEST_TTL_SECONDS", "IMAGE_MAX_BYTES", "IMAGE_MAX_PIXELS", "IMAGE_MAX_SIDE_PX", "MAX_ASSETS_PER_COMPOSITION", "MAX_BYTES_PER_COMPOSITION",
  "JSON_MAX_BYTES", "DOWNLOAD_GRANT_TTL_SECONDS", "SCAN_TIMEOUT_SECONDS", "SCAN_LEASE_SECONDS", "LIVE_GUEST_DRAFTS_MAX",
] as const;
export type SingleLimitName = (typeof SINGLE_NAMES)[number];
export type RateLimitName = `RATE_${RateLimitedOperation}_WINDOW_SECONDS` | `RATE_${RateLimitedOperation}_MAX`;
export type CompositionLimitName = SingleLimitName | RateLimitName;
export type CompositionLimitKey = `M3_LIMIT_${CompositionLimitName}`;

const NAMES: readonly CompositionLimitName[] = Object.freeze([
  ...SINGLE_NAMES,
  ...RATE_LIMITED_OPERATIONS.flatMap(operation => [`RATE_${operation}_WINDOW_SECONDS`, `RATE_${operation}_MAX`] as const),
]);
/** Exactly the 31 environment variable names of ADR-0022 section "Values the founder must supply". */
export const COMPOSITION_LIMIT_KEYS: readonly CompositionLimitKey[] = Object.freeze(NAMES.map(name => `M3_LIMIT_${name}` as const));

export type ParsedCompositionLimits = Readonly<{
  values: Readonly<Partial<Record<CompositionLimitName, number>>>;
  /** Full environment variable names that are absent. */
  missing: readonly CompositionLimitKey[];
  /** Full environment variable names that are present but not acceptable. Values are never echoed. */
  invalid: readonly CompositionLimitKey[];
}>;

const canonicalPositiveInteger = /^[1-9][0-9]*$/;
function ceilingOf(name: CompositionLimitName): number {
  return name === "IMAGE_MAX_BYTES" ? IMAGE_BYTES_STRUCTURAL_CEILING : name === "IMAGE_MAX_SIDE_PX" ? IMAGE_SIDE_STRUCTURAL_CEILING : Number.MAX_SAFE_INTEGER;
}

/** A value is valid only as a canonical positive decimal integer string that is a safe integer and within its structural ceiling. */
export function parseCompositionLimits(env: Readonly<Record<string, string | undefined>>): ParsedCompositionLimits {
  const values: Partial<Record<CompositionLimitName, number>> = {}, missing: CompositionLimitKey[] = [], invalid: CompositionLimitKey[] = [];
  for (const name of NAMES) {
    const key = `M3_LIMIT_${name}` as const, raw = env[key];
    if (raw === undefined || raw === "") { missing.push(key); continue; }
    const parsed = canonicalPositiveInteger.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(parsed) || parsed > ceilingOf(name)) { invalid.push(key); continue; }
    values[name] = parsed;
  }
  return Object.freeze({ values: Object.freeze(values), missing: Object.freeze(missing), invalid: Object.freeze(invalid) });
}

/** Keys each capability needs. Rate, scan, grant and live-draft keys are parsed now and consumed by later M3 steps. */
export const CAPABILITY_LIMIT_NAMES = Object.freeze({
  api: ["JSON_MAX_BYTES"],
  guestCreate: ["JSON_MAX_BYTES", "GUEST_TTL_SECONDS"],
  uploads: ["JSON_MAX_BYTES", "IMAGE_MAX_BYTES", "IMAGE_MAX_PIXELS", "IMAGE_MAX_SIDE_PX", "MAX_ASSETS_PER_COMPOSITION", "MAX_BYTES_PER_COMPOSITION"],
} as const satisfies Record<string, readonly SingleLimitName[]>);

const need = (parsed: ParsedCompositionLimits, names: readonly SingleLimitName[]): Record<string, number> | null => {
  const out: Record<string, number> = {};
  for (const name of names) { const value = parsed.values[name]; if (value === undefined) return null; out[name] = value; }
  return out;
};

/** Each resolver returns the typed limits, or `null` when any needed key is missing/invalid: the capability is then closed. */
export function resolveApiLimits(parsed: ParsedCompositionLimits): Readonly<{ jsonMaxBytes: number }> | null {
  const v = need(parsed, CAPABILITY_LIMIT_NAMES.api); return v ? Object.freeze({ jsonMaxBytes: v.JSON_MAX_BYTES! }) : null;
}
export function resolveGuestCreateLimits(parsed: ParsedCompositionLimits): Readonly<{ jsonMaxBytes: number; guestTtlSeconds: number }> | null {
  const v = need(parsed, CAPABILITY_LIMIT_NAMES.guestCreate); return v ? Object.freeze({ jsonMaxBytes: v.JSON_MAX_BYTES!, guestTtlSeconds: v.GUEST_TTL_SECONDS! }) : null;
}
export type UploadLimitsResolved = Readonly<{ jsonMaxBytes: number; imageLimits: ImageLimits; maxAssetsPerComposition: number; maxBytesPerComposition: number }>;
export function resolveUploadLimits(parsed: ParsedCompositionLimits): UploadLimitsResolved | null {
  const v = need(parsed, CAPABILITY_LIMIT_NAMES.uploads); if (!v) return null;
  return Object.freeze({
    jsonMaxBytes: v.JSON_MAX_BYTES!,
    imageLimits: Object.freeze({ maxBytes: v.IMAGE_MAX_BYTES!, maxPixels: v.IMAGE_MAX_PIXELS!, maxSide: v.IMAGE_MAX_SIDE_PX! }),
    maxAssetsPerComposition: v.MAX_ASSETS_PER_COMPOSITION!, maxBytesPerComposition: v.MAX_BYTES_PER_COMPOSITION!,
  });
}
