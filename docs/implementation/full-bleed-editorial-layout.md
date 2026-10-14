# Full-bleed editorial layout correction

Baseline: `8cb46a15cf9c99e69497894c1487d7a802db3964`, clean main matching origin/main on 2026-10-15. Branch: `fix/full-bleed-editorial-layout`. Founder-authorized spatial correction only; no merge or production promotion.

The deployed M0 capture at 2560x1440 reproduced a 1600px header/main/footer, each offset 480px from the viewport edge. The correction removes those global caps, uses `clamp(20px,2.5vw,64px)` gutters, a fluid asymmetric rail and viewport-relative campaign height. Wide hero media reaches the right edge through normal grid/padding rules, without negative margins or transforms. The next editorial section has balanced, bounded AI/BYO controls; both are fully visible at the primary founder viewport.

| 2560x1440 measured property | Before | After |
|---|---|---|
| Header/main/footer width | 1600px | 2560px |
| Outer centered-frame offset | 480px | 0px |
| Content gutter | 36px within frame | 64px within viewport |
| Wordmark element | 1528 x 213.8px | 2432 x 340.3px |
| Editorial rail | 270px | 460.8px |
| Campaign image element | 1216 x 500px | 1963.2 x 720px |

Original SVG proportions, Archivo, mineral/dark palettes, square edges, content and routes remain intact. Readable ledes/notices/product facts stay at 660px; Studio choices and entry controls are bounded. Other M0 routes inherit full-width framing. No changes to authentication, commerce, backend architecture, operational flags, API/events or migrations. No ADR is needed for this CSS/image-layout correction. Security scope is unchanged; all paid/operational actions remain unavailable.

## Executed evidence

- `npm run verify`: lint, all workspace typechecks, 7 M0 unit tests, 108 corrective + 104 legacy reference simulation checks, production build, security smoke and integrity passed.
- Final production build/lint/typecheck/reference integrity rerun after spacing refinement passed.
- `npm run test:browser:web`: **51/51 passed**, including all five routes at 320x480, 320x640, 390x568, 390x844, 768x1024, 1440x900, 1920x1080, 2560x1440 and 3440x1440, WCAG-tag axe, keyboard/focus, reduced motion, 200% text, assets and no external requests/runtime errors.
- Editorial geometry/capture harness: all five routes at the six requested sizes plus 3440x1440; full viewport frames, preserved wordmark ratio, readable ledes, no horizontal overflow and balanced visible primary CTAs.
- Protected design reference and canonical source remain intact: 146 reference payloads, 202 protected source hashes and nine byte-identical app asset/font/license copies. No new art or dependency changes.

Reproduce with a production server: `node scripts/editorial-layout.mjs http://127.0.0.1:3100`. Protected remote capture uses `vercel env run` and the exact owned Preview URL. The OIDC token is scoped to that origin and never saved or printed. Evidence writes to new external temporary directories. Before screenshots: `%TEMP%/VYNVORI-editorial-before-fpBtIZ`; verification log: `%TEMP%/vynvori-editorial-verify.log`; final M0 browser evidence: `%TEMP%/VYNVORI-M0-browser-fATpQo`. PR/Preview and final screenshot evidence are reported after actual delivery; local results do not imply remote CI/deployment acceptance.

## Image limitation and rollback

The unchanged campaign source is **1536x1024**. Its rendered width is about 1963px at 2560 and 2824px at 3440, approximately 1.28x and 1.84x the source width at 1x DPR. It cannot provide native-resolution detail on ultrawide/high-density displays. Intentional cover cropping preserves the campaign treatment; a higher-resolution approved original would be needed for greater detail. No replacement or invented artwork is introduced.

Rollback: revert this layout correction and rebuild. No data restoration, migrations or operational flag changes. Existing development Preview protection is retained; automatic Git deployment still requires the pending organization approval if not enabled. Stop for founder visual review.
