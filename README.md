# VYNVORI

M0 Next.js application foundation from the approved Monumental Atelier reference. The review build has no connected identity, commerce, AI, uploads or manufacturing operations.

- [Canonical technical blueprint](docs/technical/00-master-specification.md): chapters 00–25, published Phase 6E corrections and reference contracts, preserved byte-for-byte.
- [Editable Design Release 1.1.1 reference](design/reference/README.md): approved Monumental Atelier, Archivo, original logo, customer journey and interactive scenario laboratory.
- [Original brand assets](logo/): supplied logo variants and brand sheet.
- [M0 implementation/evidence](docs/implementation/M0.md), [architecture decision](docs/implementation/ADR-0001-M0-foundation.md), [security review](docs/implementation/M0-security-review.md).

## Development

Node 22.23.3 (minimum 22.23.0) and npm 10.9.9 were tested. From the root:

    npm ci
    npm run dev:web -- --hostname 127.0.0.1

Open http://127.0.0.1:3000. Required routes: `/`, `/studio`, `/customize`, `/products/black-oversized-tshirt`, `/gallery`. Account and Cart show truthful unavailable states. `GET /api/health` returns only `{"status":"ok"}` and `Cache-Control: no-store, max-age=0`, measuring this process only.

No credentials or environment file are required. Optionally copy `.env.example` to `apps/web/.env.local`. All thirteen operational flags must be false/unset; enabled, malformed or misspelled flags fail build/startup. Public config is a fixed allowlist; server config is guarded by `server-only`. Preview and Production contexts validate independently using Vercel's server-side `VERCEL_ENV`; both remain disabled.

## Validation

    npm run verify
    npm run test:browser:web
    npm run test:deployment
    npm run start:web -- --hostname 127.0.0.1

`verify` runs lint, all workspace typechecks, unit tests, production web build, protected-source/reference integrity and a scoped security smoke. Individual commands: `lint`, `typecheck`, `test`, `build:web`, `verify:reference`, `smoke:security`. The browser harness uses installed Chrome, starts its own production server, blocks external requests and captures screenshots outside the checkout. Set `M0_BROWSER=chromium` for Playwright's Chromium; CI installs it in an independent job. `test:deployment` checks default npm install and default `next build` in a fresh external monorepo copy and inspects deployment traces.

Local web builds write to fresh external temporary directories through an ignored `apps/web/.next` directory link. The runner refuses to replace real directories or unexpected links and preserves prior output. Stop active web processes before rebuilding; temporary output removed by the OS requires another build. Typecheck generates route types first. Vercel uses the normal app `next build` script without the local temporary-output runner.

The approved reference remains intact: `npm run preview`, `npm run build`, `npm run test:browser` and `npm run verify:reference` preserve its validation capability. These are simulation checks, not backend acceptance.

## Vercel development deployments

Target project: **vynvori-dev**, repository **TheCrimsonMarket/vynvori**, root **apps/web**, production branch **main**, Next.js preset, Node **22.x**. Enable source files outside the root for `packages/shared`. Keep build/output/install commands at framework/npm defaults; the root lockfile governs workspaces. No credentials, paid services or external databases are needed. All flags remain false in both Preview and Production; do not introduce public secret variables.

Connect the repository's existing Vercel Git integration for PR Previews and automatic merged-main builds. Use Vercel Authentication deployment protection where the selected plan supports it. GitHub Actions remains independent. Verify READY, the actual Preview URL, pages/assets/fonts and `/api/health` before accepting a deployment. A successful development deployment grants no commercial launch approval. Do not merge this PR or enable integrations automatically. See M0.md for actual account/deployment evidence and remaining setup steps.

The first protected [Preview](https://vynvori-4rp3evxui-omor-shahriars-projects.vercel.app) is READY and remotely tested. Automatic Git deployment remains pending the organization's Vercel GitHub app approval, scoped only to `vynvori`. Runtime code commit: `31c4009`; this is a manual API Preview with no production alias. Vercel's platform observability metadata is tolerated and ignored; system environment auto-exposure is disabled, Preview/Production contexts are configured separately, and Next telemetry is disabled.

For protected remote checks, use the authenticated CLI without saving tokens:

    npx --yes --package=vercel@64.0.2 vercel env run --project vynvori-dev --scope omor-shahriars-projects -- node scripts/browser-preview.mjs https://vynvori-4rp3evxui-omor-shahriars-projects.vercel.app

The harness scopes its short-lived OIDC header to the exact Preview origin, aborts external requests and writes screenshots/results to a new external temporary directory. It records no credentials or browser authentication state.

The founder made the repository public during this session to use Hobby Git integration; the previous private-organization restriction no longer applies. Hobby is limited to personal/noncommercial use; commercial operation requires an appropriate plan. Illustrative reference assets retain internal-review-only provenance, so public/commercial distribution remains a separate rights gate. noindex/nofollow headers are not access control.

## Troubleshooting

- Port in use: append `-- --port 3001` to `dev:web` or `start:web`.
- Browser unavailable: install Chrome, or install Playwright Chromium and select `M0_BROWSER=chromium`.
- Existing `.next` error: inspect and preserve any needed output before manually moving it aside. The runner refuses to remove unknown output.
- Flag error: remove it or set it to false. M0 cannot activate an integration.
- npm audit: M2 introduces Medusa transitive advisories; production audit is no longer clean. See the current [M2 evidence and blockers](docs/implementation/M2.md). Do not force a framework downgrade or hide the audit failure.

Historical benchmark, design phases, reviews, temporary extractions and old output/install trees were removed from the active workspace. Their previously verified private archive remains untouched at E:/dev/VYNVORI-ARCHIVE-2026-10-14-50190edd. Canonical chapters retain historical context mentioning those old paths; those mentions do not indicate installed packages or current executable dependencies.

Central auth/LuckyLittleDevil audit, merchant/payment eligibility, qualified AI models and rights, supplier/DTF profiles and physical QA, shipping terms, financial reconciliation and operational launch approvals remain unresolved. Live features remain OFF. Immediate next milestone: separately authorized **M1a source audit**; M2 staging must also precede M1b integration. Stop after M0 review.

## M2 backend foundation

The founder authorized M2 after the merged M1a source audit. Current implementation, commands, resource status and remaining security/permission gates are in [M2](docs/implementation/M2.md) and [ADR-0003](docs/implementation/ADR-0003-M2-foundation.md). New npm workspaces are `apps/medusa`, `packages/db`, `packages/commerce` and `services/image-processing`. Existing storefront routes and public health remain independent. Root typecheck/tests include the new workspaces; PostgreSQL tests explicitly skip when no isolated test database is configured. CI supplies one. `npm run build:m2` builds the foundation without cloud credentials; `npm run smoke:m2` is an operator-only optional connectivity check.

All operational features remain disabled. M2 infrastructure and deployment acceptance remain blocked; no production launch or M1b authorization follows from this code. Earlier M0 deployment/status paragraphs above describe historical evidence; consult M2 for current observed Vercel protection and approval blockers.
