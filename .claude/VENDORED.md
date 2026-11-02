# Vendored ECC subset

Source: [affaan-m/ECC](https://github.com/affaan-m/ECC) at commit `b38be6a7f6350964d59328b52f0624e1d1d552d1` (2026-10-29), plugin version 2.2.3. MIT licensed; see [`ECC-LICENSE`](ECC-LICENSE).

## Why this exists

Cloud sessions (claude.ai/code, including parallel worker sessions started by an orchestrator session) do **not** install plugins declared in `.claude/settings.json`. They do load the repository's own `.claude/skills/`, `.claude/commands/`, `.claude/agents/` and `.claude/workflows/`. This subset makes the milestone workflow (prompt-optimizer → blueprint → plan-orchestrate → `orch-*` → review) available in cloud sessions.

`settings.json` still enables the full `ecc@ecc` plugin for local sessions. Locally, the plugin copies are namespaced (`ecc:blueprint`) and the vendored copies are not (`blueprint`); both resolve to the same pinned content as long as the plugin is on this commit.

## Contents

Only Markdown instructions and one Workflow orchestration script. No hooks, rules, MCP configs, install scripts, npm packages or executables were vendored.

| Kind | Items |
|---|---|
| Skills (14) | blueprint, bun-runtime, council, orch-add-feature, orch-build-mvp, orch-change-feature, orch-fix-defect, orch-pipeline, orch-refine-code, plan-canvas, plan-orchestrate, prompt-optimizer, security-review, tdd-workflow |
| Commands (11) | build-fix, code-review, orch-add-feature, orch-build-mvp, orch-change-feature, orch-fix-defect, orch-refine-code, orch-review, plan, test-coverage, update-docs |
| Agents (12) | build-error-resolver, code-architect, code-explorer, code-reviewer, gan-evaluator, gan-generator, gan-planner, react-reviewer, refactor-cleaner, security-reviewer, tdd-guide, typescript-reviewer |
| Workflows (1) | orch-review.workflow.js |

The set is the dependency closure of the four entry skills (prompt-optimizer, blueprint, plan-orchestrate, council), the commands plan-orchestrate emits, and the agents those commands, `orch-pipeline` and `orch-review` dispatch, limited to languages present in this repository (TypeScript/React).

## Local modifications

1. `commands/orch-review.md`: workflow path `workflows/orch-review.workflow.js` → `.claude/workflows/orch-review.workflow.js`.
2. `workflows/orch-review.workflow.js`: agent types `ecc:<name>` → `<name>` (project agents are not plugin-namespaced).
3. `skills/security-scan/` and `commands/security-scan.md` **removed**. They instruct running the unpinned third-party npm package `ecc-agentshield` (including a global install and exporting `ANTHROPIC_API_KEY`), which conflicts with this repository's pinned supply-chain policy.

## Repository override: security steps

`plan-orchestrate` routes `security`-tagged steps to `/security-scan` and marks them fail-closed. In this repository, run instead: `npm run smoke:security`, `npm run security:audit`, the `security-review` skill checklist and the `security-reviewer` agent on the diff, and record findings in the PR's security review notes as `AGENTS.md` requires.

## Known gaps (intentional)

- ECC's 27 hooks are **not** vendored. They run Node on every tool call; adopting them is a separate security decision.
- Language reviewers other than TypeScript/React (go, rust, python, …) are absent. If `orch-review` is called with such a language, that dimension fails and the workflow reports `incomplete` / `CHANGES_REQUESTED` (fails closed).
- `gan-evaluator` lists Playwright MCP tools; no Playwright MCP server is configured, so browser evaluation in `/orch-build-mvp` is unavailable.
- Commands only mentioned as alternatives (`/feature-dev`, `/review-pr`, `/gan-build`, `/loop-start`, `/save-session`, `/prp-*`, …) are not vendored; plan-orchestrate already fails closed for commands it cannot emit.
- `refactor-cleaner` and `build-error-resolver` suggest `npx knip` / `depcheck` / `ts-prune`; those tools are not in this repository's lockfile, so `npx` would download unpinned packages. Prefer the repository's `npm run lint` / `npm run typecheck`, and do not add new tools without a dependency PR.
- `/code-review` here shadows the built-in `code-review` skill in sessions that load this directory.

## Updating

Re-copy the same paths from a newer reviewed ECC commit, reapply the three modifications above, update the commit SHA here, and review the diff like any other third-party code. Do not vendor hooks or scripts without a separate security review.
