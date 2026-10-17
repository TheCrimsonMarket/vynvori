import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { digest, sha256, snapshot, resolveLock } from "./audit-policy.mjs";

export const REVIEWED_HEAD = "b99197ad814d7bffde402e4ee5fde3d18b260f06";
export const POLICY_PATH = "security/pr5-local-preparation-policy.json";
// The implementation commit is sealed first. Activation can change ONLY the two
// literal selectors in its runner template and add the anchored policy JSON.
export const IMPLEMENTATION_PATHS = [
  ".github/workflows/m0.yml", "scripts/security/run-audit.mjs",
  "scripts/security/pr5-local-policy.mjs", "scripts/security/pr5-image-inventory.mjs",
  "scripts/security/pr5-runtime-check.mjs", "scripts/tests/pr5-local-policy.test.mjs",
  "security/fixtures/pr5-reviewed-audits.json", "security/fixtures/pr5-reviewed-runtime.json",
  "docs/implementation/PR5-local-preparation-acceptance.md",
  "docs/implementation/PR5-security-review-dossier.md", "docs/implementation/M2-Cloud-Run-readiness.md",
].sort();
const check = (condition, code) => { if (!condition) throw new Error(code); };
const equal = (a, b) => digest(a) === digest(b);
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
const blob = (root, commit, file) => execFileSync("git", ["show", `${commit}:${file}`], { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });

export function auditIdentity(audit) {
  check(audit?.auditReportVersion === 2 && audit.metadata?.dependencies && audit.vulnerabilities && !audit.error, "AUDIT_INCOMPLETE");
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  const graph = {};
  for (const [name, entry] of Object.entries(audit.vulnerabilities).sort()) {
    check(entry.name === name && Object.hasOwn(counts, entry.severity) && entry.severity !== "total" &&
      Array.isArray(entry.nodes) && entry.nodes.length && Array.isArray(entry.via) && entry.via.length && Array.isArray(entry.effects), "AUDIT_RECORD_INVALID");
    counts[entry.severity]++; counts.total++;
    graph[name] = { ...entry, nodes: [...entry.nodes].sort(), effects: [...entry.effects].sort(), via: [...entry.via].sort((a, b) => digest(a).localeCompare(digest(b))) };
  }
  check(equal(counts, audit.metadata.vulnerabilities), "AUDIT_COUNTS_INVALID");
  return { counts, graph };
}

export function scanIdentity(report) {
  check(report?.SchemaVersion === 2 && report.Trivy?.Version === "0.75.0" && report.Metadata?.OS?.Family === "debian" && report.Metadata.OS.Name === "13.7", "SCAN_FORMAT_OR_OS_CHANGED");
  const groups = report.Results.map(result => {
    check(["os-pkgs", "lang-pkgs"].includes(result.Class) && ["debian", "node-pkg"].includes(result.Type), "UNEXPECTED_SCAN_TARGET");
    return { class: result.Class, type: result.Type,
      packages: (result.Packages ?? []).map(p => ({ name: p.Name, version: p.Version, path: p.FilePath ?? null, source: p.SrcName ?? null, sourceVersion: p.SrcVersion ?? null })).sort((a, b) => digest(a).localeCompare(digest(b))),
      findings: (result.Vulnerabilities ?? []).map(value => {
        // These Trivy occurrence identifiers change with archive/image metadata.
        // All advisory fields, versions, severity, status, references and dates stay pinned.
        const entry = structuredClone(value); delete entry.Layer; delete entry.Fingerprint;
        if (entry.PkgIdentifier) delete entry.PkgIdentifier.UID;
        if (entry.References) entry.References.sort();
        return entry;
      }).sort((a, b) => digest(a).localeCompare(digest(b))),
    };
  }).sort((a, b) => a.class.localeCompare(b.class));
  check(groups.length === 2, "SCAN_TARGETS_INCOMPLETE");
  return groups;
}

export function configurationIdentity(config) {
  return Object.fromEntries(["User", "Entrypoint", "Cmd", "WorkingDir", "ExposedPorts", "Volumes", "Healthcheck", "StopSignal"].map(key => [key, config[key] ?? null]).concat([["Env", [...config.Env].sort()]]));
}

export function contextAllowed(env) {
  check(env.PR5_SECURITY_SCOPE === "local-synthetic-only", "LOCAL_SYNTHETIC_SCOPE_REQUIRED");
  check(!env.M2_ENV || env.M2_ENV === "local", "NONLOCAL_ENVIRONMENT");
  check(!env.K_SERVICE && !env.CLOUD_RUN_JOB && !env.CLOUD_RUN_EXECUTION && env.VERCEL !== "1" && !["preview", "production"].includes(env.VERCEL_ENV) && env.NODE_ENV !== "production", "REMOTE_OR_PRODUCTION_CONTEXT");
  if (env.DOCKER_HOST) check(/^(?:unix|npipe):\/\//.test(env.DOCKER_HOST), "REMOTE_DOCKER_ENGINE_FORBIDDEN");
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("VYNVORI_") && value !== undefined) check(value === "false", "OPERATIONAL_FEATURE_ENABLED");
    if (/^M2_.*(?:ORIGIN|DATABASE_URL)$/.test(key) && value) {
      let url; try { url = new URL(value); } catch { throw new Error("INVALID_INTEGRATION_ENVIRONMENT"); }
      check(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "REMOTE_DEPENDENCY_CONFIGURED");
    }
    if (/^(?:STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|GOOGLE_APPLICATION_CREDENTIALS|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|OPENAI_API_KEY|GEMINI_API_KEY|M2_MEDUSA_JWT_SECRET|M2_MEDUSA_COOKIE_SECRET|M2_R2_ACCESS_KEY_ID|M2_R2_SECRET_ACCESS_KEY)$/.test(key) && value) throw new Error("REAL_OR_UNREVIEWED_CREDENTIAL_CONTEXT");
  }
}

export async function collectLocalState(root, implementationCommit, policyDigest, policy, legacyPolicy) {
  check(/^[a-f0-9]{40}$/.test(implementationCommit) && /^[a-f0-9]{64}$/.test(policyDigest), "LOCAL_POLICY_NOT_ACTIVATED");
  check(digest(policy) === policyDigest && policy.implementationCommit === implementationCommit && policy.reviewedHead === REVIEWED_HEAD, "LOCAL_POLICY_FINGERPRINT_MISMATCH");
  check(git(root, ["rev-parse", `${implementationCommit}^`]) === REVIEWED_HEAD, "IMPLEMENTATION_PARENT_CHANGED");
  check(equal(git(root, ["diff", "--name-only", REVIEWED_HEAD, implementationCommit]).split("\n").sort(), IMPLEMENTATION_PATHS), "UNAUTHORIZED_IMPLEMENTATION_DELTA");
  const modified = git(root, ["diff", "--name-only", implementationCommit, "HEAD"]).split("\n").sort();
  check(equal(modified, [POLICY_PATH, "scripts/security/run-audit.mjs"].sort()), "UNAUTHORIZED_ACTIVATION_DELTA");
  check(!git(root, ["status", "--porcelain", "--untracked-files=all"]), "UNCOMMITTED_SECURITY_BOUNDARY");
  const template = blob(root, implementationCommit, "scripts/security/run-audit.mjs");
  const expectedRunner = template.replace('PR5_IMPLEMENTATION_COMMIT = "UNACTIVATED"', `PR5_IMPLEMENTATION_COMMIT = "${implementationCommit}"`)
    .replace('PR5_POLICY_DIGEST = "UNACTIVATED"', `PR5_POLICY_DIGEST = "${policyDigest}"`);
  check((await fs.readFile(path.join(root, "scripts/security/run-audit.mjs"), "utf8")).replaceAll("\r\n", "\n") === expectedRunner, "ACTIVATION_RUNNER_CHANGED");
  const auditBytes = blob(root, implementationCommit, "security/fixtures/pr5-reviewed-audits.json");
  const runtimeBytes = blob(root, implementationCommit, "security/fixtures/pr5-reviewed-runtime.json");
  check(policy.auditFixtureSha256 === sha256(auditBytes) && policy.runtimeFixtureSha256 === sha256(runtimeBytes), "REVIEWED_EVIDENCE_CHANGED");
  const reviewed = JSON.parse(auditBytes);
  const runtime = JSON.parse(runtimeBytes);
  const osPairs = runtime.scan.find(group => group.class === "os-pkgs").findings.map(v => ({ id: v.VulnerabilityID, name: v.PkgName, version: v.InstalledVersion, severity: v.Severity }));
  check(osPairs.length === 31 && osPairs.every(v => ["MEDIUM", "LOW"].includes(v.severity)) && equal(osPairs, policy.osFindings), "OS_APPROVAL_SCOPE_CHANGED");
  const state = await snapshot(root, legacyPolicy);
  const expectedEdges = [];
  for (const [parent, record] of Object.entries(state.lock.packages)) {
    if (record.link) continue;
    for (const kind of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) for (const [name, spec] of Object.entries(record[kind] ?? {})) {
      const child = resolveLock(state.lock.packages, parent, name);
      if (child) expectedEdges.push({ parent, child, name, spec, kind });
    }
  }
  const nodes = new Set(policy.advisories.flatMap(item => item.nodes));
  let more = true;
  while (more) { more = false; for (const edge of expectedEdges) if (nodes.has(edge.child) && !nodes.has(edge.parent)) { nodes.add(edge.parent); more = true; } }
  const edges = expectedEdges.filter(edge => nodes.has(edge.child));
  const installed = {};
  for (const location of nodes) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, location, "package.json"), "utf8"));
    const expected = state.lock.packages[location];
    check(expected && manifest.version === expected.version, "INSTALLED_VERSION_CHANGED");
    for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) check(equal(manifest[key] ?? {}, expected[key] ?? {}), "INSTALLED_ANCESTRY_CHANGED");
    installed[location] = { version: manifest.version, name: manifest.name };
  }
  for (const edge of edges) {
    let location = edge.parent, actual;
    while (true) {
      try { actual = path.relative(root, await fs.realpath(path.join(root, location, "node_modules", edge.name))).split(path.sep).join("/"); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!location) break;
      location = path.posix.dirname(location); if (location === ".") location = "";
    }
    check(actual === edge.child, "DEPENDENCY_RESOLUTION_CHANGED");
  }
  const commit = git(root, ["rev-parse", "HEAD"]), tree = git(root, ["rev-parse", "HEAD^{tree}"]);
  // No commit hashes itself: I is frozen first; the activation commit is checked
  // as I + exactly rendered selectors + anchored JSON. Merge metadata may differ.
  return { lockSha256: state.lockSha256, manifests: state.manifests, installed, edges, reviewed, runtime,
    commit, tree, implementationCommit, implementationTree: git(root, ["rev-parse", `${implementationCommit}^{tree}`]),
    boundaryVerified: true, rootConfiguration: state.rootConfiguration, legacyState: state };
}

export function validateLocalInputs({ policy, policyDigest, implementationCommit, state, production, all, now = new Date(), env = {} }) {
    check(digest(policy) === policyDigest, "LOCAL_POLICY_FINGERPRINT_MISMATCH");
    check(policy.schemaVersion === 1 && policy.authority === "VYNVORI founder" && policy.approvedOn === "2026-10-17" && policy.reviewedHead === REVIEWED_HEAD &&
      policy.implementationCommit === implementationCommit && policy.scope === "synthetic-only-local-PR5-preparation" && policy.remoteExecutionApproved === false && policy.expiresAt === "2026-11-15T23:59:59Z", "LOCAL_APPROVAL_METADATA_CHANGED");
    check(equal(policy.advisories, [
      { ghsa: "GHSA-vfj7-8cjw-p6xm", name: "braces", version: "3.0.3", nodes: ["node_modules/braces"], context: "trusted-local-runtime-discovery-only" },
      { ghsa: "GHSA-hp3w-g68c-fv3c", name: "sprintf-js", version: "1.0.3", nodes: ["node_modules/sprintf-js"], context: "fixed-native-cli-only" },
      { ghsa: "GHSA-67mh-4wv8-2f99", name: "esbuild", version: "0.18.20", nodes: ["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"], context: "non-public-build-test-only-no-dev-server" },
    ]), "ADVISORY_ACCEPTANCE_SCOPE_CHANGED");
    check(Number.isFinite(now.getTime()) && now >= new Date("2026-10-16T18:00:00Z") && now < new Date(policy.expiresAt), "LOCAL_APPROVAL_EXPIRED");
    contextAllowed(env);
    check(state.boundaryVerified && /^[a-f0-9]{40}$/.test(state.commit) && /^[a-f0-9]{40}$/.test(state.tree), "SECURITY_BOUNDARY_UNVERIFIED");
    check(state.lockSha256 === policy.lockSha256 && equal(state.manifests, policy.manifests), "LOCAL_DEPENDENCY_FINGERPRINT_CHANGED");
    check(equal(state.edges, policy.ancestryEdges), "LOCAL_DEPENDENCY_ANCESTRY_CHANGED");
    check(equal(state.rootConfiguration, policy.rootConfiguration), "UNREVIEWED_NPM_CONFIGURATION");
    for (const item of policy.advisories) for (const node of item.nodes) check(state.installed[node]?.version === item.version && state.installed[node]?.name === item.name, "UNAPPROVED_INSTALLED_ADVISORY_PATH");
    for (const [key, value] of Object.entries(env)) {
      if (key.toLowerCase() === "npm_config_registry" && value) check(["https://registry.npmjs.org/", "https://registry.npmjs.org"].includes(value), "UNREVIEWED_AUDIT_REGISTRY");
      if (["npm_config_workspace", "npm_config_workspaces"].includes(key.toLowerCase()) && value !== undefined) check(key.toLowerCase() === "npm_config_workspaces" && value === "true", "PARTIAL_WORKSPACE_AUDIT");
    }
    for (const [name, result] of [["production", production], ["all", all]]) {
      check(result && !result.executionError && !result.signal && result.exitCode === 1, "AUDIT_EXECUTION_OR_EXIT_CHANGED");
      let audit; try { audit = JSON.parse(result.stdout); } catch { throw new Error("AUDIT_JSON_INVALID"); }
      check(equal(auditIdentity(audit), state.reviewed[name]), "LOCAL_AUDIT_ADVISORY_OR_GRAPH_CHANGED");
    }
}

export function evaluateLocal(input) {
  try {
    validateLocalInputs(input);
    const { policy, state, production, all, image, implementationCommit } = input;
    check(image && equal(image.inventory, state.runtime.inventory), "RUNTIME_FILES_OR_BINARY_CHANGED");
    check(image.localEngineVerified === true, "REMOTE_DOCKER_ENGINE_FORBIDDEN");
    check(image.database && new Date(image.database.UpdatedAt) <= (input.now ?? new Date()) && new Date(image.database.NextUpdate) > (input.now ?? new Date()), "VULNERABILITY_DATABASE_STALE");
    check(equal(image.configuration, state.runtime.configuration), "RUNTIME_CONFIGURATION_CHANGED");
    check(equal(image.baseLayers, state.runtime.baseLayers), "RUNTIME_BASE_CHANGED");
    check(equal(image.scan, state.runtime.scan), "RUNTIME_ADVISORY_OR_PACKAGE_CHANGED");
    check(/^[a-f0-9]{64}$/.test(image.archiveSha256) && image.imageId?.startsWith("sha256:"), "RUNTIME_EVIDENCE_INCOMPLETE");
    return { accepted: true, status: "ACCEPTED_WITH_FOUNDER_LOCAL_PR5_EXCEPTION", scope: policy.scope, remoteExecutionApproved: false,
      expiresAt: policy.expiresAt, counts: state.reviewed.production.counts, allDependencyCounts: state.reviewed.all.counts,
      osFindingPairs: 31, originalAuditExitCode: production.exitCode, allDependencyAuditExitCode: all.exitCode,
      sourceCommit: state.commit, sourceTree: state.tree, implementationCommit, observedImageId: image.imageId, archiveSha256: image.archiveSha256 };
  } catch (error) { return { accepted: false, status: "REJECTED", code: error.message }; }
}
