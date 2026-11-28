import "server-only";
/**
 * Interim stage-1 scan adapter (ADR-0022 M3-F2b; founder decision 2026-11-28, "stage 1"): the existing structural inspection
 * (`inspectImage`) behind `ArtifactScanPort`, for an invite-only STAGING pilot only.
 *
 * THIS IS NOT MALWARE SCANNING AND IS NEVER LABELLED AS ONE. It checks magic bytes, container structure and CRCs, trailing bytes,
 * animation and the typed size, pixel and side limits, without decoding pixels. It has no signatures and no definitions, so it cannot
 * detect a crafted but well-formed file. The scan events it writes say so: scanner id `structural-inspect`, engine
 * `structural-inspect/1`, definitions `none`, and an evidence reference naming the check. ACC-07's "scans" clause stays NOT passed.
 *
 * It makes no network or process call and holds no secret, so it is inline (the C5 boundary), deterministic and free. A pass is the
 * verdict `clean` (the port vocabulary has no other pass); a structural rejection is the verdict `infected`, which the boundary
 * records as `quarantined` (terminal), because stored bytes that passed at upload and fail now are an anomaly that a retry cannot fix.
 * "infected" is only the port's word for "reject": the event's scanner id and evidence reference say what actually happened.
 * Anything unexpected is thrown and becomes `unknown(scanner_threw)`; this port never returns a verdict it did not compute.
 */
import type { ArtifactScanPort, ArtifactScanRequest, ArtifactScanResult } from "@vynvori/contracts/composition-port";
import { ImageRejectedError, inspectImage, type ImageLimits } from "./image-inspect";

export const STRUCTURAL_SCANNER_ID = "structural-inspect";
/** The only value of `M3_SCAN_ADAPTER` this module serves. Any other value, or none, leaves the deployment without a scanner. */
export const STRUCTURAL_ADAPTER_NAME = "structural-inspect";
const ENGINE_VERSION = "structural-inspect/1", DEFINITIONS_VERSION = "none";

/** `limits` are the SAME typed `M3_LIMIT_IMAGE_*` values the upload path enforces; nothing is defaulted here. */
export function structuralInspectScanPort(limits: ImageLimits): ArtifactScanPort {
  return Object.freeze({
    scannerId: STRUCTURAL_SCANNER_ID,
    async scan(request: ArtifactScanRequest, signal: AbortSignal): Promise<ArtifactScanResult> {
      if (signal.aborted) throw new DOMException("scan aborted", "AbortError");
      const answer = (verdict: ArtifactScanResult["verdict"], sha256: string, evidence: string): ArtifactScanResult => ({
        verdict, sha256, engineVersion: ENGINE_VERSION, definitionsVersion: DEFINITIONS_VERSION, evidenceRef: `structural-inspect:${evidence}`, scannedAt: new Date().toISOString(),
      });
      try {
        const inspected = inspectImage(request.bytes, limits);
        // the boundary compares this hash with the request's; a mismatch becomes unknown(scan_hash_mismatch), never a verdict
        if (inspected.mime !== request.mime) return answer("infected", inspected.sha256, "rejected:MIME_MISMATCH");
        return answer("clean", inspected.sha256, "passed");
      } catch (error) {
        if (error instanceof ImageRejectedError) return answer("infected", request.sha256, `rejected:${error.code}`);
        throw error;
      }
    },
  });
}
