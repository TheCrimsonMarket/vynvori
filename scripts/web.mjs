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
let existing;
try { existing = await fs.lstat(link); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (existing) {
  if (!existing.isSymbolicLink()) throw new Error("Refusing to replace an existing .next directory. Move it aside explicitly first.");
  const target = await fs.realpath(link);
  if (path.dirname(target) !== await fs.realpath(os.tmpdir()) || !path.basename(target).startsWith("VYNVORI-M0-next-")) {
    throw new Error("Unexpected .next link; refusing to modify it.");
  }
  if (mode === "build") { await fs.unlink(link); existing = undefined; }
}
if (!existing) {
  if (mode === "start") throw new Error("Run npm run build:web before npm run start:web.");
  const target = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-M0-next-"));
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
