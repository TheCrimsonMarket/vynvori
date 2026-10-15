import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";

const exec = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Only handles created here can be terminated; POSIX children get their own process group. */
export function startProcess(command, args, options = {}) {
  const child = spawn(command, args, { ...options, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const handle = { child, closed: false, result: undefined, stopping: undefined };
  handle.completion = new Promise(resolve => {
    child.once("error", error => { handle.error = error; });
    child.once("close", (code, signal) => {
      handle.closed = true;
      handle.result = { code, signal };
      resolve(handle.result);
    });
  });
  return handle;
}

async function groupRunning(handle) {
  if (!handle.child.pid) return false;
  if (process.platform === "linux") {
    // Exclude zombies: they cannot run/hold ports and are reaped by their parent/init.
    for (const pid of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) === handle.child.pid && fields[0] !== "Z") return true;
      } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
    }
    return false;
  }
  if (process.platform === "win32") return !handle.closed;
  try { process.kill(-handle.child.pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

async function waitStopped(handle, milliseconds) {
  const deadline = Date.now() + milliseconds;
  do {
    if (handle.closed && !await groupRunning(handle)) return true;
    await delay(50);
  } while (Date.now() < deadline);
  return false;
}

async function signalOwned(handle, signal) {
  if (!handle.child.pid || !await groupRunning(handle)) return;
  if (process.platform === "win32") {
    await exec("taskkill", ["/pid", String(handle.child.pid), "/T", "/F"], { timeout: 5000, windowsHide: true });
  } else {
    try { process.kill(-handle.child.pid, signal); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
}

/** Drain stdio until close; bounded escalation targets only the process group we created. */
export function stopProcess(handle, { graceMs = 10000, killMs = 5000, report = console.log } = {}) {
  if (handle.stopping) return handle.stopping;
  handle.stopping = (async () => {
    report(`cleanup: pid=${handle.child.pid ?? "spawn-failed"} requesting termination`);
    const wasRunning = await groupRunning(handle);
    await signalOwned(handle, "SIGTERM");
    let forced = process.platform === "win32" && wasRunning;
    if (!await waitStopped(handle, graceMs)) {
      forced = true;
      report(`cleanup: pid=${handle.child.pid} graceful deadline exceeded; killing owned group`);
      await signalOwned(handle, "SIGKILL");
      if (!await waitStopped(handle, killMs)) throw new Error(`Cleanup deadline exceeded for owned pid ${handle.child.pid}`);
    }
    handle.child.stdout.destroy();
    handle.child.stderr.destroy();
    report(`cleanup: pid=${handle.child.pid ?? "spawn-failed"} closed code=${handle.result?.code} signal=${handle.result?.signal} forced=${forced}`);
    if (handle.error) throw handle.error;
    return { ...handle.result, forced };
  })();
  return handle.stopping;
}

export async function waitProcess(handle, timeoutMs, label) {
  let timer;
  try {
    const result = await Promise.race([
      handle.completion,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs); }),
    ]);
    if (handle.error) throw handle.error;
    if (result.code !== 0) throw new Error(`${label} exited code=${result.code} signal=${result.signal}`);
    return result;
  } finally { clearTimeout(timer); }
}
