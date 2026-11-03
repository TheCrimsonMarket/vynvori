# M3 C1c — Cross-engine triage (root causes)

Status: **triage only. No fix is described here as verified on Firefox or WebKit.** Firefox and WebKit results exist only in root's CI; every claim about those engines below is either read from the first cross-engine run or is labelled a hypothesis.

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

**Why only Firefox reported it.** The violation happens on every engine. Reproduced in Chromium by listening for the DOM `securitypolicyviolation` event on the production build:

| Route | Violations (Chromium) |
| --- | --- |
| `/` | none |
| `/customize` | `script-src eval http://127.0.0.1:…/_next/static/chunks/3639-aa266366393b902c.js` |
| `/gallery` | none |

Only `/customize` (the editor, which imports `CompositionSceneV1Schema` and `CompositionReviewProjectionV1Schema` from `@vynvori/contracts`) runs zod in the browser. Chromium raises the event but writes **no console error** for a caught `new Function`; Firefox writes a console error for each. So the harness's console-error check saw it only on Firefox. The 48 errors are consistent with one per page load of `/customize` (many loads in the C1a scenarios), not with 48 different call sites.

**Reproduction.** `npm run build:web`; serve with `scripts/web.mjs start`; open `/customize` in Firefox with the existing CSP, or in any engine listen for `securitypolicyviolation`.

**Fix direction (not yet applied).** Set zod `jitless` from an editor module before the first parse. This is a configuration of the library (it disables the probe and the generated fast path), not a CSP change. Hardening, not a weakening.

---

## Failure 2 — WebKit: `/account?_rsc=… due to access control checks`

**Exact error (once, WebKit 26.5, `results.json` `errors[]`):**
`/127.0.0.1:34623/account?_rsc=-9sLjSlgneXyRTK- due to access control checks.` (the leading `Fetch API cannot load http:` is missing from the stored text; it is what `console.error` carried).

**What the server answers (established, plain HTTP against this tree).** `GET /account?_rsc=x` with `RSC: 1` and `Next-Router-Prefetch: 1` answers `307` with a **relative** `Location: /account?_rsc=<hash>`; the second request answers `200 text/x-component`. The same on `localhost` and `127.0.0.1`. There is no cross-origin or cross-host redirect, so candidate (2) of the plan is **discarded**.

**What happens in the browser (established in Chromium, same sequence as the harness's "Keyboard mobile menu" check at 320x480).** Recording `request`, `requestfinished` and `requestfailed` while opening the menu and clicking each link in turn shows Next's router **aborting in-flight prefetches**:

```
FAILED /customize?_rsc=5CB68i4pnAekjehf net::ERR_ABORTED
FAILED /account?_rsc=5CB68i4pnAekjehf  net::ERR_ABORTED
FAILED /account?_rsc=tXyZJ52UQVBCVsD3  net::ERR_ABORTED
```

Opening the mobile menu makes all links visible and starts their prefetches; clicking one link closes the menu, the other links leave the viewport and the router cancels their prefetches. `/account` is `force-dynamic`, so its prefetch is the slowest to finish and the most often still in flight. Chromium prints nothing for a cancelled fetch. **Hypothesis (not verified on WebKit):** WebKit prints a cancelled `fetch()` as `Fetch API cannot load … due to access control checks`, which is how one aborted `/account?_rsc` prefetch became the single console error. This matches the message shape, the single occurrence and the dynamic route, but cannot be proven without running WebKit. Root's integrated CI is the test.

**Not a product defect:** the abort is Next's normal prefetch cancellation; a user sees no failure.

**Fix direction (not yet applied).** In the harness, let the prefetches finish (network idle) after the menu opens and before the link is clicked, so the router has nothing to cancel, and add an assertion that no same-origin request fails during that check. No error is filtered. If WebKit still reports it, the remaining option is `prefetch={false}` on the header links in `site-header.tsx`, which is outside the allowed files and needs a root grant.

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

**Fix direction (not yet applied).** Scroll every image into view before the wait, then return to the top; keep the wait and the `images` assertion unchanged.

---

## Plan constraints honoured so far

CSP source (`apps/web/next.config.mjs`) untouched; no workflow, `.env.example`, `package.json` or lockfile change; no check skipped, filtered or weakened.
