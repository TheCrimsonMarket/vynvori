# M3 scanner options paper (P1)

Status: **INPUT FOR A FOUNDER DECISION. This paper decides nothing.** It does not choose a scanner, does not supply any of the 31 `M3_LIMIT_*` values and changes no code, flag, `.env.example` or registry row. Every number in section 6 is a **proposal for the founder to accept, change or replace**; until the founder supplies values, the runtime stays closed (ADR-0022 D1).
Plan reference: `M3-Closure-Plan.md` P1 (section 6) and Q4. Base: `main` @ `165b645` (ADR-0022 through C3b, PR #45, merged). Written 2026-11-27. All web sources were read on 2026-11-27; "retrieved" below means that date.

**Evidence rules used.** Every external fact carries a source link (section 8). A fact I could not read is marked **unknown**. Some Google and VirusTotal pages were read through a summarising fetch tool; those facts are marked *(summarised read, verify)*. A figure marked *(arithmetic)* is my calculation from a sourced figure and is not a quote. Nothing is taken from memory. No detection-rate or benchmark claim is made for any scanner because none was sourced.

## 1. The two decisions and what depends on them

| Decision owed (registry "Owed founder decisions") | Gates |
|---|---|
| (1) A malware scanner, or an interim approach | M3 PASSED, W2 |
| (2) The 31 `M3_LIMIT_*` values | M3 PASSED, W2, and any staging use of guest drafts or uploads |

Until both are made, M3 stays at LOCAL CLOSURE COMPLETE, uploads stay refused (`503 UPLOADS_DISABLED` with `unconfiguredScanPort`), and W2 stays blocked (ruling QC).

## 2. Summary for the founder

| | A. Interim: structural inspection only | B. Self-hosted ClamAV service | C. Hosted scanning API | D. Edge or storage-native scanning | E. Defer |
|---|---|---|---|---|---|
| Is it antivirus? | No | Yes (signature-based) | Yes (vendor-dependent) | Yes where it exists, but see section 3.D | n/a |
| Customer art leaves our platform? | No | No (stays in our GCP project) | **Yes**, to a third party | Yes, to Cloudflare | n/a |
| Money | none | my arithmetic: about 32 to 67 USD per month for one always-on instance, before free tier (section 3.B) | vendor-published prices exist for two vendors; two are unknown or unsuitable | Enterprise add-on, price unknown | none |
| We operate it | no | **yes** (image, signatures, scaling, patching) | no | no | no |
| Fits the C5 boundary (bytes in, verdict out) | needs an adapter, trivial | needs an adapter and a service | needs an adapter and possibly an SDK dependency | **poor**: verdict does not reach our database | n/a |
| Can it turn on staging uploads | only if the founder accepts it as meeting ACC-07 | yes, after adapter, infra and drill | yes, after adapter and drill | not as described | no |
| Reversible | yes | yes | yes, but uploaded art cannot be un-sent | unknown | yes |

**Recommendation (a recommendation only; the founder decides).**
1. **Keep E (defer) until the founder decides**, and keep the existing structural inspection (A) as an always-on pre-storage gate whichever option is chosen. It already rejects trailing bytes, animated images, SVG and bad CRCs before storage.
2. **For the staging pilot choose B (ClamAV on Cloud Run)**, with the adapter written to the `ArtifactScanPort` request/result shape so another engine can replace it. Reasons: art never leaves our GCP project; no per-scan fee; Google publishes a deployable reference architecture with an Apache 2.0 sample; it is vendor-neutral and reversible. The cost is operational burden and a new always-on service that needs founder-approved cloud work.
3. **If the founder does not want to run a service, choose C with Cloudmersive or Scanii**, both of which publish prices and state in-region or stateless handling, and **do not use** VirusTotal's free API (its stated terms forbid commercial use) or MetaDefender with default settings (default sample sharing and up to 10-year result retention).
4. **Do not treat any option as proof against image-decoder exploits.** I found no sourced evidence on how well any scanner detects crafted image exploits. The realistic residual risk sits in whatever later decodes the image (M5 rendering, browsers), and is reduced by pinned libraries and sandboxing, not by antivirus. ACC-07's wording ("scans/hash") is for the founder to interpret.

## 3. Options

### What the boundary requires of any option (ADR-0022 D3, C3b, C5)

| # | Requirement | Source in repo |
|---|---|---|
| R1 | Input is `{ assetId, sha256, byteSize, mime, bytes }`; output is a strict-parsed `clean`, `infected` or `error` plus `sha256`, `engineVersion`, `definitionsVersion`, `evidenceRef`, `scannedAt` | ADR-0022 D3 |
| R2 | Anything other than a well-formed `clean` or `infected` for the same hash (error, timeout, throw, malformed, wrong hash) becomes `unknown`; never `clean` | ADR-0022 D3 |
| R3 | One attempt per request, reservation committed before the call, no automatic retry, lease expiry only by explicit request | ADR-0022 D3, C3b; AGENTS rule 7 |
| R4 | `clean` and `quarantined` events need scanner id, engine version, definitions version and an evidence reference (the `0002` CHECKs) | ADR-0022 C3a |
| R5 | Scanner-side calls are separate from user-side calls; the HTTP view whitelists status, seq, time and a coarse reason, never the evidence reference | ADR-0022 C3b gates |
| R6 | Outage must fail closed: `unknown` blocks the owner from their own original (plan R6) | M3-Closure-Plan section 11 |
| R7 | Late detection (`clean` to `quarantined`) is a legal edge; a rescan path exists from `unknown` | ADR-0022 D3 |
| R8 | No vendor SDK, binary or image may enter the repo without a lane grant; any new dependency advisory fails `security:audit` (ADR-0020) | M3-Closure-Plan section 7 |

### A. Interim: controlled structural inspection only (doc 12:17, second branch)

*What it is.* Doc 12:17 lists "antivirus **or** controlled image decode/quarantine". `inspectImage` (`packages/commerce/src/image-inspect.ts`) already decides the type from magic bytes, verifies container structure and CRC, rejects trailing bytes, animation, SVG and other formats, and bounds decoded memory from declared dimensions, all **without decoding pixels**. Its own header says it is "NOT malware scanning".

| Aspect | Finding |
|---|---|
| Trade-offs | Vendor-free, no data leaves, no cost, deterministic, available now. It is not antivirus. It does not decode, so decoder-level exploits and metadata payloads inside a well-formed container are not examined. Originals must be returned unchanged, so re-encoding can be used only to compare, never to replace the stored bytes (OWASP states that rewriting "does not guarantee that all malicious content is removed"). |
| Cost | None. |
| Operational burden | None beyond code. |
| Sandbox and supply chain | No new dependency for the current inspection. A true decode-and-compare step would need an image library. The lockfile contains `sharp` 0.35.5, but no workspace package declares it (`apps/web`, `services/image-processing` and the root declare none); declaring it is a dependency-lane change and a new advisory exposure under ADR-0020. A decoder is itself an attack surface and would need a sandbox. |
| Data handling | Stays in process. |
| Fail-closed | An adapter must report `unknown` on any inspection throw. Because `inspectImage` already ran before storage, an adapter that re-runs it adds no new information; its value is only the honest labelling `structural-inspect` in the scan events. |
| Latency | Local CPU only; unmeasured here. |
| ACC-07 | The row reads "private R2 uploads, scans/hash, owner download, expired presigned URL". A structural check is hashing and format validation, not a scan. **Whether it satisfies "scans" is the founder's call**; it must never be recorded as malware-scanned. The R4 CHECK needs a non-empty definitions version, and what string stands for "no definitions" is a C5 question, not decided here. |
| To enable uploads | Section 4 steps 1 to 3 and 5 to 8; step 4 is a small adapter PR and no infrastructure. |

### B. Self-hosted open-source engine as a separate service (ClamAV)

*What it is.* ClamAV runs as `clamd` in a container; our adapter sends bytes to it and maps its reply to the port result. Google publishes a reference architecture (Cloud Storage plus Eventarc plus Cloud Run plus ClamAV) whose scanner container can be replaced by "any other anti-malware engine that performs on-demand scanning in Linux containers" *(summarised read, verify)*. We would reuse the container pattern, not the bucket and Eventarc half, because our bytes live in R2 and the adapter already has them in memory at upload time.

| Aspect | Finding |
|---|---|
| Trade-offs | No per-scan fee; art stays in our project; engine is swappable behind the port. Signature-based, so weaker on novel threats (plan Q4). Sourced detection performance on crafted image exploits: **unknown**. |
| License | ClamAV is GPL-2.0 ([docs.clamav.net](https://docs.clamav.net/)). Running the unmodified upstream image as a separate network service, not linking or committing it, is the pattern assumed here; a legal reading of GPL obligations is **unknown** and not made in this paper. Google's sample code is Apache 2.0 (deployment page). |
| Resources | ClamAV states a minimum of 3 GiB RAM and a preferred 4 GiB for Docker, "upwards of 1.2 GiB" just to load signatures, "upwards of 2.4 GiB" for a short period each day when loading new definitions, and warns "2GB may be insufficient" ([Docker page](https://docs.clamav.net/manual/Installing/Docker.html)). Google's sample uses 4 GiB, 1 CPU, minimum 1 instance (slow startup), maximum 5, concurrency 20, request timeout 300 s, CPU always allocated *(summarised read, verify)*. The existing `services/image-processing/cloud-run.yaml` template asks for 256 Mi, so a scanner cannot share that template. |
| Cost (all *arithmetic* from Cloud Run published rates, Tier 1; `us-east1` is listed under Tier 1, but the page text did not show a per-region row, so regional rates are **unverified**) | One 1 vCPU, 4 GiB instance kept warm for 30 days (2,592,000 s): **request-based billing, idle min-instance rates** (CPU 0.0000025 per vCPU-s, memory 0.0000025 per GiB-s): about **32.40 USD per month**. **Instance-based billing** (CPU 0.000018 per vCPU-s, memory 0.000002 per GiB-s, which is what Google's `--no-cpu-throttling` sample implies): about **67.39 USD per month**. Excluded: requests, egress, Cloud Storage for a signature mirror, Cloud Scheduler, logging. The free tier is stated "based on us-central1 pricing" and is ignored. The existing repo estimate of 0.000029 USD per active second for 1 CPU plus 2 GiB (`M2-Cloud-Run-readiness.md`) agrees with the request-based active rates read today. |
| Operational burden | **High relative to the other options.** Signature updates: ClamAV's Docker image defaults to one `freshclam` check per day; Google's sample mirrors the database to a private bucket, updated by a scheduler every two hours, with each instance checking the mirror every 30 minutes, to avoid CDN rate limiting; the same page warns that many instances pulling the full database can lead to an IP "blocked for 24 hours" *(summarised read, verify)*. Also needed: image pinning by digest, a patch cadence, monitoring that definitions are fresh, and a runbook for outage. Upstream warns clamd over TCP has no protections ("Extreme caution is to be taken"), so it must sit behind an authenticated HTTP wrapper, as in Google's `--no-allow-unauthenticated` sample. |
| Sandbox and supply chain | A new container image in a root-owned security lane. No binary or image is committed. The adapter is plain HTTP, so no SDK dependency is expected; if any client library is wanted, it needs a dependency grant and any new advisory fails `security:audit` (ADR-0020). Whether the Vercel app can call a Cloud Run service is **unknown**: the repo's processing template uses `run.googleapis.com/ingress: internal`, which Vercel cannot reach, so a caller path and authentication (not defined for the scanner anywhere in the repo) is an open design item. |
| Data handling | Bytes go from the Vercel function to Cloud Run in our own GCP project (`lucky-little-devil`, `us-east1` per ADR-0004). R2 is US jurisdiction (ADR-0007). No third party. Customer-asset residency and latency acceptance remain "future production decisions" per ADR-0007. |
| Fail-closed | clamd errors, timeouts, a limit hit or an unreachable service map to `unknown` (R2). ClamAV's `MaxFileSize` says "Files larger than this limit won't be scanned" (default 100M) and `StreamMaxLength` closes the stream when exceeded (default 100M); both defaults exceed our 25 MiB structural ceiling, but an adapter must treat any "not scanned" outcome as `unknown`. The exact wire replies for those cases were **not read** and must be checked in the adapter PR. A cold or down scanner blocks owners from their own files (plan R6) and the typed scan timeout is then the user-visible delay. |
| Latency | Sourced: Google states a 500 MiB file takes "approximately 5 minutes" to scan. A naive linear extrapolation (*arithmetic*, not a measurement) gives about 2.4 s for 4 MiB and about 15 s for 25 MiB. Cold start loads a signature set of "several hundreds of megabytes" *(summarised read)*; the sample avoids it with one warm instance. Measured latency for this stack: **unknown**. |
| Evidence fields (R4) | Engine and definitions versions are needed on every verdict. Whether clamd's version reply carries both: **unknown**, not read. |
| ACC-07 | Provides "scans". Satisfies the scanning half only; "expired presigned URL" is Q9. |

### C. Hosted scanning API (third-party service)

All vendors below receive the customer's artwork. That is a privacy, rights and processor decision for the founder (AGENTS: no unknown legal entities or processors are assumed). Data location versus the US R2 bucket (ADR-0007) differs by vendor.

| Vendor | Published price and limits (retrieved 2026-11-27) | Data handling as stated | Verdict for this project |
|---|---|---|---|
| [Cloudmersive Virus Scan API](https://cloudmersive.com/virus-api) | Free: "600 free API calls/month, with no expiration"; "large file support ... requires paid account for >10MB". Paid example: Medium Business "$499.99/Month", 250,000 calls, 5 calls/s, 2 GB max file ([pricing](https://cloudmersive.com/pricing-medium-business)). Per call about 0.0020 USD at full use (*arithmetic*); lower tiers: **unknown**. 99.99% SLA "available"; Managed Instance and on-premises tiers "Contact Us". | "Stateless processing processes payloads in memory and does not retain the payload." Regions listed include U.S. East, U.S. West, Canada, EU (Germany, France, Poland), Australia, UK, Singapore, India. | Candidate. A managed-instance or on-premises tier would keep bytes in our control but price is unknown. Detection coverage: **unknown**. |
| [Scanii](https://www.scanii.com/pricing) | Basic 49 USD per month for 1,000 files; Plus 99 USD for 5,000; Premium 199 USD for 10,000 (about 0.049, 0.0198 and 0.0199 USD per file, *arithmetic*). 2 GB max file. Rate limits 10, 50 and 200 requests per second by plan. 99.95% SLA on all plans. | "content never leaves your chosen region (US, Ireland, UK, Australia, Singapore, Canada)". Retention of file content: **unknown** (privacy policy linked, not read). | Candidate. The Premium plan's 10,000 files per month is **below** the monthly ceiling implied by the proposed global upload cap (section 6: 86,400 scans per month at the ceiling, *arithmetic*), so quota or a higher plan would be needed if traffic approached the cap. |
| [OPSWAT MetaDefender Cloud](https://www.opswat.com/docs/mdcloud/account-management/product-licensing) | Three plans (Standard, Professional, Enterprise). **Prices, rate limits, size limits and engine counts: not stated on the pages read** (pricing is at `metadefender.opswat.com/licensing`, which redirected to `metadefender.com/licensing` and was not followed). Multiscan plus Deep CDR "counts as 2 calls per file". | Without private processing, results "are visible to other users ... and are kept for up to 10 years"; "Sample sharing is enabled by default ... OPSWAT may share your file with the malware research community"; with private processing "your file is never shared". Training on submitted files only for files you allowed. | Possible only with private processing on and sample sharing off, confirmed in writing. Defaults are unsuitable for private customer art. Price: **unknown**. |
| [VirusTotal](https://docs.virustotal.com/docs/api-overview) | Public API: "at most 4 requests of any nature in any given 1 minute time frame"; 500 requests per day *(summarised read)*. Premium price: **unknown** (contact sales). | Handling of uploaded files: **not stated on the pages read**; its terms (redirected to Google Cloud terms) were not followed. | **Not suitable on its stated terms:** "The API must not be used in commercial products or services", with a permanent-ban warning. Only a licensed premium arrangement could be considered. |

Common aspects for option C:

| Aspect | Finding |
|---|---|
| Trade-offs | No servers to run; multi-engine breadth is claimed by some vendors but **unverified here**; customer art goes to a third party; vendor availability sits on the upload path; per-scan or per-plan cost; rate limits. |
| Operational burden | Low: keys, quota and vendor status monitoring. Keys are secrets and fall under the no-secrets-in-repo rule; any key name needs a root-owned `.env.example` change. |
| Sandbox and supply chain | A plain HTTPS adapter needs no SDK. If a vendor SDK is wanted, it needs a dependency grant and any new advisory fails `security:audit` (ADR-0020). |
| Fail-closed | Vendor 5xx, timeout, rate limit or malformed body map to `unknown`. A vendor that returns a result but not engine and definitions versions cannot supply the R4 fields; per-vendor response fields: **unknown**, not read. |
| Latency | **Unknown** for every vendor (no figure stated on the pages read). The typed scan timeout (section 6) bounds it. |
| ACC-07 | Provides "scans". Same Q9 note. |
| Sub-option: vendor-managed instance | Cloudmersive lists "Managed Instance" and "On-Premises" tiers with "Contact Us" pricing and per-instance SLAs; bytes would stay in our control. Price: **unknown**. |

### D. Edge or storage-native scanning

| Candidate | Finding |
|---|---|
| Cloudflare WAF content scanning | Enterprise plan with a paid add-on. Scans "up to the first 50 MB of a request body". **It flags, it does not block:** "Content scanning does not block or challenge requests on its own"; blocking needs a custom rule on fields such as `cf.waf.content_scan.has_malicious_obj`. Scanner timeouts set `cf.waf.content_scan.has_failed`. Password-protected archives, PDFs and Office files are not scanned (not relevant to PNG, JPEG, WebP). The engine is "the same one used in Cloudflare Zero Trust"; vendor not named; retention not stated ([overview](https://developers.cloudflare.com/waf/detections/malicious-uploads/), [get started](https://developers.cloudflare.com/waf/detections/malicious-uploads/get-started/), summarised read). **Fit is poor:** the verdict would be a request-time signal at the edge, not an `ArtifactScanPort` result with engine, definitions and evidence reference stored in our Postgres. It also applies only to traffic through a Cloudflare-proxied hostname; whether the app is behind Cloudflare is **unknown**. Price: **unknown**. |
| Cloudflare R2 | The pages read do not mention any built-in malware scanning of stored objects (not stated; other R2 pages not read). R2 event notifications exist for `object-create` and are delivered to a Cloudflare Queue consumed by a Worker or by HTTP pull ([event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)). That would allow an asynchronous scan after the write, which fits ADR-0022's "asynchronous worker is future work" but not the current inline design, and needs a scanner behind it anyway. |
| AWS GuardDuty Malware Protection for S3 | Scans "newly uploaded objects to your selected Amazon Simple Storage Service (Amazon S3) bucket" ([page](https://docs.aws.amazon.com/guardduty/latest/ug/gdu-malware-protection-s3.html)). Our objects are in R2, not S3. Not applicable. Quotas and pricing pages were not read. |
| Google's Cloud Storage reference architecture | Built around Cloud Storage buckets and Eventarc; our store is R2. Reusable only as the pattern in option B. |

Conclusion for D: none of these gives a verdict that the boundary can record with evidence fields, so none is recommended as the primary mechanism.

### E. Defer

Uploads stay off (`unconfiguredScanPort` always answers `error`, `503 UPLOADS_DISABLED`). Nothing to build, buy or operate. Cost: M3 stays at LOCAL CLOSURE COMPLETE and W2 stays blocked; no BYO-art journey can be rehearsed against staging (Q8 would be the only way, and its default is "no"). Risk: none to customers; schedule only.

### Comparison on the dimensions the plan asked for

| Dimension | A | B | C | D | E |
|---|---|---|---|---|---|
| Where bytes go | nowhere | our GCP project | vendor region (varies) | Cloudflare | nowhere |
| Fail-closed on outage | adapter-local, trivial | `unknown`; scanner down blocks owners | `unknown`; vendor down blocks owners | request-time only; unknown | uploads off |
| Evidence fields for R4 | made-up labels only (founder to accept) | to be verified | to be verified per vendor | not available | n/a |
| New supply-chain surface | none (or a decoder library if extended) | container image, root security lane | none for HTTPS; SDK needs a grant | none | none |
| Founder cloud work needed | none | **yes** (service, IAM, secrets) | **yes** (vendor account, key) | **yes** (plan, rules) | none |

## 4. What it takes to enable uploads, in order

This list applies to A, B or C with the differences noted. It does not authorise any step. Nothing here changes a flag.

1. **Founder decision recorded.** Choice of option, and whether A satisfies ACC-07 if chosen. The registry decision log and the "Owed founder decisions" row are coordinator-owned.
2. **The 31 `M3_LIMIT_*` values supplied** (section 6). Without them every upload route answers `503 COMPOSITION_LIMITS_NOT_CONFIGURED`.
3. **Prior plan steps merged.** C3b is merged (#45). C4 (quota, rate limits, authorize-before-read), C5 (scan boundary) and C6 (download grants) are not yet merged as of this paper's base; the registry says C5 and C6 are security-critical and get a security review before the founder looks at them.
4. **Adapter PR (separate, authorised).** A new `ArtifactScanPort` implementation. Lanes it may need, each by explicit grant: an ADR number from the registry; `.env.example` (commented key names only); dependencies and the lockfile (only if an SDK or client library is wanted; any new advisory fails `security:audit`, ADR-0020); `packages/contracts` (an additive revision if the request shape changes from bytes to a stream or reference, as ADR-0022 D3 anticipates); `security/**` or `scripts/security/**` if the security smoke needs to know the new network call. **Which exact protected files the adapter would touch is unknown until the adapter is designed.**
5. **Infrastructure (B and C only), by the founder.** B: a Cloud Run service, IAM, secrets and a signature mirror in the GCP project; AGENTS forbids threads from touching cloud infrastructure, and the Cloud Run staging service is deleted, so any staging use asks the founder first. C: a vendor account and an API key held as a secret.
6. **Security review** of the adapter by the `security-reviewer` agent and the founder, including the C3b gates (scanner-side calls only, field whitelist, late detection, access before charge).
7. **Staging drill B5** (M3-Closure-Plan section 9): a clean file gives `clean`; the standard antivirus test string, **assembled at run time and never committed**, gives `quarantined` and is never servable; a scanner outage gives `unknown`; the rescan path and lease-expiry procedure work. Evidence: decision record, drill transcript, scan-event rows.
8. **Other staging prerequisites in the plan:** B1 (staging Neon migration and rollback drill), B2 (R2 private round trip), B3 (real identity claim, because the composition API needs the isolated staging identity canary), and Q5 (edge controls) for any public exposure.
9. **Founder approval, then the flag path.** Two separate things exist today:
   - **Staging opt-in (environment only).** `compositionSettings` in `apps/web/src/server/composition-runtime.ts` enables uploads only when `M3_COMPOSITION_ENABLED=true`, the isolated staging identity canary passes, `VERCEL_ENV` is not `production`, and `M3_COMPOSITION_UPLOADS=true`. That is a Vercel environment-variable change (cloud settings: founder-only). It touches no repository file.
   - **The `assets.production_uploads` feature flag.** It is a literal `false` in `packages/shared/src/public.ts`, typed `false` in `FeatureFlags`, and `parseServerConfig` in `packages/shared/src/server.ts` throws if `VYNVORI_ASSETS_PRODUCTION_UPLOADS` is anything but unset or `false` ("activation is unavailable in M0"). Tests assert every flag is `false` (`packages/db/tests/ledger-isolation.test.ts:148`; `apps/web/tests/composition-config.test.ts:18,40`). Flipping it would be a source change in those files, an ADR and test changes, authorised by the founder. A search of `docs/implementation/M0-protected-files.json` for `shared` and `public` found no match; whether other gates (security smoke, CI scripts) also assert the flag is **unknown**. No thread may set a `VYNVORI_*` flag to true (AGENTS).

## 5. Facts that bear on both decisions

These came from reading the repo and sources while writing this paper. They are not in the closure plan.

1. **Vercel's default request-body limit is 4.5 MB**, and larger requests get `413 FUNCTION_PAYLOAD_TOO_LARGE` ([limits](https://vercel.com/docs/functions/limitations)). The upload route is a Vercel Function that buffers the body (doc 13 puts `apps/web` on Vercel). So the 25 MiB structural ceiling is **unreachable on the default platform setting**. A 20 MiB opt-in exists in Public Beta for Node.js and needs Fluid compute, 4 GB function memory on Pro or Enterprise and `VERCEL_SUPPORT_LARGE_REQUEST_BODY=1` (same page). Vercel's own guide recommends uploading large files directly from the browser to the storage host with an authenticated token ([guide](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions)); that would be a design change to M3's upload path and is out of scope here. The project's Vercel plan: **unknown**.
2. **Expired guest objects are never deleted** (the plan's known gap, doc 08 step 4). Quarantined, unknown and abandoned objects accumulate. The live-draft cap therefore does not bound total storage over time; only the global upload rate limit bounds growth per window (section 6 shows worst cases).
3. **Print-grade file sizes are unknown.** What resolution a garment print needs depends on the supplier's print area and DPI, which the repository does not have (AGENTS: no invented print dimensions). A 4 MiB cap may be too small for large lossless art; I make no claim about what is enough.
4. **A scan runs inline, in the upload request**, with the typed timeout (ADR-0022 D3). Vercel Functions with Fluid compute default to 300 s and can be configured up to 800 s on Pro, 300 s on Hobby (same limits page); non-Fluid duration limits: **not stated**. The scan timeout and lease below stay far inside 300 s.

## 6. The 31 `M3_LIMIT_*` values: proposals for the founder

**Nothing here is a default, an approval or a value to copy into `.env.example` or `src`.** Each row is a candidate with the reason it was picked, so the founder can accept it, change it or replace it. A value that depends on an unknown (supplier print specs, plan, traffic) says so. All values are positive safe integers; byte and pixel keys respect the structural ceilings (`IMAGE_MAX_BYTES` at most 26,214,400; `IMAGE_MAX_SIDE_PX` at most 20,000).

Conventions: window keys are seconds, `_MAX` is a count per window, byte keys are bytes. Arithmetic is mine.

### 6.1 Single values (keys 1 to 11)

| # | Key | Proposed | Rationale and what it depends on |
|---|---|---|---|
| 1 | `M3_LIMIT_GUEST_TTL_SECONDS` | 86400 | 24 h, same as the removed code value; doc 16:13 asks for a "short TTL". The TTL only controls access: no garbage collection exists, so a shorter TTL does not shrink storage. A longer TTL (for example 604800) trades guest convenience for a bigger live-draft population. Founder choice; no source fixes the number. |
| 2 | `M3_LIMIT_IMAGE_MAX_BYTES` | 4194304 | 4 MiB, safely under Vercel's default "4.5 MB" body limit under either reading of MB (4.5 MB = 4,500,000 B; 4.5 MiB = 4,718,592 B), leaving room for request overhead (the exact overhead is **unknown**). **Alternative if the founder wants larger originals:** up to 26,214,400, but that needs the Vercel 20 MiB Public Beta opt-in or a direct-to-storage upload design (section 5, item 1); that is a platform or scope decision. |
| 3 | `M3_LIMIT_IMAGE_MAX_PIXELS` | 16777216 | 4096 x 4096. Decoded RGBA is 4 bytes per pixel, so the worst case is 64 MiB (67,108,864 B) of decoded memory for later renderers. A smaller value is safer for M5; a larger one needs supplier print specs, which are unknown. |
| 4 | `M3_LIMIT_IMAGE_MAX_SIDE_PX` | 8192 | Allows a long thin image (8192 x 2048 is exactly 16,777,216 px) while rejecting pathological one-pixel-wide images that still pass the pixel count. Well under the 20,000 ceiling. |
| 5 | `M3_LIMIT_MAX_ASSETS_PER_COMPOSITION` | 16 | The synthetic preview profile allows 16 layers per zone (`composition-scene.ts`, labelled synthetic). Identical bytes are deduplicated by hash, so unique assets per draft are usually fewer than image layers. Two sides could in principle use up to 32 unique images; 16 is a conservative pilot value. |
| 6 | `M3_LIMIT_MAX_BYTES_PER_COMPOSITION` | 33554432 | 32 MiB, which equals 8 files at the proposed 4 MiB maximum, so it binds before the asset count does for large files and bounds per-draft storage. |
| 7 | `M3_LIMIT_JSON_MAX_BYTES` | 524288 | 512 KiB for scene saves and other JSON. The largest legal scene (64 layers, each up to 2000 characters of text, escaped) can in theory exceed this, but realistic scenes are far smaller. **The true maximum legal scene size was not measured in this paper**; a measurement test in C4 would remove the guess. The removed code value was 256 KiB. |
| 8 | `M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS` | 120 | The editor mints on a button press and navigates at once (D4); two minutes covers slow clients while keeping the bearer window short. Grants are single-use and re-mintable. |
| 9 | `M3_LIMIT_SCAN_TIMEOUT_SECONDS` | 30 | Covers the naive 25 MiB extrapolation for ClamAV (about 15 s) with margin; stays below ClamAV's own `MaxScanTime` default of 120000 ms and far below the Vercel Function duration. A cold scanner would exceed it and record `unknown` (a reason to keep one instance warm if option B is chosen). Hosted-vendor latency is unknown. |
| 10 | `M3_LIMIT_SCAN_LEASE_SECONDS` | 120 | Must exceed the scan timeout plus body read and database time so that an explicit lease expiry can never end a scan still running (ADR-0022 C3b: two-clock check). Four times the timeout is generous; a crashed request becomes expirable after two minutes. |
| 11 | `M3_LIMIT_LIVE_GUEST_DRAFTS_MAX` | 200 | Pilot scale (invite-sized staging pilot, no public exposure until Q5). Worst-case storage if every live draft is full at the proposed per-draft cap: 200 x 32 MiB = 6,400 MiB = 6.25 GiB; scene JSON worst case 200 x 512 KiB = 100 MiB. Raise only with a deletion policy (Q6b). |

### 6.2 Rate limits (keys 12 to 31)

Windows and maxima are proposals sized from observed behaviour, not from traffic data (none exists). The editor's autosave debounce is 1500 ms, so a continuously editing user saves at most about 40 times per minute; 429 responses must not trigger a retry storm (C4).

| # | Operation | Window key and proposed seconds | Max key and proposed count | Rationale |
|---|---|---|---|---|
| 12, 13 | `GUEST_CREATE_GLOBAL` | `..._WINDOW_SECONDS` 3600 | `..._MAX` 120 | Global bucket for IP-independent defence; one abuser can exhaust it (accepted gap, Q5). 120 per hour fills the proposed live cap in under two hours. |
| 14, 15 | `ASSET_UPLOAD_GLOBAL` | 3600 | 120 | Bounds storage growth per window. Ceiling: 120 x 24 = 2,880 uploads per day; at the proposed 4 MiB maximum that is 11,520 MiB = 11.25 GiB per day, and 86,400 scans per 30-day month (*arithmetic*). Quarantined and unknown objects are never deleted, so this is the only growth bound. |
| 16, 17 | `GUEST_WRITE` (save, freeze, restore, claim) | 60 | 60 | At least the 40 per minute autosave ceiling plus freeze, restore and claim headroom. |
| 18, 19 | `GUEST_ASSET_UPLOAD` | 3600 | 32 | Twice the proposed 16-asset cap, so failed attempts and retries do not lock a user out, yet one capability cannot flood storage. |
| 20, 21 | `GUEST_DOWNLOAD_GRANT` | 600 | 10 | Single-use grants are re-minted per click or retry; 10 in ten minutes covers re-tries. |
| 22, 23 | `GUEST_RESCAN` | 3600 | 3 | A rescan can cause a billable vendor call (AGENTS rule 7) or occupy scanner capacity; three per hour is enough for an `unknown` caused by a transient outage. |
| 24, 25 | `OWNER_WRITE` | 60 | 120 | Twice the guest value for owners using several tabs or devices. |
| 26, 27 | `OWNER_ASSET_UPLOAD` | 3600 | 64 | Four times the proposed per-draft asset cap, because an owner works across several compositions. |
| 28, 29 | `OWNER_DOWNLOAD_GRANT` | 600 | 30 | Owners may download originals from several drafts. |
| 30, 31 | `OWNER_RESCAN` | 3600 | 10 | More than guests (several assets across drafts) but still tightly bounded. |

Full key names are `M3_LIMIT_RATE_<OPERATION>_WINDOW_SECONDS` and `M3_LIMIT_RATE_<OPERATION>_MAX`, with the operations spelled as in ADR-0022. Count check: 11 single values plus 10 operations times 2 equals 31.

### 6.3 Interactions to keep in mind

- Raising `IMAGE_MAX_BYTES` raises the worst case of keys 6, 11, 14 and 15 and the scan latency (key 9).
- Keys 9 and 10 depend on the scanner chosen; they should be revisited once a measured latency exists.
- Key 15 and the hosted-API plan size interact (Scanii Premium covers 10,000 files per month; the proposed ceiling is 86,400).
- With the founder's values unset, the runtime stays closed; nothing in this paper changes that.

## 7. Open questions and unknowns for the founder

| # | Question or unknown | Why it matters |
|---|---|---|
| 1 | Which option (A, B, C or stay on E)? | Gates M3 PASSED and W2. |
| 2 | If A: does structural inspection satisfy ACC-07's "scans"? | Only the founder can accept an interim approach. |
| 3 | If C: is sending customer art to a third party acceptable, and in which region? | Privacy, rights and processor terms; none are assumed here. |
| 4 | If B: may the founder create the Cloud Run service, IAM and signature mirror, and how does Vercel authenticate to it? | Cloud infrastructure is founder-only; the caller path is undefined in the repo. |
| 5 | Does the app run on Vercel Pro, and is the 20 MiB Public Beta or a direct-to-storage upload acceptable? | Decides whether `IMAGE_MAX_BYTES` can exceed about 4 MiB. |
| 6 | Supplier print area and DPI. | Needed for sensible pixel and byte limits; unknown today. |
| 7 | Unverified in this paper: the CVE history of image decoders (the NVD page returned no content); Cloudflare data retention; MetaDefender prices; VirusTotal terms and file-size limit; Cloudmersive per-call prices below the top tier; GuardDuty quotas; ClamAV wire replies and version fields; per-region Cloud Run rates; any detection-rate figure for any scanner. | Each would need a source before it can support a decision. |

## 8. Sources (all retrieved 2026-11-27)

ClamAV and Google
- ClamAV home and licence, RAM and CPU guidance: <https://docs.clamav.net/>
- ClamAV Docker guidance (RAM, images, `FRESHCLAM_CHECKS`, clamd over TCP warning): <https://docs.clamav.net/manual/Installing/Docker.html>
- `clamd.conf(5)` defaults (`StreamMaxLength` 100M, `MaxFileSize` 100M, `MaxScanSize` 400M, `MaxScanTime` 120000 ms), ClamAV 1.5.4 package: <https://man.archlinux.org/man/extra/clamav/clamd.conf.5.en>
- Google, automated malware scanning for Cloud Storage uploads (architecture; summarised read): <https://docs.cloud.google.com/architecture/automate-malware-scanning-for-documents-uploaded-to-cloud-storage>
- Same, deployment page (4 Gi, min instance 1, 500 MiB in about 5 minutes, two-hour mirror schedule, Apache 2.0 samples; summarised read): <https://docs.cloud.google.com/architecture/automate-malware-scanning-for-documents-uploaded-to-cloud-storage/deployment>
- Cloud Run pricing: <https://cloud.google.com/run/pricing>

Platform
- Vercel Functions limits (4.5 MB default body, 20 MiB Public Beta, durations; page last updated 2026-08-24): <https://vercel.com/docs/functions/limitations>
- Vercel guide on large uploads: <https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions>
- Cloudflare WAF malicious uploads (content scanning): <https://developers.cloudflare.com/waf/detections/malicious-uploads/> and <https://developers.cloudflare.com/waf/detections/malicious-uploads/get-started/>
- Cloudflare R2 event notifications: <https://developers.cloudflare.com/r2/buckets/event-notifications/>
- Cloudflare R2 data security (no malware scanning mentioned): <https://developers.cloudflare.com/r2/reference/data-security/>
- AWS GuardDuty Malware Protection for S3: <https://docs.aws.amazon.com/guardduty/latest/ug/gdu-malware-protection-s3.html>

Hosted vendors
- Cloudmersive: <https://cloudmersive.com/virus-api>, <https://cloudmersive.com/pricing>, <https://cloudmersive.com/pricing-medium-business>
- Scanii: <https://www.scanii.com/> and <https://www.scanii.com/pricing>
- OPSWAT MetaDefender Cloud: <https://www.opswat.com/docs/mdcloud/account-management/product-licensing>, <https://www.opswat.com/docs/mdcloud/compliance/customer-data-offloading-policy>, <https://www.opswat.com/docs/mdcloud/compliance/secondary-use-of-customer-data-policy>, <https://www.opswat.com/docs/mdcloud/compliance/confidentiality>
- VirusTotal: <https://docs.virustotal.com/docs/api-overview> and <https://docs.virustotal.com/reference/public-vs-premium-api>

Guidance
- OWASP File Upload Cheat Sheet (antivirus or sandbox, store elsewhere, size limits, re-encoding does not guarantee removal): <https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html>

Repository (read at `165b645`)
- `docs/technical/12-security-privacy-abuse.md` line 17 (doc 12:17); `docs/technical/20-acceptance-matrix.md` ACC-07
- `docs/implementation/M3-Closure-Plan.md` (P1, section 5.1, Q4, section 9 B5)
- `docs/implementation/ADR-0022-M3-Closure-Asset-Access-Scanning-and-Limits.md` (D1 to D8, C3a, C3b)
- `docs/implementation/ADR-0004-Medusa-Cloud-Run.md`, `ADR-0007-R2-Jurisdiction-and-Synthetic-Recovery.md`, `ADR-0020-Dated-Dependency-Advisory-Waiver.md`, `M2-Cloud-Run-readiness.md`
- `packages/commerce/src/image-inspect.ts`; `packages/shared/src/public.ts`; `packages/shared/src/server.ts`; `apps/web/src/server/composition-runtime.ts`; `services/image-processing/cloud-run.yaml`

## 9. Scope statement

This is a docs-only deliverable: one new file. It edits no canonical specification, protected file, registry row, `.env.example`, code, test or workflow, and commits no vendor binary, SDK, antivirus test string or customer data. No flag was touched.
