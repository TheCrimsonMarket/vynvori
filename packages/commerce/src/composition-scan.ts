import "server-only";
/**
 * Malware-scan boundary (ADR-0022 D3, C5). No scanner vendor, binary, SDK or service is chosen, integrated or approximated here
 * (founder ruling QC). This module holds only:
 *  - `unconfiguredScanPort`, the ONLY in-repo `ArtifactScanPort`. It never answers `clean`, and the service refuses uploads and
 *    rescans while it is wired, so it is never actually called on a request path.
 *  - `parseScanResult`, the strict mapping of whatever a port returns to a store event. Only a well-formed `clean` or `infected`
 *    verdict for the SAME bytes becomes `clean` or `quarantined`; everything else becomes `unknown` with a coarse reason code.
 *  - `runScan`, one bounded call with an abort signal and the typed timeout. A throw or a malformed answer is `unknown`. A TIMEOUT is
 *    an unknown outcome (the port may still be running or billing), so it is recorded as `quarantined(scan_timeout)` and a human
 *    reconciles it before any re-check (founder-delegated decision 2026-11-28, M3-F2a; AGENTS rule 7).
 * There is no retry anywhere in this module: a call is attempted at most once per explicit request (AGENTS rule 7).
 */
import type { ArtifactScanPort, ArtifactScanRequest, ScanResultEvent } from "@vynvori/contracts/composition-port";

/** Thrown by `unconfiguredScanPort`; mapped to `unknown(scanner_not_configured)` if anything ever calls it. */
export class ScannerNotConfiguredError extends Error { constructor() { super("SCANNER_NOT_CONFIGURED"); this.name = "ScannerNotConfiguredError"; } }

/** The default wiring. Not a scanner: every call fails, and `isScanPortConfigured` is false for it. */
export const unconfiguredScanPort: ArtifactScanPort = Object.freeze({
  scannerId: "unconfigured",
  scan(): Promise<never> { return Promise.reject(new ScannerNotConfiguredError()); },
});

/** Same structural caps the store applies to scanner-reported text (append-only tables; ADR-0022 C3b). Not policy. */
const SCAN_TEXT_MAX = 512;
const hex64 = /^[a-f0-9]{64}$/;
/** RFC 3339 date-time with an explicit offset; `Date.parse` alone accepts far too much. */
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Printable ASCII only (no control characters or newlines: these land in append-only tables and operator logs). */
const printable = /^[\x20-\x7e]+$/;
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value === value.trim() && value.length <= SCAN_TEXT_MAX && printable.test(value);

/** A port is usable only if it is not the unconfigured default and names itself with valid scanner text. */
export function isScanPortConfigured(port: ArtifactScanPort | null | undefined): port is ArtifactScanPort {
  return !!port && port !== unconfiguredScanPort && isText(port.scannerId) && port.scannerId !== unconfiguredScanPort.scannerId && typeof port.scan === "function";
}

/** Coarse reason codes recorded with an `unknown` event (they match the store's `^[a-z][a-z0-9_]*$`). Never a vendor message. */
export type ScanUnknownReason = "scanner_error" | "scan_result_malformed" | "scan_hash_mismatch" | "scanner_threw" | "scanner_not_configured" | "scan_not_started";
/** The reason recorded with a timed-out scan's quarantine. */
export const SCAN_TIMEOUT_REASON = "scan_timeout";
/** A port that enforces its OWN deadline typically throws one of these. After the request has gone out that is the same unknown outcome as our timeout. */
const isTimeoutError = (error: unknown): boolean => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
const timedOut = (scannerId: string): ScanResultEvent => ({ toStatus: "quarantined", scannerId, ...SCAN_TIMEOUT_EVIDENCE, reasonCode: SCAN_TIMEOUT_REASON });
/**
 * What a timed-out scan records. The 0002 CHECK requires evidence text on every `quarantined` event, but a timeout has no verdict, so
 * the engine and definitions are the honest word `unavailable` and the evidence reference says what happened. No value is borrowed from
 * the port. A human reads this row; there is no automatic release (quarantine is terminal on every in-app path).
 */
export const SCAN_TIMEOUT_EVIDENCE = Object.freeze({ engineVersion: "unavailable", definitionsVersion: "unavailable", evidenceRef: "scan-timeout-outcome-unknown-human-reconcile-required" });
const RESULT_KEYS = ["verdict", "sha256", "engineVersion", "definitionsVersion", "evidenceRef", "scannedAt"] as const;

/**
 * Strict result mapping (ADR-0022 D3). `raw` is treated as untrusted: it must be a plain object with exactly the six own data
 * properties (no getters, no symbols, no extras). `error` maps to `unknown(scanner_error)`; a hash that is well formed but not the
 * request's maps to `unknown(scan_hash_mismatch)`; anything else that is not a complete `clean`/`infected` answer maps to
 * `unknown(scan_result_malformed)`. The scanner id recorded is the PORT's, never a value from the result.
 */
export function parseScanResult(raw: unknown, request: Pick<ArtifactScanRequest, "sha256">, scannerId: string): ScanResultEvent {
  const unknown = (reasonCode: ScanUnknownReason): ScanResultEvent => ({ toStatus: "unknown", reasonCode, scannerId });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return unknown("scan_result_malformed");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return unknown("scan_result_malformed");
  const own = Reflect.ownKeys(raw);
  if (own.length !== RESULT_KEYS.length || !RESULT_KEYS.every(key => own.includes(key))) return unknown("scan_result_malformed");
  const value: Record<string, unknown> = {};
  for (const key of RESULT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor)) return unknown("scan_result_malformed"); // accessors are never invoked
    value[key] = descriptor.value;
  }
  if (value.verdict === "error") return unknown("scanner_error");
  if (value.verdict !== "clean" && value.verdict !== "infected") return unknown("scan_result_malformed");
  if (typeof value.sha256 !== "string" || !hex64.test(value.sha256)) return unknown("scan_result_malformed");
  if (![value.engineVersion, value.definitionsVersion, value.evidenceRef].every(isText)) return unknown("scan_result_malformed");
  if (typeof value.scannedAt !== "string" || !rfc3339.test(value.scannedAt) || !Number.isFinite(Date.parse(value.scannedAt))) return unknown("scan_result_malformed");
  if (value.sha256 !== request.sha256) return unknown("scan_hash_mismatch");
  return {
    toStatus: value.verdict === "clean" ? "clean" : "quarantined", scannerId,
    engineVersion: value.engineVersion as string, definitionsVersion: value.definitionsVersion as string, evidenceRef: value.evidenceRef as string,
  };
}

/**
 * One scanner call, bounded by `timeoutMs` (typed `M3_LIMIT_SCAN_TIMEOUT_SECONDS`). On timeout the signal is aborted and the result
 * is `quarantined(scan_timeout)` (the outcome is unknown, so the asset is never served and never rescanned until a human reconciles
 * it); whatever the port answers later is ignored. Never retried here.
 */
export async function runScan(port: ArtifactScanPort, request: ArtifactScanRequest, timeoutMs: number): Promise<ScanResultEvent> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: "timeout" }>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ kind: "timeout" }); }, timeoutMs); });
  const call = Promise.resolve()
    .then(() => port.scan(request, controller.signal))
    .then(value => ({ kind: "answer" as const, value }), (error: unknown) => ({ kind: "threw" as const, error }));
  try {
    const outcome = await Promise.race([call, timeout]);
    if (outcome.kind === "timeout") return timedOut(port.scannerId);
    if (outcome.kind === "threw" && isTimeoutError(outcome.error)) return timedOut(port.scannerId); // the port's own deadline: same unknown outcome
    if (outcome.kind === "threw") return { toStatus: "unknown", reasonCode: outcome.error instanceof ScannerNotConfiguredError ? "scanner_not_configured" : "scanner_threw", scannerId: port.scannerId };
    return parseScanResult(outcome.value, request, port.scannerId);
  } finally { if (timer) clearTimeout(timer); }
}
