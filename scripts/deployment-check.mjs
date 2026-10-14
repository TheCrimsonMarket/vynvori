import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-M0-deployment-"));
const npmCli = process.env.npm_execpath;
if (!npmCli || !npmCli.endsWith(".js")) throw new Error("Run through npm run test:deployment.");
const skip = new Set(["node_modules", ".next", "next-env.d.ts", ".env", ".env.local", ".vercel"]);
async function copy(from, to) {
  await fs.mkdir(to,{recursive:true});
  for (const entry of await fs.readdir(from,{withFileTypes:true})) {
    if (skip.has(entry.name) || entry.name.startsWith(".env.")) continue;
    const source = path.join(from,entry.name), destination = path.join(to,entry.name);
    if (entry.isDirectory()) await copy(source,destination);
    else if (entry.isFile()) await fs.copyFile(source,destination);
  }
}
await copy(path.join(root,"apps/web"),path.join(output,"apps/web"));
await copy(path.join(root,"packages/shared"),path.join(output,"packages/shared"));
for (const file of ["package.json","package-lock.json","design/reference/package.json"]) {
  await fs.mkdir(path.dirname(path.join(output,file)),{recursive:true});
  await fs.copyFile(path.join(root,file),path.join(output,file));
}
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const lockBefore = hash(await fs.readFile(path.join(output,"package-lock.json")));
let log = "";
async function run(args) {
  console.log(`Deployment readiness: npm ${args.join(" ")}`);
  const child = spawn(process.execPath,[npmCli,...args],{cwd:output,env:{...process.env,VERCEL:"1",VERCEL_ENV:"preview",NEXT_TELEMETRY_DISABLED:"1"},stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",bytes=>{log+=bytes;process.stdout.write(bytes);});
  child.stderr.on("data",bytes=>{log+=bytes;process.stderr.write(bytes);});
  const code = await new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",resolve);});
  await fs.writeFile(path.join(output,"readiness.log"),log);
  if (code!==0) throw new Error(`npm ${args.join(" ")} exited ${code}`);
}
await run(["ci"]);
await run(["install"]); // Vercel's default npm install, with the root workspace lockfile.
if (lockBefore!==hash(await fs.readFile(path.join(output,"package-lock.json")))) throw new Error("Default install changed the locked dependency graph.");
await run(["run","build","--workspace","@vynvori/web"]);
const next = path.join(output,"apps/web/.next");
const traces = [];
async function inspect(folder) {
  for (const entry of await fs.readdir(folder,{withFileTypes:true})) {
    const file = path.join(folder,entry.name);
    if (entry.isDirectory()) await inspect(file);
    else if (file.endsWith(".nft.json")) {
      const trace=JSON.parse(await fs.readFile(file,"utf8"));
      for (const item of trace.files) {
        const relative=path.relative(output,path.resolve(path.dirname(file),item)).replaceAll("\\","/");
        if (/^(?:design\/|docs\/|logo\/)|^packages\/shared\/tests\//.test(relative)) throw new Error(`Private reference/test material traced: ${relative}`);
      }
      traces.push(path.relative(next,file));
    }
  }
}
await inspect(next);
if (!traces.length) throw new Error("No Next.js deployment traces generated.");
await fs.writeFile(path.join(output,"results.json"),JSON.stringify({status:"PASSED",environment:"preview",install:"npm install (workspace root)",build:"npm run build in apps/web (next build)",lockfileUnchanged:true,traces:traces.length,cloudDeployment:"NOT_RUN"},null,2)+"\n");
console.log(`PASS default Vercel npm/Next build, unchanged lockfile, ${traces.length} traces with no reference/test materials. Local readiness only. Evidence: ${output}`);
