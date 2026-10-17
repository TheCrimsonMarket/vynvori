// Executed via node -e inside the final image; no shell or package manager needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
const runtimeRequire = createRequire(`${process.cwd()}/package.json`);
assert.equal(process.version, "v22.23.3");
assert.equal(process.getuid(), 65532);
const absent = ["/usr/local/lib/node_modules/npm", "/usr/local/lib/node_modules/corepack", "/opt/yarn-v1.22.22",
  "/usr/local/bin/npm", "/usr/local/bin/npx", "/usr/local/bin/yarn", "/usr/bin/perl", "/usr/lib/x86_64-linux-gnu/perl-base",
  "/usr/bin/minizip", "/usr/lib/x86_64-linux-gnu/libminizip.so.1", "/bin/sh", "/usr/bin/apt", "/usr/bin/dpkg"];
for (const file of absent) assert.equal(fs.existsSync(file), false, `Unnecessary runtime tooling: ${file}`);
for (const name of ["cli", "framework", "medusa"]) {
  assert.equal(JSON.parse(fs.readFileSync(`/app/node_modules/@medusajs/${name}/package.json`, "utf8")).version, "2.21.2");
}
const exports = ["@medusajs/framework/pg", "@medusajs/cli/cli.js", "@medusajs/medusa"];
for (const name of exports) assert.ok(runtimeRequire.resolve(name));
assert.equal(typeof runtimeRequire("@medusajs/framework/pg").Client, "function");
// Exercise installed native glibc bindings on the Cloud Run/CI amd64 target.
const native = ["lightningcss", "@rollup/rollup-linux-x64-gnu", "@napi-rs/lzma-linux-x64-gnu", "msgpackr-extract"];
for (const name of native) assert.ok(runtimeRequire(name));
const zlibPackage = fs.readFileSync("/var/lib/dpkg/status.d/zlib1g", "utf8");
const zlibVersion = /^Version: (.+)$/m.exec(zlibPackage)?.[1];
assert.equal(zlibVersion, "1:1.3.dfsg+really1.3.1-1+b1");
const zlibPath = fs.realpathSync("/usr/lib/x86_64-linux-gnu/libz.so.1");
assert.equal(fs.readFileSync(zlibPath).includes(Buffer.from("zipOpenNewFileInZip4_64")), false);
const compiledFiles = [];
function fingerprint(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) fingerprint(file);
    else if (entry.isFile()) compiledFiles.push([path.relative(process.cwd(), file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
  }
}
fingerprint(process.cwd());
console.log(JSON.stringify({ node: process.version, uid: process.getuid(), architecture: process.arch,
  versions: process.versions, glibc: process.report.getReport().header.glibcVersionRuntime,
  nodeBinarySha256: createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex"),
  compiledTreeSha256: createHash("sha256").update(JSON.stringify(compiledFiles)).digest("hex"),
  runtimeExports: exports, nativeBindings: native, absentTooling: absent,
  criticalChecks: { perlPresent: false, minizipPresent: false, minizipExportNamePresent: false, zlibVersion, zlibPath },
  os: fs.readFileSync("/etc/os-release", "utf8") }));
