# Final design reference — 1.1.1

The editable approved Monumental Atelier / Archivo design simulation. Customer entry: index.html. Scenario laboratory: review.html. Source, components, runtime art, font notices, mock fixtures/contracts and essential tests are retained. All ten simulated production gates remain OFF.

From the repository root:

    npm ci
    npm run verify
    npm run build
    npm run typecheck
    npm test
    npm run preview

Use Node >=22.23.0. Test tools are pinned in this workspace package and installed through the root lockfile. Unit tests require the Playwright/axe packages but launch no browser. npm run test:browser uses installed Chrome and blocks nonlocal requests. No paid providers or production backends are called.

Builds/tests write outside the source directory, defaulting to new system temporary directories. Set VYNVORI_TEST_OUTPUT_DIR to a NEW directory outside this package for another destination. Do not overwrite historical verification evidence.

REFERENCE-MANIFEST.json seals this retained subset, not the full original release. Runtime code, editable mock sources, components, art and font/license bytes match the approved release. Review navigation omits the removed screenshot-comparison gallery. Legacy behavioral assertions remain; their historical whole-workspace preservation check now verifies this retained manifest. The small baseline mock remains only because essential tests compare behavioral functions.

The full approved ZIP remains in the unchanged private portable archive: E:/dev/VYNVORI-ARCHIVE-2026-10-14-50190edd/A01/output/VYNVORI-DESIGN-RELEASE-1.1.1.zip. SHA256: 6ac4fcaa679b39155d5c240daefed941e94f0135a067628b4bd60def80ac7d18. Historical reports, screenshot galleries and superseded prototypes are excluded from the active reference.

Asset provenance: assets/manifest.json and docs/ASSET-PROVENANCE.md. Archivo TTF, OFL and METADATA must remain together. Preservation and simulation tests establish no commercial art rights, print qualification, invoice reconciliation or production readiness. Canonical authority remains ../../docs/technical/00-master-specification.md and its linked chapters.
