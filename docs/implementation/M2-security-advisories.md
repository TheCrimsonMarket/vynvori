# PR #4 — Dependency advisory disposition

2026-10-15. Baseline `9cb3498ece82fb78295dd089f44dca482b967650`. No exception approved. The unmodified `npm audit --omit=dev` gate remains blocking. Installed-package reachability analysis below is scoped to this synthetic M2 configuration, not a general Medusa security certification.

## Reproduction and compatible fixes

Fresh Node 22.23.3/npm 10.9.9 `npm ci` against the reviewed lock reproduces **84 affected-package findings: 76 high, 8 moderate**. After the two scoped updates, fresh installation/audit reports **79: 76 high, 3 moderate**, originating only in braces and sprintf-js. These are propagated package counts, not 79 independent advisories. Audit JSON is retained in external temporary evidence and CI logs remain authoritative for the published head.

Registry `npm view @medusajs/medusa version` still returns **2.21.2**; no newer compatible patched Medusa release is available in this run. No framework downgrade or blanket override is used. Lockfile changes remove two stale vulnerable nested resolutions and reuse already pinned patched root copies; npm regenerated the resolution graph.

| Advisory | Reviewed installed version → fix | Scope and compatibility evidence |
|---|---|---|
| [AJV GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6) | Rushstack's nested 8.13.0 → 8.20.0 | Override only `@rushstack/node-core-library@5.13.0 > ajv`. Same AJV major; existing JSON-schema and draft-04 consumers retain their APIs. Consumer test executes Rushstack `JsonSchema.fromLoadedObject/validateObject` with accepted/rejected fixtures; migration/build/runtime tests exercise its parent chain. ESLint's required AJV 6.15.0 is untouched. Resolved |
| [UUID GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | BullMQ's nested 9.0.1 → 11.1.1 | Override only `bullmq@5.13.0 > uuid`. Audited installed BullMQ CommonJS call sites in `dist/cjs/classes/{queue,worker,flow-producer}.js` use `v4()` returning a string; patched UUID retains this API and CommonJS export. Consumer test resolves from BullMQ, invokes v4 and validates version/shape. No BullMQ upgrade or Redis activation; no claim of full Redis queue integration acceptance. Resolved |

## Remaining: braces — founder security review required

- **Installed:** `braces@3.0.3`; advisory [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) affects <=3.0.3. Registry latest is 3.0.3; advisory lists no patched release. Upstream tracking: [micromatch/braces#70](https://github.com/micromatch/braces/issues/70).
- **Trigger:** deeply nested attacker-controlled brace patterns reach recursive AST compile/expand walkers, causing stack-exhaustion denial of service. The package remains a production dependency; it is not accurately classified as dev-only.
- **Installed chains:** Medusa → admin-bundler → Tailwind 3/chokidar/fast-glob → micromatch → braces; Medusa framework/deps → Awilix 8 → fast-glob → micromatch → braces; MikroORM → globby → fast-glob, and MikroORM migrations → Umzug → fast-glob → micromatch → braces. Next's lint plugin also has a development-only fast-glob chain.
- **Reviewed call paths:** `awilix/lib/list-modules.js:_listModules` glob-discovers configured module paths; `@mikro-orm/core/metadata/MetadataDiscovery.js:discoverDirectories` discovers configured entity paths; `umzug/lib/umzug.js:getMigrationsResolver` resolves configured migration globs. Those startup/migration paths are reachable in M2 but their patterns come from trusted code/config, not request bodies. Admin bundling is disabled. M2 exposes no endpoint for caller-selected paths/globs, customer uploads or custom plugins. No request-controlled pattern path was found in these reviewed M2 consumers; this is narrower than proving every built-in Medusa API unreachable.
- **Mitigations/residual risk:** retain fixed server-owned discovery/migration configuration, disabled Admin UI, no untrusted plugin/config loading, customer/Store-write denial, no public deployment or production activation. Do not pass request data into filesystem globs. Code/config compromise or future dynamic plugin/asset functionality can invalidate this analysis. A different glob/DI/ORM major could remove the chain but would require broader API/migration compatibility work, not a safe transitive patch.

## Remaining: sprintf-js — founder security review required

- **Installed:** `sprintf-js@1.0.3`; advisory [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) affects <=1.1.3. Registry latest is 1.1.3; advisory lists no patched release. Upstream tracking: [alexei/sprintf.js#237](https://github.com/alexei/sprintf.js/issues/237).
- **Trigger:** attacker-controlled format strings with unbounded precision reach numeric formatting methods and throw RangeError, aborting the operation. Package remains installed in production dependency closure.
- **Chain/call paths:** MikroORM migrations → Umzug (CLI exports) → `@rushstack/ts-command-line@4.23.7` → nested `argparse@1.0.10` → sprintf-js. Reviewed argparse `lib/argument_parser.js` uses fixed error formats; `lib/help/formatter.js` formats usage/help text supplied by command definitions. Ordinary CLI argument values substitute into those strings; they are not themselves format strings. No M2 HTTP endpoint invokes CLI help or accepts a format string. Importability does not establish remote input reachability.
- **Mitigations/residual risk:** allow only trusted command definitions/help/usage, invoke CLI through fixed argument arrays, no request-driven CLI/format execution. No new remote exploit was demonstrated. A controlled command-definition/config source can still supply a malicious format. Upgrading argparse/Rushstack across majors solely to remove the chain is not assumed API-compatible with the pinned ORM/migration tooling.

## Review decision

**Do not merge on the present audit result.** Founder/security owner must either require upstream-compatible remediation or explicitly review a narrowly scoped, temporary exception for these two advisory IDs and this inert M2 configuration. No exception file, audit filtering, severity suppression or `continue-on-error` has been added. Any exception would need an owner, expiry/review trigger (next relevant patched release or before M1b/expanded runtime input, whichever comes first), and independent approval. Availability/architecture tests do not grant security acceptance.
