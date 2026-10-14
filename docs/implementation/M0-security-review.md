# M0 security review

Scope: new web shell/configuration/health/CI only. No customer auth, sessions, object IDs, uploads, private customer art, persistence, cart, wallet, payments, providers or manufacturing API. Therefore later ownership, financial idempotency, event replay and cross-system security acceptance remains NOT_RUN/BLOCKED.

## Controls

- React renders static, trusted source content; no raw HTML injection or user input sink.
- `@vynvori/shared/server` is marked `server-only`; the public module contains no environment reads. Build/startup validation fails closed. Errors include configuration key names only, never their values.
- Public flags are immutable false. No operational handler exists, so client tampering cannot authorize an operation. Unavailable actions use disabled native buttons with explanatory text.
- Health responds only with process liveness, no-store, no versions, secrets, internal status or downstream claims.
- Self-only CSP, no frames/objects/form submission, nosniff, no-referrer and disabled camera/microphone/geolocation. Next hydration/local styles currently require inline allowances; stronger nonce/hash CSP is deferred to a future release review.
- No telemetry/analytics/provider integration. The launcher disables Next telemetry. Browser harness blocks nonlocal requests and records attempted requests, missing assets and runtime errors.
- CI has read-only repository permissions, installs from lockfile, and uses no production secrets/providers. Separate Chromium/axe evidence runs in a local server context.
- Logos/canonical/reference bytes are sealed. Font/OFL/metadata stay together; copied asset integrity is checked. Illustrative artwork remains internal-only. noindex is not a privacy boundary; no public deployment is authorized.

## Dependency findings

Registry audit on 2026-10-14 reports **five high-severity development-only findings**, one transitive root cause: `braces <=3.0.3` stack-exhaustion DoS, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). The chain is `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces`. The registry's newest braces is 3.0.3; 3.0.4 returned E404. npm suggests downgrading the Next lint config to 14.2.35, which is not an appropriate automated framework fix.

Exposure here: developer/CI linting of trusted repository paths; no network-supplied glob patterns or application runtime path to braces. A malicious repository change can still disrupt a lint process. Keep CI timeout bounded and review untrusted contributions. Track the upstream patch and update/reverify this chain when available. This is an unresolved tooling finding, not a clean full audit claim.

ESLint 10.12.0 was checked against current registry plugin peers. React 7.37.5, import 2.32.0 and jsx-a11y 6.10.2 declare support through ESLint 9, so M0 pins 9.39.5. Its registry deprecation is another maintenance limitation; migrate when peer support is published. Do not force unsupported peer overrides.

## Evidence and limits

See M0.md for executed unit/browser/config/source checks. The smoke scanner checks common private-key/AWS/GitHub credential patterns and source module boundaries; it is not a comprehensive secret scanner or penetration test. Financial, SSO, Medusa, Neon, R2, manufacturing, legal rights and customer-data security remain untested and disabled. M1a must inspect actual LuckyLittleDevil source before any auth bridge is built.
