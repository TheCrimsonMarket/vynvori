"use client";
import "./zod-jitless";
import { useEffect, useState } from "react";
import Link from "next/link";
import { CompositionReviewProjectionV1Schema } from "@vynvori/contracts";
import { Button } from "@/components/ui/button";

type Loaded = { review: ReturnType<typeof CompositionReviewProjectionV1Schema.parse>; issues: { code: string; severity: string; layerId?: string }[] };
/** ED-03. Reads ONE immutable version; identity, validation and (future) quote must carry the same compositionVersionId + scene hash. */
export function Review({ compositionId, versionId }: Readonly<{ compositionId: string; versionId: string }>) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; text: string } | { status: "ready"; value: Loaded }>({ status: "loading" });
  const invalid = !compositionId || !versionId;
  useEffect(() => {
    if (invalid) return;
    let cancelled = false;
    fetch(`/api/v1/compositions/${compositionId}/versions/${versionId}`, { cache: "no-store", credentials: "same-origin" })
      .then(async response => {
        const data: unknown = await response.json().catch(() => null);
        if (!response.ok || !data || typeof data !== "object") throw new Error(String(response.status));
        const parsed = CompositionReviewProjectionV1Schema.safeParse((data as { review?: unknown }).review);
        if (!parsed.success) throw new Error("shape");
        if (!cancelled) setState({ status: "ready", value: { review: parsed.data, issues: (data as { preflightIssues?: Loaded["issues"] }).preflightIssues ?? [] } });
      })
      .catch(() => { if (!cancelled) setState({ status: "error", text: "This version could not be opened. It may have expired or belong to another account." }); });
    return () => { cancelled = true; };
  }, [compositionId, versionId, invalid]);
  return (
    <section className="atelier ed" aria-label="Composition review">
      <p className="eyebrow">THE INDEPENDENT EDITOR / REVIEW</p>
      <h1>FROZEN VERSION.</h1>
      {invalid && <p className="notice" role="alert">This review link is not valid.</p>}
      {!invalid && state.status === "loading" && <p role="status">Loading…</p>}
      {!invalid && state.status === "error" && <p className="notice" role="alert">{state.text}</p>}
      {!invalid && state.status === "ready" && (<>
        <p className="notice">PREVIEW ONLY — NOT APPROVED FOR PRINT. Print profile <strong>{state.value.review.identity.printProfileVersion}</strong> is a synthetic preview frame. No proof image, quote or cart exists in this milestone.</p>
        <dl className="product-facts">
          <div><dt>Composition version</dt><dd>{state.value.review.identity.compositionVersionId}</dd></div>
          <div><dt>Scene hash (SHA-256)</dt><dd className="ed-hash">{state.value.review.identity.sceneHashSha256}</dd></div>
          <div><dt>Validation</dt><dd>{state.value.review.validation?.state === "blocked" ? "Blocked" : "Preview only"}</dd></div>
          <div><dt>Newer unfrozen edits</dt><dd>{state.value.review.newUnfrozenEditsExist ? "Yes — editing starts a new version" : "No"}</dd></div>
        </dl>
        <h2 className="ed-h">Issues</h2>
        <ul className="ed-issues">{state.value.issues.map((issue, index) => <li key={index} data-severity={issue.severity}>{issue.code}{issue.layerId ? ` (${issue.layerId})` : ""}</li>)}</ul>
        <div className="ed-row"><Link className="button button-outline" href={`/customize/${compositionId}`}>Back to editor</Link><Button disabled>Order — not available yet</Button></div>
      </>)}
    </section>
  );
}
