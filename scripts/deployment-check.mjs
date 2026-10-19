import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resume=process.argv[2]==="--resume";
if (resume ? process.argv.length!==4 : process.argv.length!==2) throw new Error("Unsupported readiness arguments");
const output = resume ? path.resolve(process.argv[3]) : await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-M0-deployment-"));
if(path.dirname(output).toLowerCase()!==path.resolve(os.tmpdir()).toLowerCase() || !path.basename(output).startsWith("VYNVORI-M0-deployment-")) throw new Error("Unexpected readiness workspace");
if(resume){
  const source=await fs.readFile(path.join(root,"package-lock.json")),installed=await fs.readFile(path.join(output,"package-lock.json"));
  // Windows npm can retain CRLF. Require identical lock text after only Git's line-ending normalization.
  if(source.toString("utf8").replaceAll("\r\n","\n")!==installed.toString("utf8").replaceAll("\r\n","\n")) throw new Error("Resume requires the exact verified canonical install lockfile");
  await fs.access(path.join(output,"node_modules/.package-lock.json"));await fs.access(path.join(output,"readiness.log"));
}
const npmCli = process.env.npm_execpath;
if (!npmCli || !npmCli.endsWith(".js")) throw new Error("Run through npm run test:deployment.");
const skip = new Set(["node_modules", ".next", "next-env.d.ts", ".env", ".env.local", ".vercel", "tests"]);
async function copy(from, to) {
  await fs.mkdir(to,{recursive:true});
  for (const entry of await fs.readdir(from,{withFileTypes:true})) {
    if (skip.has(entry.name) || entry.name.startsWith(".env.")) continue;
    const source = path.join(from,entry.name), destination = path.join(to,entry.name);
    if (entry.isDirectory()) await copy(source,destination);
    else if (entry.isFile()) await fs.copyFile(source,destination);
  }
}
for (const directory of ["apps/web", "packages/shared", "packages/commerce", "packages/db"])
  await copy(path.join(root,directory),path.join(output,directory));
// Keep every workspace manifest so a Vercel npm install does not prune the lockfile.
// BFF packages are required at build time. Native Medusa/worker source is not copied.
const workspaceManifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
for (const file of ["package.json", "package-lock.json", ...workspaceManifest.workspaces.map(workspace => `${workspace}/package.json`)]) {
  await fs.mkdir(path.dirname(path.join(output,file)),{recursive:true});
  await fs.copyFile(path.join(root,file),path.join(output,file));
}
const rawHash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const hash = bytes => rawHash(bytes.toString("utf8").replaceAll("\r\n","\n"));
const lockBefore = hash(await fs.readFile(path.join(output,"package-lock.json")));
const rawLockBefore = rawHash(await fs.readFile(path.join(output,"package-lock.json")));
let log = "";
const userConfig=path.join(output,"empty-user.npmrc"),globalConfig=path.join(output,"empty-global.npmrc");
await fs.writeFile(userConfig,"");await fs.writeFile(globalConfig,"");
const buildEnv=Object.fromEntries(["PATH","SystemRoot","TEMP","TMP","APPDATA","LOCALAPPDATA","USERPROFILE"].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
Object.assign(buildEnv,{VERCEL:"1",VERCEL_ENV:"preview",VYNVORI_IDENTITY_CENTRAL_SSO:"false",NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG:"synthetic-unused-platform-metadata",NEXT_TELEMETRY_DISABLED:"1",MEDUSA_DISABLE_TELEMETRY:"true",npm_config_userconfig:userConfig,npm_config_globalconfig:globalConfig,npm_config_registry:"https://registry.npmjs.org/"});
async function run(args) {
  console.log(`Deployment readiness: npm ${args.join(" ")}`);
  const child = spawn(process.execPath,[npmCli,...args],{cwd:output,env:buildEnv,stdio:["ignore","pipe","pipe"]});
  child.stdout.on("data",bytes=>{log+=bytes;process.stdout.write(bytes);});
  child.stderr.on("data",bytes=>{log+=bytes;process.stderr.write(bytes);});
  const code = await new Promise((resolve,reject)=>{child.on("error",reject);child.on("exit",resolve);});
  await fs.writeFile(path.join(output,"readiness.log"),log);
  if (code!==0) throw new Error(`npm ${args.join(" ")} exited ${code}`);
}
if(!resume) await run(["ci"]);
await run(["install"]); // Verify Vercel's default install even when reusing an independently completed npm ci.
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
        if (/^(?:design\/|docs\/|logo\/|apps\/medusa\/|services\/)|(?:^|\/)tests\/|^packages\/db\/(?:auth-migrations|migrations)\/|^packages\/db\/src\/(?:migrate|migrate-identity|identity-migrations)\.ts$/.test(relative)) throw new Error(`Private reference/test or migration material traced: ${relative}`);
      }
      traces.push(path.relative(next,file));
    }
  }
}
await inspect(next);
if (!traces.length) throw new Error("No Next.js deployment traces generated.");
await fs.writeFile(path.join(output,"results.json"),JSON.stringify({status:"PASSED",environment:"preview",install:"npm install (workspace root)",reusedVerifiedCanonicalInstall:resume,build:"npm run build in apps/web (next build)",lockfileUnchanged:true,lockfileComparison:"Exact UTF8 text after CRLF/LF normalization only",lockSha256:lockBefore,rawLockBefore,rawLockAfter:rawHash(await fs.readFile(path.join(output,"package-lock.json"))),traces:traces.length,cloudDeployment:"NOT_RUN"},null,2)+"\n");
console.log(`PASS default Vercel npm/Next build, unchanged lockfile, ${traces.length} traces with no reference/test materials. Local readiness only. Evidence: ${output}`);
