# ADR 0001 — Minimal M0 web foundation

Status: implemented for PR review; no merge/deployment approval. Baseline: `0db351a95f5a47b360de1ad65d4c4145f4717bed`, local and remote main verified identical on 2026-10-14. The attached founder M0 implementation request separately authorizes branch, commit, push and PR. It supersedes the reset's implementation pause.

## Decision

Extend the existing npm workspace with `apps/web` (Next.js App Router) and `packages/shared` (typed public flags and server-only configuration). Keep the root lockfile, retained design workspace and original assets. No Turbo, alternate package manager, backend services or empty future packages.

Use native semantic navigation/details, a small locally maintained shadcn/ui-style Button/variant primitive, local Archivo and copied approved illustrative assets. Pages are new React server components; no prototype HTML embedding, fixture financial state or copied simulator runtime.

All thirteen operational flags are literal false in the public allowlist. Server configuration rejects enabled, malformed or misspelled M0 flags and public application environment variables; a documented Vercel metadata allowlist is tolerated and ignored. Instrumentation validates startup even for prerendered pages. Activation requires a later reviewed implementation, not an environment-only switch. Public imports cannot reach the server export because of `server-only` and scoped import checks.

The process-only `GET /api/health` is dynamic and no-store. It adds no domain API, event, database, identity or payment contract. M0 has no persisted customer state or third-party requests.

## Build and evidence boundary

Next uses an ignored `.next` directory link to a fresh external temporary build directory. Its Node launcher supplies app/root module search paths because compiled server modules execute from that physical directory. Webpack is explicitly selected for reproducible external-directory behavior; Turbopack is not needed for this foundation. Typecheck generates route types. Builds retain prior temporary output and refuse to replace unknown directories/links.

Canonical `docs/technical`, proposed contracts, original `logo` and all `design/reference` files remain byte-identical. New acceptance notes are in `docs/implementation`, honoring the explicit M0 instruction not to silently rewrite canonical chapters. ACC-01's retired benchmark and ACC-24's staging/rollback acceptance are not asserted passed.

## Deviations and consequences

The founder's current M0 scope brings the web shell forward from the historical M2 skeleton description. It restores no historical benchmark. Representative art remains internal-review-only until rights are cleared. Robots directives do not replace access control. This PR enables local review only.

Framework/typing pins are independently resolved: Next 16.4.0, React 19.3.0, TypeScript 5.9.3, Tailwind 4.3.3. The reference keeps TypeScript 7.0.2 without edits. ESLint 9.39.5 matches plugin peers despite deprecation; an unpatched dev-only dependency advisory remains documented.

## Migration, rollback and review

No database migrations or data transformations. No API/event migration. Rollback is reverting the reviewed M0 commit and reinstalling the old lockfile; stop the local web process first. Preserve external evidence/output separately. No production data or services need restoration. A future deployment requires a separate rollback/backup/release review.

Validation: root checks, process startup/health, production browser/axe/navigation/responsive checks, source hashes and scoped secret smoke. Exact results and limitations are in M0.md and M0-security-review.md. Founder/reviewer sign-off remains pending.
