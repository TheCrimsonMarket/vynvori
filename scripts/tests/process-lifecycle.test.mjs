import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { startProcess, stopProcess, waitProcess } from "../process-lifecycle.mjs";

test("bounded cleanup kills an uncooperative child and descendant without touching a sibling", { timeout: 15000 }, async () => {
  const sibling = startProcess(process.execPath, ["-e", "setInterval(()=>{},1000);console.log('ready')"]);
  const parent = startProcess(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);console.log('descendant-ready')"],{stdio:['ignore','pipe','pipe']});
    process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
    c.stdout.on('data',()=>console.log('tree-ready'));
  `]);
  sibling.child.stdout.resume(); sibling.child.stderr.resume(); parent.child.stderr.resume();
  try {
    await once(parent.child.stdout, "data");
    const result = await stopProcess(parent, { graceMs: 200, killMs: 3000 });
    assert.equal(parent.closed, true);
    if (process.platform !== "win32") assert.equal(result.signal, "SIGKILL");
    assert.equal(result.forced, true);
    assert.equal(sibling.closed, false, "unrelated sibling must survive");
  } finally {
    await stopProcess(parent, { graceMs: 200, killMs: 3000 });
    await stopProcess(sibling, { graceMs: 200, killMs: 3000 });
  }
});
test("a failed command remains a failure after successful cleanup", async () => {
  const handle = startProcess(process.execPath, ["-e", "process.exit(7)"]);
  handle.child.stdout.resume(); handle.child.stderr.resume();
  await assert.rejects(waitProcess(handle, 3000, "synthetic failure"), /code=7/);
  await stopProcess(handle);
  assert.equal(handle.result.code, 7);
});
test("shutdown keeps pipes open through the child's final log and actual close", { skip: process.platform === "win32" }, async () => {
  const handle = startProcess(process.execPath, ["-e", `
    process.on('SIGTERM',()=>{console.log('shutdown-complete');setTimeout(()=>process.exit(0),20)});
    setInterval(()=>{},1000);console.log('ready');
  `]);
  let output = "";
  handle.child.stdout.on("data", bytes => { output += bytes; });
  handle.child.stderr.resume();
  try {
    await once(handle.child.stdout, "data");
    const result = await stopProcess(handle, { graceMs: 2000 });
    assert.equal(result.code, 0);
    assert.equal(result.forced, false);
    assert.match(output, /shutdown-complete/);
    assert.equal(handle.closed, true);
  } finally { await stopProcess(handle); }
});
test("cleanup reaches a descendant after its parent exits with inherited stdio open", { skip: process.platform === "win32", timeout: 10000 }, async () => {
  const parent = startProcess(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e',"setInterval(()=>{},1000);console.log('ready')"],{stdio:['ignore',1,2]});
    c.unref();
  `]);
  parent.child.stderr.resume();
  try {
    await once(parent.child.stdout, "data");
    if (parent.child.exitCode === null) await once(parent.child, "exit");
    assert.equal(parent.child.exitCode, 0);
    assert.equal(parent.closed, false, "descendant holds inherited stdout open");
    await stopProcess(parent, { graceMs: 500, killMs: 2000 });
    assert.equal(parent.closed, true);
  } finally { await stopProcess(parent, { graceMs: 500, killMs: 2000 }); }
});
test("command timeout and spawn errors are bounded failures", async () => {
  const handle = startProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"]);
  handle.child.stdout.resume(); handle.child.stderr.resume();
  try { await assert.rejects(waitProcess(handle, 100, "timeout fixture"), /exceeded/); }
  finally { await stopProcess(handle, { graceMs: 200, killMs: 3000 }); }
  const missing = startProcess("vynvori-nonexistent-test-command", []);
  missing.child.stdout.resume(); missing.child.stderr.resume();
  await assert.rejects(waitProcess(missing, 3000, "missing executable"), { code: "ENOENT" });
  await assert.rejects(stopProcess(missing), { code: "ENOENT" });
});
