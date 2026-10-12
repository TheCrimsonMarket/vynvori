# Execution evidence

Inspect `results/report/summary.json` for current counters, `results/runs/ledger.jsonl` for append-only state transitions, and run manifests for the exact config/model/task snapshot. Run IDs are UUIDs; task IDs are deterministic experiment/case/model/operation hashes. Prompt and reference checksums link artifacts to their inputs. A request ID is retained when returned; otherwise the internal correlation ID is explicitly internal.

Environment: Windows PowerShell; Node 22.23.3; npm 10.9.9. Verified npm package versions: TypeScript 7.0.2, tsx 4.23.15, sharp 0.35.5, Node types 22.19.15. AI SDK 7.0.137 and Workflow 5.2.0 were checked, not installed. The package lock records integrity hashes.

Commands executed: public research snapshot, dependency installation, typecheck, mocked-provider tests, dry-run, read-only key verification, live smoke, one confirmed-zero-charge 429 retry, remaining concepts, explicit Google replacement registration. Follow-up stage status is recorded in the ledger rather than assumed here. Final contact-sheet/report generation and handoff packaging are reproducible scripts.

Known incident: `google/gemini-nano-banana-2.1` returned HTTP 429 twice. No image was received. Provider key usage matched successful requests; these rejections are retained with zero charge. No opaque server failure, timeout or missing billing response is blindly retried. `data/google-replacement-amendment.json` records replacement rationale and identity.

Dry runs exercise fixtures, hashing, capabilities and export without network generation. Tests include duplicate-charge prevention, unknown-request stopping, caps, missing billing, durable failure accounting, fal queue request-ID persistence, unsupported settings, native PPI and two-reviewer score gates. Validation command outputs are included in `environment.md` when packaging.
