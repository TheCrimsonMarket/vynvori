import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

// Updated only by an explicitly reviewed policy change, never by the runner/tests.
export const APPROVED_POLICY_SHA256 = "3326ad4a9cc66da4df299f0e7adf42648563486f51207140983fcf5936064f4b";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b, "en"))) : entry);
export const digest = value => sha256(canonical(value));
const levels = ["info", "low", "moderate", "high", "critical"];
const manifestKeys = ["name", "version", "private", "workspaces", "dependencies", "devDependencies", "peerDependencies", "peerDependenciesMeta", "optionalDependencies", "overrides", "engines", "packageManager", "exports", "type"];
const projection = manifest => Object.fromEntries(manifestKeys.filter(key => key in manifest).map(key => [key, manifest[key]]));
const fail = code => { throw new Error(code); };
const check = (condition, code) => { if (!condition) fail(code); };
const same = (a, b) => digest(a) === digest(b);
const sorted = values => [...values].sort();
const safePath = value => typeof value === "string" && value.length > 0 && !value.includes("\\") && !value.includes(":") && !path.posix.isAbsolute(value) && !value.split("/").includes("..");

export function resolveLock(packages, parent, name) {
  let location = parent;
  while (true) {
    const candidate = path.posix.join(location, "node_modules", name);
    if (packages[candidate]) {
      const record = packages[candidate];
      return record.link ? record.resolved : candidate;
    }
    if (!location) return undefined;
    location = path.posix.dirname(location);
    if (location === ".") location = "";
  }
}

/** Exact installed-package ancestry, including cycles and peer edges, without enumerating exponential paths. */
export function ancestry(lock, targetNodes) {
  const edges = [];
  for (const [parent, record] of Object.entries(lock.packages)) {
    if (record.link || record.dev === true) continue;
    for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const [name, spec] of Object.entries(record[kind] ?? {})) {
        const child = resolveLock(lock.packages, parent, name);
        if (child && lock.packages[child]?.dev !== true) edges.push({ parent, child, name, spec, kind });
      }
    }
  }
  const ancestors = new Set(targetNodes);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) if (ancestors.has(edge.child) && !ancestors.has(edge.parent)) { ancestors.add(edge.parent); changed = true; }
  }
  return edges.filter(edge => ancestors.has(edge.child)).sort((a, b) => canonical(a).localeCompare(canonical(b), "en"));
}

async function walk(root, folder) {
  const stat = await fs.lstat(path.join(root, folder));
  check(!stat.isSymbolicLink(), "SECURITY_SURFACE_SYMLINK");
  if (!stat.isDirectory()) return [folder];
  const files = [];
  for (const entry of await fs.readdir(path.join(root, folder))) {
    if (["node_modules", ".medusa", ".next", "dist", "next-env.d.ts"].includes(entry) || entry.endsWith(".tsbuildinfo") || (entry.startsWith(".env") && entry !== ".env.example")) continue;
    files.push(...await walk(root, `${folder}/${entry}`));
  }
  return sorted(files);
}

async function manifestInventory(root) {
  const result = ["package.json", "design/reference/package.json"];
  for (const category of ["apps", "packages", "services"]) {
    for (const entry of await fs.readdir(path.join(root, category), { withFileTypes: true })) {
      check(!entry.isSymbolicLink(), "WORKSPACE_SYMLINK");
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = `${category}/${entry.name}/package.json`;
      try { await fs.access(path.join(root, file)); result.push(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  return sorted(result);
}

/** Read-only snapshot. Production never accepts a supplied snapshot or a fingerprint-update flag. */
export async function snapshot(root, policy) {
  const lockBytes = await fs.readFile(path.join(root, "package-lock.json"));
  if (policy.fingerprint.lockSha256) check(sha256(lockBytes) === policy.fingerprint.lockSha256, "LOCK_FINGERPRINT_MISMATCH");
  const lock = JSON.parse(lockBytes);
  check(lock.lockfileVersion === 3 && lock.packages, "LOCK_FORMAT");
  const manifests = {};
  for (const file of await manifestInventory(root)) manifests[file] = digest(projection(JSON.parse(await fs.readFile(path.join(root, file), "utf8"))));
  const surface = {};
  const rootConfiguration = {};
  for (const file of [".npmrc", "npm-shrinkwrap.json"]) {
    try { rootConfiguration[file] = sha256(await fs.readFile(path.join(root, file))); }
    catch (error) { if (error.code !== "ENOENT") throw error; rootConfiguration[file] = null; }
  }
  for (const folder of policy.fingerprint.securityRoots) {
    check(safePath(folder), "UNSAFE_POLICY_PATH");
    for (const file of await walk(root, folder)) {
      const bytes = await fs.readFile(path.join(root, file));
      // Git text files have identical LF content in CI; allow Windows CRLF checkout conversion only.
      let content = /\.(?:ts|tsx|mjs|json|yml|yaml|css|md|sql)$/.test(file) || file.endsWith(".env.example") ? bytes.toString("utf8").replaceAll("\r\n", "\n") : bytes;
      // Avoid a circular self-hash while pinning the evaluator's actual implementation.
      if (file === "scripts/security/audit-policy.mjs") content = content.replace(/export const APPROVED_POLICY_SHA256 = "[^"]+";/, 'export const APPROVED_POLICY_SHA256 = "REVIEWED_ANCHOR";');
      surface[file] = sha256(content);
    }
  }
  const targetNodes = policy.exceptions.flatMap(exception => exception.nodes);
  const edges = ancestry(lock, targetNodes);
  const locations = new Set([...targetNodes, ...edges.flatMap(edge => [edge.parent, edge.child])]);
  const installed = {};
  const resolutions = [];
  for (const location of locations) {
    check(location === "" || safePath(location), "UNSAFE_PACKAGE_PATH");
    const manifest = JSON.parse(await fs.readFile(path.join(root, location, "package.json"), "utf8"));
    installed[location] = { name: manifest.name, version: manifest.version,
      dependencies: manifest.dependencies ?? {}, optionalDependencies: manifest.optionalDependencies ?? {}, peerDependencies: manifest.peerDependencies ?? {} };
  }
  for (const edge of edges) {
    // Resolve using the physical installed tree, not merely the lockfile's claim.
    let location = edge.parent;
    let resolved;
    while (true) {
      const candidate = path.posix.join(location, "node_modules", edge.name);
      try {
        const physical = await fs.realpath(path.join(root, candidate));
        resolved = path.relative(root, physical).split(path.sep).join("/");
        break;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!location) break;
      location = path.posix.dirname(location);
      if (location === ".") location = "";
    }
    resolutions.push({ ...edge, resolved: resolved ?? null });
  }
  return { lockSha256: sha256(lockBytes), lock, manifests, surface, rootConfiguration, edges, installed, resolutions };
}

export function validatePolicy(policy) {
  check(digest(policy) === APPROVED_POLICY_SHA256, "POLICY_FINGERPRINT_MISMATCH");
  check(policy.schemaVersion === 1 && policy.authority === "VYNVORI founder" && policy.approvedOn === "2026-10-15" &&
    policy.reviewedHead === "34c55cbe8c889ce777e9994ae4eede9b2e316148" && policy.expiresAt === "2026-11-15T23:59:59Z" &&
    policy.scope === "synthetic-only-local-M2" && policy.medusaVersion === "2.21.2", "APPROVAL_METADATA_MISMATCH");
  check(same(policy.exceptions.map(({ ghsa, name, version }) => ({ ghsa, name, version })), [
    { ghsa: "GHSA-vfj7-8cjw-p6xm", name: "braces", version: "3.0.3" },
    { ghsa: "GHSA-hp3w-g68c-fv3c", name: "sprintf-js", version: "1.0.3" },
  ]), "EXCEPTION_SCOPE_MISMATCH");
}

function validateState(state, policy, env) {
  check(state.lockSha256 === policy.fingerprint.lockSha256, "LOCK_FINGERPRINT_MISMATCH");
  check(same(state.manifests, policy.fingerprint.manifests), "MANIFEST_FINGERPRINT_MISMATCH");
  check(same(state.surface, policy.fingerprint.securitySurface), "SECURITY_BOUNDARY_CHANGED");
  check(same(state.rootConfiguration, policy.fingerprint.rootConfiguration), "UNREVIEWED_NPM_CONFIGURATION");
  check(same(state.edges, policy.fingerprint.ancestryEdges), "DEPENDENCY_ANCESTRY_CHANGED");
  for (const edge of state.resolutions) check(edge.child === edge.resolved, "INSTALLED_RESOLUTION_CHANGED");
  for (const [location, actual] of Object.entries(state.installed)) {
    const expected = state.lock.packages[location];
    check(expected && actual.version === expected.version && actual.name === (expected.name ?? nameAt(location)), "INSTALLED_PACKAGE_CHANGED");
    for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) check(same(actual[kind], expected[kind] ?? {}), "INSTALLED_DEPENDENCY_CHAIN_CHANGED");
  }
  for (const exception of policy.exceptions) for (const node of exception.nodes) {
    check(state.installed[node]?.name === exception.name && state.installed[node]?.version === exception.version, "UNAPPROVED_INSTALLED_VERSION");
  }
  check(state.lock.packages["node_modules/@medusajs/medusa"]?.version === policy.medusaVersion, "MEDUSA_VERSION_CHANGED");
  check(!env.M2_ENV || env.M2_ENV === "local", "NONLOCAL_ENVIRONMENT");
  check(!env.K_SERVICE && env.VERCEL !== "1" && !["preview", "production"].includes(env.VERCEL_ENV), "REMOTE_EXECUTION_CONTEXT");
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === "npm_config_registry" && value) check(["https://registry.npmjs.org", "https://registry.npmjs.org/"].includes(value), "UNREVIEWED_AUDIT_REGISTRY");
    if (["npm_config_workspace", "npm_config_workspaces"].includes(key.toLowerCase()) && value !== undefined) check(key.toLowerCase() === "npm_config_workspaces" && value === "true", "PARTIAL_WORKSPACE_AUDIT");
    if (key.startsWith("VYNVORI_") && value !== undefined) check(value === "false", "OPERATIONAL_FEATURE_ENABLED");
    if (/^M2_.*(?:ORIGIN|DATABASE_URL)$/.test(key) && value) {
      let url;
      try { url = new URL(value); } catch { fail("INVALID_INTEGRATION_ENVIRONMENT"); }
      check(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "REMOTE_DEPENDENCY_CONFIGURED");
    }
  }
}

function nameAt(location) {
  const marker = location.lastIndexOf("node_modules/");
  return marker >= 0 ? location.slice(marker + "node_modules/".length) : undefined;
}

function auditGraph(audit, policy, state) {
  check(audit?.auditReportVersion === 2 && audit.vulnerabilities && typeof audit.vulnerabilities === "object" && !Array.isArray(audit.vulnerabilities) &&
    audit.metadata?.vulnerabilities && audit.metadata?.dependencies && !audit.error, "AUDIT_INCOMPLETE");
  const graph = Object.create(null);
  const counts = Object.fromEntries([...levels, "total"].map(level => [level, 0]));
  for (const [name, record] of Object.entries(audit.vulnerabilities)) {
    check(record?.name === name && levels.includes(record.severity) && typeof record.isDirect === "boolean" && typeof record.range === "string" &&
      Array.isArray(record.nodes) && record.nodes.length > 0 && Array.isArray(record.via) && record.via.length > 0 && Array.isArray(record.effects), "ADVISORY_RECORD_INCOMPLETE");
    check(Object.hasOwn(policy.reviewedAuditGraph, name), "UNREVIEWED_AFFECTED_PACKAGE");
    const known = policy.reviewedAuditGraph[name];
    const origins = [];
    const via = [];
    for (const item of record.via) {
      if (typeof item === "string") {
        check(Object.hasOwn(audit.vulnerabilities, item) && known.via.includes(item), "UNMAPPABLE_ADVISORY_REFERENCE");
        via.push(item);
      } else {
        check(item && Number.isInteger(item.source) && item.source > 0 && typeof item.title === "string" && item.title.length > 0 &&
          typeof item.url === "string" && /^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/.test(item.url), "UNMAPPABLE_ADVISORY_ORIGIN");
        const ghsa = item.url.split("/").at(-1);
        const exception = policy.exceptions.find(entry => entry.ghsa === ghsa);
        check(exception, "UNAPPROVED_ADVISORY");
        check(name === exception.name && item.name === name && item.dependency === name && item.severity === exception.severity &&
          item.range === exception.range, "ADVISORY_ORIGIN_MISMATCH");
        origins.push(ghsa);
      }
    }
    check(record.nodes.every(node => safePath(node) && known.nodes.includes(node) && state.lock.packages[node] && state.installed[node]), "UNREVIEWED_VULNERABLE_PATH");
    // Only reviewed package propagation may be excepted; no severity-wide or count-only filtering.
    check(record.severity === known.severity && origins.every(id => known.origins.includes(id)), "ADVISORY_GRAPH_CHANGED");
    graph[name] = { nodes: sorted(record.nodes), severity: record.severity, via: sorted(via), origins: sorted(origins), mappedOrigins: new Set(origins) };
    counts[record.severity]++; counts.total++;
  }
  for (const level of [...levels, "total"]) check(Number.isInteger(audit.metadata.vulnerabilities[level]) && audit.metadata.vulnerabilities[level] === counts[level], "AUDIT_COUNTS_INCOMPLETE");
  for (const key of ["prod", "dev", "optional", "peer", "peerOptional", "total"]) check(Number.isInteger(audit.metadata.dependencies[key]) && audit.metadata.dependencies[key] >= 0, "AUDIT_DEPENDENCIES_INCOMPLETE");
  check(audit.metadata.dependencies.total > 0, "AUDIT_DEPENDENCIES_INCOMPLETE");
  for (let iteration = 0; iteration < Object.keys(graph).length; iteration++) {
    for (const record of Object.values(graph)) for (const via of record.via) for (const id of graph[via].mappedOrigins) record.mappedOrigins.add(id);
  }
  for (const record of Object.values(graph)) check(record.mappedOrigins.size > 0, "UNMAPPABLE_ADVISORY_GRAPH");
  const reviewedOrigins = Object.fromEntries(Object.entries(policy.reviewedAuditGraph).map(([name, record]) => [name, new Set(record.origins)]));
  for (let iteration = 0; iteration < Object.keys(reviewedOrigins).length; iteration++) {
    for (const [name, record] of Object.entries(policy.reviewedAuditGraph)) for (const via of record.via) for (const id of reviewedOrigins[via]) reviewedOrigins[name].add(id);
  }
  const activeOrigins = new Set(Object.values(graph).flatMap(record => record.origins));
  // A syntactically valid but truncated report must not hide the reviewed propagation graph.
  // Withdrawn/fixed origins may disappear; a genuinely empty, consistent audit remains clean.
  for (const [name, known] of Object.entries(policy.reviewedAuditGraph)) {
    const expected = sorted([...reviewedOrigins[name]].filter(id => activeOrigins.has(id)));
    check(Boolean(graph[name]) === (expected.length > 0), "AUDIT_GRAPH_INCOMPLETE");
    if (!graph[name]) continue;
    check(same(sorted(graph[name].mappedOrigins), expected), "AUDIT_GRAPH_INCOMPLETE");
    const expectedVia = known.via.filter(via => [...reviewedOrigins[via]].some(id => activeOrigins.has(id)));
    check(same(graph[name].via, sorted(expectedVia)), "AUDIT_GRAPH_INCOMPLETE");
    // npm's effects list can omit redundant peer propagation; each listed effect must still be valid.
    check(audit.vulnerabilities[name].effects.every(dependent => typeof dependent === "string" && graph[dependent]?.via.includes(name)), "AUDIT_EFFECTS_INCOMPLETE");
  }
  return { counts, records: Object.entries(graph).map(([name, record]) => ({ name, ...record, mappedOrigins: sorted(record.mappedOrigins),
    installedVersions: record.nodes.map(node => ({ node, version: state.installed[node].version })) })) };
}

/** Pure deterministic evaluation; runner supplies real time/state and never reads the test fixture. */
export function evaluate({ policy, state, stdout, exitCode, signal = null, executionError = false, now = new Date(), env = {} }) {
  try {
    validatePolicy(policy);
    check(Number.isFinite(now.getTime()) && now >= new Date("2026-10-15T00:00:00Z") && now < new Date(policy.expiresAt), "APPROVAL_EXPIRED_OR_INVALID_TIME");
    validateState(state, policy, env);
    check(!executionError && !signal && [0, 1].includes(exitCode), "AUDIT_EXECUTION_FAILURE");
    let audit;
    try { audit = JSON.parse(stdout); } catch { fail("AUDIT_JSON_INVALID"); }
    check(!audit?.error, "AUDIT_EXECUTION_FAILURE");
    const parsed = auditGraph(audit, policy, state);
    check(exitCode === (parsed.counts.total ? 1 : 0), "AUDIT_EXIT_STATUS_INCONSISTENT");
    return { accepted: true, status: parsed.counts.total ? "ACCEPTED_WITH_TEMPORARY_EXCEPTION" : "CLEAN", originalAuditExitCode: exitCode,
      ...parsed, expiresAt: policy.expiresAt, environmentAssurance: "EXTERNAL_NETWORK_EXPOSURE_NOT_PROVEN_BY_CI" };
  } catch (error) {
    return { accepted: false, status: "REJECTED", code: error.message, originalAuditExitCode: exitCode };
  }
}
