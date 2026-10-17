import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startProcess, stopProcess } from "../process-lifecycle.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { evaluate, snapshot, digest, sha256, validatePolicy } from "./audit-policy.mjs";
import { collectLocalState, evaluateLocal, validateLocalInputs, contextAllowed, POLICY_PATH } from "./pr5-local-policy.mjs";
import { verifyLocalImage } from "./pr5-runtime-check.mjs";

// Rendered only in the separately committed activation step; never by this runner.
export const PR5_IMPLEMENTATION_COMMIT = "cf6f55100eecab0f1c3cd4ba7e476d0b7a2e0bc5";
export const PR5_POLICY_DIGEST = "73b3682b822a638bc0f318a1dd35fa9be381adba5536f29618d9be765bd52a10";

const root = fileURLToPath(new URL("../..", import.meta.url));
const policyPath = path.join(root, "security/m2-exception-policy.json");
const MAX_BYTES = 16 * 1024 * 1024;
const exec = promisify(execFile);

export function safeEvidence(text, env) {
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bAKIA[A-Z0-9]{16}\b|[a-z]+:\/\/[^/\s"]+:[^@\s"]+@/i.test(text)) return false;
  return !Object.entries(env).some(([key, value]) => /TOKEN|PASSWORD|SECRET|AUTH_KEY/i.test(key) && typeof value === "string" && value.length >= 8 && text.includes(value));
}

/** Diagnostic parsing is independent of acceptance, so rejected new advisories remain visible. */
export function summarizeAudit(stdout, state) {
  try {
    const audit = JSON.parse(stdout);
    const records = Object.entries(audit.vulnerabilities ?? {}).map(([name, record]) => ({
      name, severity: record.severity,
      nodes: Array.isArray(record.nodes) ? record.nodes.map(node => ({ path: node, installedVersion: state?.installed?.[node]?.version ?? null })) : null,
      originatingGhsas: Array.isArray(record.via) ? record.via.filter(value => value && typeof value === "object").map(value => ({
        ghsa: /^https:\/\/github\.com\/advisories\/(GHSA-[a-z0-9-]+)$/.exec(value.url)?.[1] ?? null,
        package: value.name, range: value.range,
      })) : null,
    }));
    return { parsed: true, totals: audit.metadata?.vulnerabilities ?? null, records };
  } catch { return { parsed: false, totals: null, records: [] }; }
}

async function runAudit(productionOnly = true) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !path.isAbsolute(npmCli) || !npmCli.endsWith("npm-cli.js")) throw new Error("RUN_THROUGH_NPM");
  const registry = await exec(process.execPath, [npmCli, "config", "get", "registry"], { cwd: root, timeout: 10000, maxBuffer: 4096, windowsHide: true });
  if (!["https://registry.npmjs.org/", "https://registry.npmjs.org"].includes(registry.stdout.trim())) throw new Error("UNREVIEWED_AUDIT_REGISTRY");
  const handle = startProcess(process.execPath, [npmCli, "audit", ...(productionOnly ? ["--omit=dev"] : []), "--json"], { cwd: root, env: process.env });
  let stdout = "", stderr = "", exceeded = false;
  const capture = which => bytes => {
    if (stdout.length + stderr.length + bytes.length > MAX_BYTES) { exceeded = true; return; }
    if (which === "stdout") stdout += bytes; else stderr += bytes;
  };
  handle.child.stdout.on("data", capture("stdout"));
  handle.child.stderr.on("data", capture("stderr"));
  let timer;
  let executionError = false;
  try {
    const finished = await Promise.race([handle.completion.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 120000); })]);
    executionError = !finished || exceeded || Boolean(handle.error);
  } finally {
    clearTimeout(timer);
    await stopProcess(handle, { graceMs: 1000, killMs: 3000 });
  }
  return { stdout, stderr, exitCode: handle.result?.code ?? null, signal: handle.result?.signal ?? null, executionError };
}

async function main() {
  const requested = process.env.SECURITY_AUDIT_EVIDENCE_DIR;
  const evidence = requested ? path.resolve(requested) : await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-M2-security-"));
  const relative = path.relative(root, evidence);
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) throw new Error("Evidence must be outside the source checkout");
  if (requested) await fs.mkdir(evidence); // Refuse to overwrite an earlier run.
  const startedAt = new Date().toISOString();
  let audit = { stdout: "", stderr: "", exitCode: null, signal: null, executionError: true };
  let result;
  let policy;
  let state;
  let historicalResult, localPolicy, localState, image;
  let allAudit = { stdout: "", stderr: "", exitCode: null, signal: null, executionError: true };
  // Always attempt the full unfiltered audit before checking the exception fingerprint.
  try { audit = await runAudit(); } catch { result = { accepted: false, status: "REJECTED", code: "AUDIT_EXECUTION_FAILURE" }; }
  try { allAudit = await runAudit(false); } catch { /* Recorded as a failed full audit; never except execution errors. */ }
  try {
    policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
    validatePolicy(policy);
    state = await snapshot(root, policy);
    result ??= evaluate({ ...audit, policy, state, now: new Date(), env: process.env });
    historicalResult = result;
    if (!result.accepted) {
      // No supplied snapshot, image/report override, automatic policy rewrite or
      // historical-state substitution is accepted by the production command.
      localPolicy = JSON.parse(await fs.readFile(path.join(root, POLICY_PATH), "utf8"));
      contextAllowed(process.env);
      localState = await collectLocalState(root, PR5_IMPLEMENTATION_COMMIT, PR5_POLICY_DIGEST, localPolicy, policy);
      // Expiry/graph checks precede any container execution as well as final evaluation.
      validateLocalInputs({ policy: localPolicy, policyDigest: PR5_POLICY_DIGEST, implementationCommit: PR5_IMPLEMENTATION_COMMIT,
        state: localState, production: audit, all: allAudit, env: process.env });
      image = await verifyLocalImage(root, evidence, localState.runtime);
      result = evaluateLocal({ policy: localPolicy, policyDigest: PR5_POLICY_DIGEST, implementationCommit: PR5_IMPLEMENTATION_COMMIT,
        state: localState, production: audit, all: allAudit, image, env: process.env });
    }
  } catch (error) { result = { accepted: false, status: "REJECTED", code: error.message }; }
  const raw = { stdout: audit.stdout, stderr: audit.stderr, allStdout: allAudit.stdout, allStderr: allAudit.stderr };
  // A protected local copy preserves execution-error evidence. Only scanned output is publishable.
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-audit-private-"));
  await fs.writeFile(path.join(privateDir, "raw-output.json"), JSON.stringify(raw), { mode: 0o600 });
  const clean = safeEvidence(audit.stdout + audit.stderr + allAudit.stdout + allAudit.stderr, process.env);
  await fs.writeFile(path.join(evidence, "raw-audit.json"), clean ? audit.stdout : JSON.stringify({ redacted: true, reason: "POTENTIAL_CREDENTIAL", sha256: sha256(audit.stdout) }));
  await fs.writeFile(path.join(evidence, "audit-stderr.txt"), clean ? audit.stderr : "REDACTED: potential credential in command output\n");
  await fs.writeFile(path.join(evidence, "all-dependencies-audit.json"), clean ? allAudit.stdout : JSON.stringify({ redacted: true, sha256: sha256(allAudit.stdout) }));
  await fs.writeFile(path.join(evidence, "all-dependencies-audit-stderr.txt"), clean ? allAudit.stderr : "REDACTED\n");
  if (!clean) result = { accepted: false, status: "REJECTED", code: "UNSAFE_AUDIT_EVIDENCE" };
  const report = {
    startedAt, completedAt: new Date().toISOString(), command: "npm audit --omit=dev --json", originalAuditExitCode: audit.exitCode,
    signal: audit.signal, executionError: audit.executionError, stdoutSha256: sha256(audit.stdout), outputRedacted: !clean,
    policySha256: policy ? digest(policy) : null, lockSha256: state?.lockSha256 ?? null,
    manifestFingerprints: state?.manifests ?? null, securitySurfaceSha256: state ? digest(state.surface) : null,
    ancestrySha256: state ? digest(state.edges) : null, result,
    auditSummary: clean ? summarizeAudit(audit.stdout, state) : null,
    historicalResult, allDependencyAudit: { originalExitCode: allAudit.exitCode, executionError: allAudit.executionError,
      signal: allAudit.signal, stdoutSha256: sha256(allAudit.stdout), summary: clean ? summarizeAudit(allAudit.stdout, localState ? { installed: localState.installed } : state) : null },
    localApproval: localPolicy ? { policySha256: digest(localPolicy), implementationCommit: PR5_IMPLEMENTATION_COMMIT,
      sourceCommit: localState?.commit, sourceTree: localState?.tree, imageId: image?.imageId, archiveSha256: image?.archiveSha256 } : null,
  };
  await fs.writeFile(path.join(evidence, "evaluation.json"), JSON.stringify(report, null, 2) + "\n");
  if (policy) await fs.writeFile(path.join(evidence, "policy.json"), JSON.stringify(policy, null, 2) + "\n");
  if (localPolicy) await fs.writeFile(path.join(evidence, "pr5-local-policy.json"), JSON.stringify(localPolicy, null, 2) + "\n");
  console.log(`Original unfiltered npm audit exit=${audit.exitCode}; findings=${result.counts?.total ?? "unavailable"}; effective security gate=${result.status}${result.code ? ` (${result.code})` : ""}`);
  console.log(`Security evidence: ${evidence}`);
  if (!result.accepted) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Security audit runner failed closed before evidence could be finalized."); process.exitCode = 1; });
}
