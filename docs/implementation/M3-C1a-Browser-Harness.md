# M3 C1a — engine-parameterised browser harness

`scripts/browser-web.mjs` runs against the production build (`npm run build:web` first) and writes screenshots and `results.json` (including `engine` and `browser`, the version string) to `M0_EVIDENCE_DIR`, which must be outside the checkout.

| `M0_BROWSER` | Engine |
|---|---|
| unset or `chrome` | Chromium, Chrome channel (previous default) |
| `chromium` | Playwright Chromium |
| `firefox` | Playwright Firefox |
| `webkit` | Playwright WebKit |

Any other value, including an empty string, fails immediately with `Unsupported M0_BROWSER`, before a server is started. Selection lives in `scripts/browser-engine.mjs`; its unit test is `scripts/tests/browser-engine.test.mjs` (`node --test scripts/tests/browser-engine.test.mjs`; run by `npm run test:lifecycle` (part of `npm test`)).

Invocation (CI only for Firefox and WebKit; browsers are installed by the workflow, never in a session):

```bash
M0_BROWSER=firefox M0_EVIDENCE_DIR="$RUNNER_TEMP/m0-browser-firefox" npm run test:browser:web
M0_BROWSER=webkit  M0_EVIDENCE_DIR="$RUNNER_TEMP/m0-browser-webkit"  npm run test:browser:web
```

The interactive `/customize` scenarios (`scripts/browser-editor-scenarios.mjs`) run on every engine with all flags OFF at 1280, 390 and 320 CSS px. They exercise no save, upload, freeze, restore, cookie or identity path and use no product-code seam. No per-engine exception is asserted: none is known before the first Firefox/WebKit CI run. A difference found there is reported to the founder and asserted explicitly, never skipped.
