# M3 C1c — Cross-engine triage (root causes)

Status: **triage plus fixes for failures 1 and 3; failure 2 open; no fix verified on WebKit.** Firefox is verified by root's integrated run 41600819289 (87/87). Firefox and WebKit results exist only in root's CI; every other claim about those engines below is either read from the first cross-engine run or is labelled a hypothesis.

Base: `main` @ `7a51d8e` (C2 merged, CI green: M0 foundation run 41597015812, M2 backend foundation run 41597015746).
Source run: workflow run **41584515832**, job **125746776865**, head `6def9d1` of root's branch `claude/peaceful-heisenberg-cocinf` (PR #28). Chromium 151.0.7922.34: 87/87. Firefox 153.0: 86/87. WebKit 26.5: 85/87.

## Evidence used and its limits

| Evidence | Source | Limit |
| --- | --- | --- |
| Job log (1943 lines) | GitHub MCP `get_job_logs`, downloaded into an empty directory outside the repo | text only |
| Artifacts `m0-browser-firefox` (id 13207433031) and `m0-browser-webkit` (id 13207507976) | GitHub MCP `actions_get`, downloaded and unzipped outside the repo; `results.json`, `server.log`, screenshots read | `results.json` stores errors as bare strings: no route, timestamp or request id |
| Production build of this tree, served as the harness serves it (`scripts/web.mjs start`), probed with Chromium and plain HTTP | this sandbox | Chromium only. Firefox and WebKit cannot run here |

The built chunk `3639-aa266366393b902c.js` has the **same hash** as in the failing run, so the code inspected is the code that failed.

Sandbox note (not a repo change): the repository's Playwright expects Chromium build 1234, the sandbox has 1243. Two symlinks in `/opt/pw-browsers` (`chromium*-1234 -> *-1243`) let the harness launch it. `playwright install` was not run.

---

## Failure 1 — Firefox: CSP eval violations from chunk 3639

**Exact error (48 times, Firefox 153.0, `results.json` `errors[]`):**
`Content-Security-Policy: The page’s settings blocked a JavaScript eval (script-src) from being executed because it violates the following directive: “script-src 'self' 'unsafe-inline'” (Missing 'unsafe-eval')` `{file: ".../_next/static/chunks/3639-aa266366393b902c.js" line: 1}`

**Cause (established).** The chunk contains zod 4's capability probe, minified:

```
let j=new y(()=>{if(eu.jitless||"u">typeof navigator&&navigator?.userAgent?.includes("Cloudflare"))return!1;try{return Function(""),!0}catch(e){return!1}})
```

This is `allowsEval` in `node_modules/zod/v4/core/util.js` (zod 4.6.7, the only zod copy; declared by `packages/contracts`). Zod calls it lazily on the first object-schema construction/parse and uses code generation (`new Function`) only if it succeeds. The thrown error is caught, so the app works, but the attempt is a CSP violation. The zod source states this itself: *"Skip the probe under `jitless`: strict CSPs report the caught `new Function` as a `securitypolicyviolation` even though the throw is swallowed."* The skip is controlled by `globalConfig.jitless` (`z.config({ jitless: true })`).

The chunk also contains the code-generating `compile()` (`new Function(...)`) that the probe guards; with `jitless` it is never reached.

**Why only Firefox reported it.** The violation was observed on Chromium (DOM event) and Firefox (console error); it is not verified on WebKit. Reproduced in Chromium by listening for the DOM `securitypolicyviolation` event on the production build:

| Route | Violations (Chromium) |
| --- | --- |
| `/` | none |
| `/customize` | `script-src eval http://127.0.0.1:…/_next/static/chunks/3639-aa266366393b902c.js` |
| `/gallery` | none |

Only `/customize` (the editor, which imports `CompositionSceneV1Schema` and `CompositionReviewProjectionV1Schema` from `@vynvori/contracts`) runs zod in the browser. Chromium raises the event but writes **no console error** for a caught `new Function`; Firefox writes a console error for each. So the harness's console-error check saw it only on Firefox. The 48 errors are consistent with one per page load of `/customize` (many loads in the C1a scenarios), not with 48 different call sites.

**Reproduction.** `npm run build:web`; serve with `scripts/web.mjs start`; open `/customize` in Firefox with the existing CSP, or in any engine listen for `securitypolicyviolation`.

**Fix (applied).** `apps/web/src/components/editor/zod-jitless.ts` calls `config({ jitless: true })` in the browser only; it is imported first by `editor.tsx`, `review.tsx` and `model.ts`. This is a library setting (it disables the probe and the generated fast path), not a CSP change: hardening, not a weakening. Server-side zod is untouched. Guards: `apps/web/tests/editor-zod-jitless.test.ts` (control proves the probe is reached without the module) and the harness now records DOM `securitypolicyviolation` events on every engine and fails the final check on any. On the unfixed build the harness records **48** violations in Chromium (the Firefox count) and fails; on the fixed build it records 0.

---

## Failure 2 — WebKit: `/account?_rsc=… due to access control checks`

**Exact error (once, WebKit 26.5, `results.json` `errors[]`):**
`/127.0.0.1:34623/account?_rsc=-9sLjSlgneXyRTK- due to access control checks.` (the leading `Fetch API cannot load http:` is missing from the stored text; it is what `console.error` carried).

**What the server answers (established, plain HTTP against this tree).** `GET /account?_rsc=x` with `RSC: 1` and `Next-Router-Prefetch: 1` answers `307` with a **relative** `Location: /account?_rsc=<hash>`; the second request answers `200 text/x-component`. The same on `localhost` and `127.0.0.1`. There is no cross-origin or cross-host redirect, so candidate (2) of the plan is **discarded**.

**What happens in the browser (established in Chromium, same sequence as the harness's "Keyboard mobile menu" check at 320x480).** Recording `request`, `requestfinished` and `requestfailed` shows Next's router **aborting its own RSC fetches**, with no help from the harness:

```
  1054 FAILED /customize?_rsc=5CB68i4pnAekjehf net::ERR_ABORTED   (prefetch)
  1069 FAILED /account?_rsc=5CB68i4pnAekjehf  net::ERR_ABORTED   (prefetch)
  1086 FAILED /customize?_rsc=tXyZJ52UQVBCVsD3 net::ERR_ABORTED  (prefetch, re-requested with a new hash)
  1099 FAILED /account?_rsc=tXyZJ52UQVBCVsD3  net::ERR_ABORTED   (prefetch, re-requested with a new hash)
  2710 FAILED /customize?_rsc=jWo42Hg2N1i5UKji net::ERR_ABORTED  (navigation, about 20 ms after it starts)
```

These fire about 1 s after the mobile menu opens, with nothing clicked. Only `/customize` and `/account` are affected: they are the two dynamic (`ƒ`) routes in the header; `/products`, `/studio` and `/gallery` are static and their prefetches finish. Next's client router cancels superseded fetches through an `AbortSignal` (`next/dist/client/components/router-reducer/fetch-server-response.js`, "superseded request"). Chromium prints nothing for a cancelled fetch. **Hypothesis (not verified on WebKit):** WebKit prints a cancelled `fetch()` as `Fetch API cannot load … due to access control checks`, so one cancelled `/account` fetch became the single console error. It fits the message shape and the dynamic route; it does not explain why `/customize` (also aborted in Chromium) was not reported, which suggests timing dependence (an abort before response headers arrive).

**Candidates tested and discarded.**
- *Cross-origin or cross-host redirect:* discarded (relative same-origin 307, `localhost` and `127.0.0.1` identical).
- *The harness closes the menu while prefetches are in flight:* discarded. Making the harness wait for the request queue to drain, and for each destination heading, after every menu step left the same five aborts in Chromium. (Note: Playwright's `waitForLoadState("networkidle")` resolves immediately once reached, so it cannot be used for this.)
- *Harness filter:* forbidden by the C1c constraints.

**Experiment, not committed.** `prefetch={false}` on the `/account` and `/customize` header links (`apps/web/src/components/site-header.tsx`) removes the prefetch aborts in Chromium. It then exposes a second abort, the `/account` navigation, cancelled 18 ms after it starts by the harness's next click on Cart (in the unmodified build the prefetch has already warmed that navigation). So that edit alone is not shown to be sufficient; it would also need the harness to wait for the `/account` heading before clicking Cart, and it changes product navigation behaviour (no prefetch for two links).

**Status: cause NOT established on WebKit; no fix applied.** Everything above is Chromium evidence plus a hypothesis about WebKit's message. The file that would carry the product-side fix, `site-header.tsx`, is outside the C1c allowed list: **a root grant is required** before any change there. See "Open decision" below.

---

## Failure 3 — WebKit: `/gallery 320x480` `page.waitForFunction` timeout

**Exact error:** `FAIL Route, layout, assets and WCAG axe /gallery 320x480: page.waitForFunction: Timeout 30000ms exceeded.` The line that waits (`scripts/browser-web.mjs:72`):

```js
await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
```

**Cause (established for the geometry; WebKit's threshold is inferred).** `/gallery` has two `next/image` elements, both `loading="lazy"` (no `priority`). The header symbol is at the top. The article image `/assets/arch-study.svg` sits at **page offset 989 px at both 320-wide viewports** (measured in Chromium on this build):

| Viewport | Image top | Distance below the fold | WebKit result in run 41584515832 |
| --- | --- | --- | --- |
| 320x480 | 989 px | 509 px | **timeout** |
| 320x640 | 989 px | 349 px | pass |
| 390x568 | 769 px | 201 px | pass |
| 390x844 | 769 px | in view | pass |
| 768x1024, 1440x900 | 227 px | in view | pass |

A lazy image that never enters the load threshold never completes, so the wait cannot succeed. WebKit's lazy-load distance is smaller than Chromium's and Firefox's (both load a 509 px distance in this test), and the pass/fail pattern across the five WebKit viewports is exactly what a threshold between 349 px and 509 px predicts. That makes it **deterministic, not a flake**: it is the first (and the shortest) viewport in the loop and the only one whose image is that far below the fold. The one run shows the failure once; **no repeated-run counts exist yet** (one cross-engine run only). Root's integrated runs will supply counts.

**The assertion is correct** (every image must load). The harness is wrong to assume that a lazy image below the fold loads by itself.

**Fix (applied).** `loadLazyImages` (`scripts/browser-settle.mjs`) scrolls each image into view until it has loaded (bounded, never throws), then returns to the top; the `waitForFunction` and the `images` assertion are unchanged. `scripts/tests/browser-settle.test.mjs` proves in Chromium that a far-below-the-fold lazy image does not load by itself and does with the helper. WebKit result: NOT_RUN until root's integrated CI.

---

## Plan constraints honoured so far

CSP source (`apps/web/next.config.mjs`) untouched; no workflow, `.env.example`, `package.json` or lockfile change; no check skipped, filtered or weakened.

## Open decision (Failure 2)

1. Root integration of this branch shows whether the WebKit `/account` error persists once failures 1 and 3 are fixed and how often (repeat runs give counts).
2. If it persists, the options are: (a) grant to edit `apps/web/src/components/site-header.tsx` (`prefetch={false}` on `/account`, possibly `/customize`) plus a harness wait on the `/account` heading; (b) accept it as WebKit's reporting of a router-initiated cancel and decide, with root, how the check should treat it. Nothing here proposes a filter without root's decision.

## Not verified

Firefox and WebKit on any fix; repeated-run counts for the `/gallery` WebKit timeout; the claim that WebKit reports a cancelled fetch as the observed message.
