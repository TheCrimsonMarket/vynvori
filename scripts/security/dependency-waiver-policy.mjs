import fs from "node:fs/promises";
import path from "node:path";
import { digest, sha256 } from "./audit-policy.mjs";

// Founder-approved 2026-11-02 (ADR-0020). Updated only by an explicitly reviewed policy change, never by the runner/tests.
export const WAIVER_POLICY_PATH = "security/dependency-waiver-policy.json";
export const WAIVER_POLICY_SHA256 = "21eefe2ff7a8ba112b44e946f4441616aa568011bd223aa6be19b82f091212ab";
// Hard ceiling in code: editing the JSON cannot extend the window even if the anchor were also changed carelessly.
export const WAIVER_CEILING = "2026-12-17T23:59:59Z";
const WAIVER_FLOOR = "2026-11-02T00:00:00Z";
// Per-entry extensions past WAIVER_CEILING (ADR-0024, decided 2026-11-27 under the founder's delegation). The global
// ceiling above does not move. Only an advisory listed here, at exactly the listed development-only nodes, may carry its
// own expiry, and that expiry must equal the value below: editing the JSON cannot add an entry or move a date.
const WAIVER_EXTENSIONS = Object.freeze({
  "GHSA-67mh-4wv8-2f99": Object.freeze({
    expiresAt: "2027-02-28T23:59:59Z", retriageBy: "2027-02-15",
    nodes: Object.freeze(["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"]),
  }),
});
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
  checkWaiverShape(policy);
}

/** Shape and extension rules, applied after the anchor. Exported so tests can reach rules the anchor would otherwise hide. */
export function checkWaiverShape(policy) {
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
      nameAt(node.path) === waiver.package && typeof node.version === "string" && CONTEXTS.has(node.context) &&
      /^https:\/\/registry\.npmjs\.org\//.test(node.resolved) && /^sha512-[A-Za-z0-9+/]+=*$/.test(node.integrity)), "WAIVER_SCOPE_INVALID");
    if (Object.hasOwn(waiver, "expiresAt") || Object.hasOwn(waiver, "retriageBy")) {
      const extension = Object.hasOwn(WAIVER_EXTENSIONS, waiver.ghsa) ? WAIVER_EXTENSIONS[waiver.ghsa] : null;
      const paths = new Set(waiver.nodes.map(node => node.path));
      check(extension && waiver.expiresAt === extension.expiresAt && waiver.retriageBy === extension.retriageBy &&
        paths.size === waiver.nodes.length && paths.size === extension.nodes.length && extension.nodes.every(node => paths.has(node)) &&
        waiver.nodes.every(node => node.context === "development"), "WAIVER_EXTENSION_INVALID");
    }
  }
}

/** The instant a waiver stops counting: its code-listed extension when the policy carries it, otherwise the global ceiling. */
export function waiverExpiry(waiver) {
  return Object.hasOwn(WAIVER_EXTENSIONS, waiver.ghsa) && waiver.expiresAt === WAIVER_EXTENSIONS[waiver.ghsa].expiresAt
    ? WAIVER_EXTENSIONS[waiver.ghsa].expiresAt : WAIVER_CEILING;
}

/** The waivers still in their window at `now`. An expired waiver stays in the policy for review but covers nothing. */
export function activeWaivers(waivers, now) {
  return waivers.filter(waiver => now < new Date(waiverExpiry(waiver)));
}

/** Validates the reviewed policy before touching any path it names, then inspects the waived nodes. */
export async function collectWaiverState(root, policy) {
  validateWaiverPolicy(policy);
  return inspectWaivedNodes(root, policy);
}

/** Read-only: verifies every waived node in the lockfile and in the physical install. No fingerprint of unrelated files. */
export async function inspectWaivedNodes(root, policy) {
  const realRoot = await fs.realpath(root);
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
    check(record && !record.link && record.version === node.version && (record.name ?? nameAt(node.path)) === waiver.package &&
      record.resolved === node.resolved && record.integrity === node.integrity, "WAIVED_LOCK_ENTRY_CHANGED");
    check((record.dev === true) === (node.context === "development"), "WAIVED_NODE_CONTEXT_CHANGED");
    const directory = path.join(root, node.path);
    // Every path component, not only the last, must be a real directory inside the checkout.
    check(await fs.realpath(directory) === path.join(realRoot, node.path), "WAIVED_NODE_SYMLINK");
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
    // Configuration that can silently narrow either audit (e.g. drop dev dependencies) is never accepted.
    if (/^npm_config_(omit|include|only|production|dev|also|audit_level|package_lock|package_lock_only)$/i.test(key) && value !== undefined) fail("AUDIT_SCOPE_OVERRIDE");
    if (key === "NODE_ENV" && value === "production") fail("AUDIT_SCOPE_OVERRIDE");
    if (/^M2_.*(?:ORIGIN|DATABASE_URL)$/.test(key) && value) {
      let url;
      try { url = new URL(value); } catch { fail("INVALID_INTEGRATION_ENVIRONMENT"); }
      check(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "REMOTE_DEPENDENCY_CONFIGURED");
    }
  }
}

/** Every record must be a waived origin or propagate only from waived origins; nothing is filtered by severity or count. */
function auditGraph(run, policy, state, contexts, active) {
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
      const waiver = active.find(entry => entry.ghsa === ghsa);
      // A finding whose waiver has expired is reported as expired, never as covered. With the one-entry ADR-0024 policy
      // this cannot be reached (no entry active means the gate already rejected); it guards any future multi-entry policy.
      if (!waiver) fail(policy.waivers.some(entry => entry.ghsa === ghsa) ? "WAIVER_EXPIRED_OR_INVALID_TIME" : "UNWAIVED_ADVISORY");
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
  // Each waived node is installed at a reviewed version inside its advisory range, so a complete audit of its
  // context must report it. Absence means a narrowed/truncated audit (or a withdrawn advisory): fail closed.
  for (const waiver of active) for (const node of waiver.nodes) {
    if (contexts.includes(node.context)) check(audit.vulnerabilities[waiver.package]?.nodes.includes(node.path), "AUDIT_GRAPH_INCOMPLETE");
  }
  check(Number.isInteger(audit.metadata.dependencies.total) && audit.metadata.dependencies.total > 0, "AUDIT_DEPENDENCIES_INCOMPLETE");
  check(run.exitCode === (counts.total ? 1 : 0), "AUDIT_EXIT_STATUS_INCONSISTENT");
  for (let i = 0; i < Object.keys(graph).length; i++) for (const record of Object.values(graph)) for (const v of record.via) for (const id of graph[v].origins) record.origins.add(id);
  const severityOf = Object.fromEntries(policy.waivers.map(waiver => [waiver.ghsa, waiver.severity]));
  for (const record of Object.values(graph)) {
    check(record.origins.size > 0, "UNMAPPABLE_ADVISORY_GRAPH");
    // A propagated record can never be more severe than the waived origins it inherits from.
    check(rank(record.severity) <= Math.max(...[...record.origins].map(id => rank(severityOf[id]))), "ADVISORY_GRAPH_CHANGED");
  }
  return { counts, waiversUsed: [...used].sort(), records: audit.vulnerabilities };
}

/** Pure deterministic evaluation; the runner supplies real time, state and both audits. */
export function evaluateWaivers({ policy, state, production, all, now = new Date(), env = {} }) {
  try {
    validateWaiverPolicy(policy);
    // Before the global ceiling this is the original whole-policy window. After it, only code-listed per-entry
    // extensions can still be active, and with none active the gate rejects exactly as before.
    check(Number.isFinite(now.getTime()) && now >= new Date(policy.notBefore), "WAIVER_EXPIRED_OR_INVALID_TIME");
    const active = activeWaivers(policy.waivers, now);
    check(active.length > 0, "WAIVER_EXPIRED_OR_INVALID_TIME");
    checkEnvironment(env);
    const prod = auditGraph(production, policy, state, ["production"], active);
    const full = auditGraph(all, policy, state, ["production", "development"], active);
    // The full audit must contain every production finding at the same or more nodes; a narrowed run cannot pass.
    for (const [name, record] of Object.entries(prod.records)) {
      check(full.records[name] && record.nodes.every(node => full.records[name].nodes.includes(node)), "FULL_AUDIT_NARROWED");
    }
    const clean = prod.counts.total === 0 && full.counts.total === 0;
    const waiversUsed = [...new Set([...prod.waiversUsed, ...full.waiversUsed])].sort();
    const waiverExpiries = Object.fromEntries(waiversUsed.map(ghsa => [ghsa, waiverExpiry(policy.waivers.find(entry => entry.ghsa === ghsa))]));
    // The reported expiry is the earliest one in use, never later than what actually covers a finding.
    const expiresAt = waiversUsed.length ? Object.values(waiverExpiries).sort()[0] : policy.expiresAt;
    // Informational only: an extended waiver past its re-triage date is still within its window but is flagged.
    const retriageDue = waiversUsed.filter(ghsa => Object.hasOwn(WAIVER_EXTENSIONS, ghsa) &&
      waiverExpiry(policy.waivers.find(entry => entry.ghsa === ghsa)) !== WAIVER_CEILING &&
      now >= new Date(`${WAIVER_EXTENSIONS[ghsa].retriageBy}T00:00:00Z`));
    return { accepted: true, status: clean ? "CLEAN" : "ACCEPTED_WITH_DATED_WAIVER", originalAuditExitCode: production.exitCode,
      allDependencyAuditExitCode: all.exitCode, counts: prod.counts, allDependencyCounts: full.counts,
      waiversUsed, waiverExpiries, expiresAt, retriageDue,
      environmentAssurance: "EXTERNAL_NETWORK_EXPOSURE_NOT_PROVEN_BY_CI" };
  } catch (error) {
    return { accepted: false, status: "REJECTED", code: error.message, originalAuditExitCode: production?.exitCode ?? null };
  }
}
