# 02 — Repository evolution and local development

## Verified existing repository (as inspected via GitHub connector)

The current root includes `.env.example`, `.gitignore`, `package.json`, `package-lock.json`, `docs/Vynvori_AI_Model_Benchmark_Execution_Blueprint.pdf`, and `packages/ai-benchmark/`. The root package is `vynvori-benchmark-workspace`, `private: true`, npm workspace `packages/ai-benchmark`, root scripts `typecheck`, `test`, and `benchmark`. The benchmark has source under `src/`, adapters including `openrouter.ts` and `fal.ts`, research/fixtures, scenario economics, docs and tests. Node engine reports `>=22.23.0`. **Do not overwrite these.**

## Target structure (incremental)

```text
vynvori/
  AGENTS.md
  apps/
    web/                   Next.js App Router
    medusa/                dedicated Medusa v2 service
  packages/
    ai-benchmark/          existing, preserved
    ai/                    production provider registry and workflows
    auth-bridge/           org SSO integration contracts, no copied secrets
    commerce/              typed Medusa API contracts/BFF client
    db/                    Drizzle schema, migrations, repositories
    garment-editor/        React-Konva editor, pure scene schema
    print-contracts/       print profiles, geometry and artifact manifests
    shared/                schemas, errors, IDs, permissions and events
    config/                lint, tsconfig, CI shared config if needed
  services/
    image-processing/      Cloud Run image/DTF production renderer
  docs/technical/...
  .github/workflows/...
```

Do not convert npm to pnpm or add Turbo automatically. Expand npm workspaces to include `apps/*`, `packages/*`, and `services/*` as appropriate; audit Medusa Cloud's build/workspace behavior against the actual installed version. Define per-app builds, no circular package dependency, explicit public/private env var boundaries. Preserve benchmark CLI aliases and tests. If root Node engine versions conflict with Medusa version, document tested resolution; no blind forced upgrade.

## Development scripts (target semantics)

`npm run dev:web`, `npm run dev:medusa`, `npm run dev:worker`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run test:integration`, `npm run e2e`, `npm run db:generate`, `npm run db:migrate`, `npm run build:web`, `npm run build:medusa`. Actual scripts to be verified in app package manifests.

## Environments

- Local: scoped `.env.local`/secret manager; local Medusa+Postgres or project-provided dev endpoint; Neon dev branch; local R2 test bucket/emulator; Cloud Run local container; mocked centralized identity where real dev authority unavailable.
- Staging: separate Medusa environment + database, Neon branch, R2 prefix/bucket, Cloud Run service and organization auth test tenant/client, payment sandbox, synthetic user profiles.
- Production: isolated Medusa Cloud project, Neon production, locked R2 access, Cloud Run protected, approved origin/domain, real provider billing caps.

## Git/CI

Feature branches → PR → dependency-aware npm install with locked versions → formatting/lint → typecheck → unit → mocked integration → schema generation diff check → container build → targeted E2E for changed domains → approvals → staged deployments. No direct production schema push; commit reviewed Drizzle migrations and Medusa-native migrations separately. Snapshot DB backup before irreversible upgrades.

## Initial repository tasks

1. Record repo HEAD and baseline successful benchmark scripts.
2. Add docs overlay via PR; don't commit generated samples/secrets.
3. Scaffold workspace/app packages with minimal health routes only.
4. Add typed environment parser and feature flags.
5. Establish CI and independent app deployments.
6. Complete central auth repo audit before bridging customers.

## Protected workspace and review artifact boundary (v1.1)

`Phase 6C` candidate files and `.patch` outputs are review artifacts, not instructions to overwrite the current repository. Protected `packages/ai-benchmark`, logos, source designs and ignored `output/` must remain unchanged. Any later code-modifying agent must check `git rev-parse HEAD`, compare to the recorded source SHA in review manifest, perform a dry-run patch apply, and stop if the baseline has drifted; no `git clean`/reset or historic rewrite. Chapters `21`–`25` were added under the founder-authorized local documentation operation. Commit/push and implementation require separate approval; the new ignored `output/phase-06c-application-review/` contains application evidence. Do not treat ignored Phase 05 release contents as expendable.
