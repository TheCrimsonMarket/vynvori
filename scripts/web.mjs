import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "apps/web");
const link = path.join(app, ".next");
const mode = process.argv[2];
if (!["dev", "build", "start", "typegen"].includes(mode)) throw new Error("Expected dev, build, start or typegen.");
function ownedOutput(target, temporaryRoot) {
  const direct = path.dirname(target) === temporaryRoot && path.basename(target).startsWith("VYNVORI-M0-next-");
  const nested = path.basename(target) === "build" && path.dirname(path.dirname(target)) === temporaryRoot && path.basename(path.dirname(target)).startsWith("VYNVORI-M0-next-");
  return direct || nested;
}
let existing;
try { existing = await fs.lstat(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  if (!existing.isSymbolicLink()) throw new Error("Refusing to replace an existing .next directory. Move it aside explicitly first.");
  const declaredTarget = path.resolve(path.dirname(link), await fs.readlink(link));
  const temporaryRoot = await fs.realpath(os.tmpdir());
  if (!ownedOutput(declaredTarget, temporaryRoot)) {
    throw new Error("Unexpected .next link; refusing to modify it.");
  }
  let target;
  try { target = await fs.realpath(link); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (target && !ownedOutput(target, temporaryRoot)) throw new Error("Unexpected resolved .next target");
  if (!target && mode === "start") throw new Error("Temporary Next build output is missing; run npm run build:web first.");
  if (mode === "build" || !target) { await fs.unlink(link); existing = undefined; }
}
if (!existing) {
  if (mode === "start") throw new Error("Run npm run build:web before npm run start:web.");
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-M0-next-"));
  const target = path.join(parent, "build");
  await fs.mkdir(target);
  // ESM externals ignore NODE_PATH. A sibling dependency link survives Next's
  // build-directory cleanup and resolves from the physical temporary output.
  await fs.symlink(path.join(root, "node_modules"), path.join(parent, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}
console.log(`Next.js ${mode} output: ${await fs.realpath(link)}`);
const require = createRequire(path.join(app, "package.json"));
const cli = require.resolve("next/dist/bin/next");
const args = [cli, mode, ...process.argv.slice(3)];
// Webpack resolves the external .next junction consistently on Windows/Linux.
if (["dev", "build"].includes(mode)) args.push("--webpack");
// Node resolves compiled server externals from the physical temporary directory.
const modulePaths = [path.join(app, "node_modules"), path.join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
const child = spawn(process.execPath, args, { cwd: app, stdio: "inherit", env: { ...process.env, NODE_PATH: modulePaths, NEXT_TELEMETRY_DISABLED: "1" } });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
