import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import readline from "node:readline";
const require = createRequire(import.meta.url);
const mode = process.argv[2];
if (!["serve", "migrate"].includes(mode) || (mode === "migrate" && process.env.M2_AUTHORIZE_MEDUSA_MIGRATION !== "vynvori_medusa_staging")) {
  console.error("Explicit serve or separately authorized migration required");
  process.exit(1);
}
if (mode === "serve") delete process.env.M2_AUTHORIZE_MEDUSA_MIGRATION;
const port = process.env.PORT || "8080";
if (!/^\d+$/.test(port) || +port < 1024 || +port > 65535) process.exit(1);
const secretKeys = ["M2_MEDUSA_DATABASE_URL", "M2_MEDUSA_JWT_SECRET", "M2_MEDUSA_COOKIE_SECRET"];
const secrets = secretKeys.map(key => process.env[key]).filter(Boolean);
try { secrets.push(decodeURIComponent(new URL(process.env.M2_MEDUSA_DATABASE_URL).password)); } catch { /* config rejects invalid URL */ }
const child = spawn(process.execPath, [require.resolve("@medusajs/cli/cli.js"), ...(mode === "serve" ? ["start", "--host", "0.0.0.0", "--port", port] : ["db:migrate"])], {
  stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, __MEDUSA_DB_CONNECTION_MAX_RETRIES: "1" },
});
for (const stream of [child.stdout, child.stderr]) {
  const lines = readline.createInterface({ input: stream });
  lines.on("line", line => {
    let safe = line.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[DATABASE_REDACTED]");
    for (const secret of secrets) if (secret) safe = safe.split(secret).join("[REDACTED]");
    console.log(safe);
  });
}
let stopping = false;
let escalation;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  escalation = setTimeout(() => child.kill("SIGKILL"), 8000);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
child.on("error", () => { console.error("Medusa process could not start"); process.exitCode = 1; });
const deadline = setTimeout(() => { console.error("Medusa startup/command deadline exceeded"); process.exitCode = 1; stop(); }, mode === "serve" ? 180000 : 600000);
let polling = mode === "serve";
async function poll() {
  while (polling && !stopping) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      await response.arrayBuffer();
      if (response.ok) { clearTimeout(deadline); return; }
    } catch { /* bounded by deadline; never retry a mutation */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
child.on("close", (code, signal) => {
  polling = false;
  clearTimeout(deadline); clearTimeout(escalation);
  process.exitCode ||= code ?? (stopping && signal === "SIGTERM" ? 0 : 1);
});
void poll();
