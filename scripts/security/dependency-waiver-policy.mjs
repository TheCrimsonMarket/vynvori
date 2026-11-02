import fs from "node:fs/promises";
import path from "node:path";
import { digest, sha256 } from "./audit-policy.mjs";

// Founder-approved 2026-11-02 (ADR-0020). Updated only by an explicitly reviewed policy change, never by the runner/tests.
export const WAIVER_POLICY_PATH = "security/dependency-waiver-policy.json";
export const WAIVER_POLICY_SHA256 = "b747a8949f254c3eecd736cc2e45f4dec2dc9ece0f586105ef4122a6eaf1593d";
// Hard ceiling in code: editing the JSON cannot extend the window even if the anchor were also changed carelessly.
export const WAIVER_CEILING = "2026-12-17T23:59:59Z";
const WAIVER_FLOOR = "2026-11-02T00:00:00Z";
const levels = ["info", "low", "moderate", "high", "critical"];
// High and critical advisories are never waivable by this policy.
const WAIVABLE = new Set(["low", "moderate"]);
const CONTEXTS = new Set(["production", "development"]);
const GHSA = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;

const fail = code => { throw new Error(code); };
const check = (condition, code) => { if (!condition) fail(code); };
const rank = severity => levels.indexOf(severity);
const safePath = value => typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes(":") &&
  !path.posix.isAbsolute(value) && !value.split("/").includes("..") && value.startsWith("node_modules/");
const nameAt = location => location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);

export function validateWaiverPolicy(policy) {
  check(digest(policy) === WAIVER_POLICY_SHA256, "WAIVER_POLICY_FINGERPRINT_MISMATCH");
  check(policy.schemaVersion === 1 && policy.id === "dependency-advisory-waiver-v1" && policy.authority === "VYNVORI founder" &&
    policy.approvedOn === "2026-11-02" && policy.notBefore === WAIVER_FLOOR && policy.expiresAt === WAIVER_CEILING &&
    policy.scope === "ci-and-local-audit-gate-only" && policy.deploymentAuthorized === false, "WAIVER_METADATA_MISMATCH");
  check(Array.isArray(policy.waivers) && policy.waivers.length > 0, "WAIVER_SCOPE_INVALID");
  const seen = new Set();
  for (const waiver of policy.waivers) {
    check(GHSA.test(waiver.ghsa) && !seen.has(waiver.ghsa), "WAIVER_SCOPE_INVALID");
    seen.add(waiver.ghsa);
    check(typeof waiver.package === "string" && WAIVABLE.has(waiver.severity) && typeof waiver.range === "string" &&
      typeof waiver.owner === "string" && typeof waiver.rationale === "string" && typeof waiver.recheck === "string", "WAIVER_SCOPE_INVALID");
    check(Array.isArray(waiver.nodes) && waiver.nodes.length > 0 && waiver.nodes.every(node => safePath(node.path) &&
      nameAt(node.path) === waiver.package && typeof node.version === "string" && CONTEXTS.has(node.context)), "WAIVER_SCOPE_INVALID");
  }
}

/** Read-only: verifies every waived node in the lockfile and in the physical install. No fingerprint of unrelated files. */
export async function collectWaiverState(root, policy) {
  const lockBytes = await fs.readFile(path.join(root, "package-lock.json"));
  const lock = JSON.parse(lockBytes);
  check(lock.lockfileVersion === 3 && lock.packages, "LOCK_FORMAT");
  for (const file of [".npmrc", "npm-shrinkwrap.json"]) {
    try { await fs.access(path.join(root, file)); fail("UNREVIEWED_NPM_CONFIGURATION"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const installed = {};
  for (const waiver of policy.waivers) for (const node of waiver.nodes) {
    const record = lock.packages[node.path];
    check(record && !record.link && record.version === node.version && (record.name ?? nameAt(node.path)) === waiver.package, "WAIVED_LOCK_ENTRY_CHANGED");
    check((record.dev === true) === (node.context === "development"), "WAIVED_NODE_CONTEXT_CHANGED");
    const directory = path.join(root, node.path);
    check(!(await fs.lstat(directory)).isSymbolicLink(), "WAIVED_NODE_SYMLINK");
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
    check(manifest.name === waiver.package && manifest.version === node.version, "WAIVED_INSTALLED_PACKAGE_CHANGED");
    installed[node.path] = { name: manifest.name, version: manifest.version, context: node.context };
  }
  return { lockSha256: sha256(lockBytes), lock, installed };
}

function checkEnvironment(env) {
  check(!env.M2_ENV || env.M2_ENV === "local", "NONLOCAL_ENVIRONMENT");
  check(!env.K_SERVICE && env.VERCEL !== "1" && !["preview", "production"].includes(env.VERCEL_ENV), "REMOTE_EXECUTION_CONTEXT");
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "npm_config_registry" && value) check(["https://registry.npmjs.org", "https://registry.npmjs.org/"].includes(value), "UNREVIEWED_AUDIT_REGISTRY");
    if (["npm_config_workspace", "npm_config_workspaces"].includes(key.toLowerCase()) && value !== undefined) check(key.toLowerCase() === "npm_config_workspaces" && value === "true", "PARTIAL_WORKSPACE_AUDIT");
    if (key.startsWith("VYNVORI_") && value !== undefined) check(value === "false", "OPERATIONAL_FEATURE_ENABLED");
  }
}

/** Every record must be a waived origin or propagate only from waived origins; nothing is filtered by severity or count. */
function auditGraph(run, policy, state, contexts) {
  check(!run.executionError && !run.signal && [0, 1].includes(run.exitCode), "AUDIT_EXECUTION_FAILURE");
  let audit;
  try { audit = JSON.parse(run.stdout); } catch { fail("AUDIT_JSON_INVALID"); }
  check(audit && !audit.error, "AUDIT_EXECUTION_FAILURE");
  check(audit.auditReportVersion === 2 && audit.vulnerabilities && typeof audit.vulnerabilities === "object" && !Array.isArray(audit.vulnerabilities) &&
    audit.metadata?.vulnerabilities && audit.metadata?.dependencies, "AUDIT_INCOMPLETE");
  const counts = Object.fromEntries([...levels, "total"].map(level => [level, 0]));
  const graph = Object.create(null);
  const used = new Set();
  for (const [name, record] of Object.entries(audit.vulnerabilities)) {
    check(record?.name === name && levels.includes(record.severity) && typeof record.range === "string" && Array.isArray(record.nodes) &&
      record.nodes.length > 0 && Array.isArray(record.via) && record.via.length > 0 && Array.isArray(record.effects), "ADVISORY_RECORD_INCOMPLETE");
    check(WAIVABLE.has(record.severity), "UNWAIVABLE_SEVERITY");
    for (const node of record.nodes) {
      check(safePath(node) && state.lock.packages[node], "UNREVIEWED_VULNERABLE_PATH");
      if (!contexts.includes("development")) check(state.lock.packages[node].dev !== true, "DEVELOPMENT_NODE_IN_PRODUCTION_AUDIT");
    }
    const via = [], origins = [];
    for (const item of record.via) {
      if (typeof item === "string") {
        check(Object.hasOwn(audit.vulnerabilities, item), "UNMAPPABLE_ADVISORY_REFERENCE");
        via.push(item);
        continue;
      }
      check(item && typeof item.url === "string" && /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/.test(item.url) &&
        typeof item.title === "string" && item.title.length > 0, "UNMAPPABLE_ADVISORY_ORIGIN");
      const ghsa = item.url.split("/").at(-1);
      const waiver = policy.waivers.find(entry => entry.ghsa === ghsa);
      check(waiver, "UNWAIVED_ADVISORY");
      check(name === waiver.package && item.name === name && item.dependency === name && item.severity === waiver.severity &&
        item.range === waiver.range, "ADVISORY_ORIGIN_MISMATCH");
      // A waived package may only be vulnerable at the exact reviewed paths/versions for this audit's contexts.
      for (const node of record.nodes) {
        const reviewed = waiver.nodes.find(entry => entry.path === node);
        check(reviewed && contexts.includes(reviewed.context) && state.installed[node]?.version === reviewed.version, "UNWAIVED_VULNERABLE_NODE");
      }
      origins.push(ghsa);
      used.add(ghsa);
    }
    graph[name] = { severity: record.severity, via, origins: new Set(origins) };
    counts[record.severity]++; counts.total++;
  }
  for (const level of [...levels, "total"]) check(audit.metadata.vulnerabilities[level] === counts[level], "AUDIT_COUNTS_INCOMPLETE");
  check(Number.isInteger(audit.metadata.dependencies.total) && audit.metadata.dependencies.total > 0, "AUDIT_DEPENDENCIES_INCOMPLETE");
  check(run.exitCode === (counts.total ? 1 : 0), "AUDIT_EXIT_STATUS_INCONSISTENT");
  for (let i = 0; i < Object.keys(graph).length; i++) for (const record of Object.values(graph)) for (const v of record.via) for (const id of graph[v].origins) record.origins.add(id);
  const severityOf = Object.fromEntries(policy.waivers.map(waiver => [waiver.ghsa, waiver.severity]));
  for (const record of Object.values(graph)) {
    check(record.origins.size > 0, "UNMAPPABLE_ADVISORY_GRAPH");
    // A propagated record can never be more severe than the waived origins it inherits from.
    check(rank(record.severity) <= Math.max(...[...record.origins].map(id => rank(severityOf[id]))), "ADVISORY_GRAPH_CHANGED");
  }
  return { counts, waiversUsed: [...used].sort() };
}

/** Pure deterministic evaluation; the runner supplies real time, state and both audits. */
export function evaluateWaivers({ policy, state, production, all, now = new Date(), env = {} }) {
  try {
    validateWaiverPolicy(policy);
    check(Number.isFinite(now.getTime()) && now >= new Date(policy.notBefore) && now < new Date(policy.expiresAt) && now < new Date(WAIVER_CEILING), "WAIVER_EXPIRED_OR_INVALID_TIME");
    checkEnvironment(env);
    const prod = auditGraph(production, policy, state, ["production"]);
    const full = auditGraph(all, policy, state, ["production", "development"]);
    const clean = prod.counts.total === 0 && full.counts.total === 0;
    return { accepted: true, status: clean ? "CLEAN" : "ACCEPTED_WITH_DATED_WAIVER", originalAuditExitCode: production.exitCode,
      allDependencyAuditExitCode: all.exitCode, counts: prod.counts, allDependencyCounts: full.counts,
      waiversUsed: [...new Set([...prod.waiversUsed, ...full.waiversUsed])].sort(), expiresAt: policy.expiresAt,
      environmentAssurance: "EXTERNAL_NETWORK_EXPOSURE_NOT_PROVEN_BY_CI" };
  } catch (error) {
    return { accepted: false, status: "REJECTED", code: error.message, originalAuditExitCode: production?.exitCode ?? null };
  }
}
