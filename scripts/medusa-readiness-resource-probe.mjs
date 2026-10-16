// Executed only inside the local integration-test container via node -e.
import assert from "node:assert/strict";
import pg from "@medusajs/framework/pg";
import { dependencyReadiness } from "./src/dependency-readiness.js";
const { Client } = pg;
const mode = process.argv[1];
const clients = [];
const stages = {};
const started = performance.now();
const mark = name => { stages[name] = Math.round((performance.now() - started) * 100) / 100; };
const connect = Client.prototype.connect;
const query = Client.prototype.query;
const end = Client.prototype.end;
Client.prototype.connect = async function () {
  clients.push(this); mark("connectStartMs");
  const result = await connect.call(this); mark("connectedMs"); return result;
};
Client.prototype.query = async function (...args) {
  console.log("READY_TO_PAUSE");
  await new Promise(resolve => process.stdin.once("data", resolve));
  mark("queryStartMs");
  if (mode === "abort") setTimeout(() => controller.abort(), 100);
  try { return await query.apply(this, args); } finally { mark("querySettledMs"); }
};
Client.prototype.end = async function () {
  mark("closeStartMs");
  await end.call(this); mark("socketClosedMs");
};
const controller = new AbortController();
(async () => {
  await assert.rejects(dependencyReadiness({ connectionString: process.env.M2_MEDUSA_DATABASE_URL, ssl: false }, controller.signal));
  assert.equal(clients.length, 1, "No second cancellation connection");
  assert.ok(clients[0].connection.stream.destroyed, "Owned socket must be destroyed before settlement");
  assert.ok(stages.socketClosedMs >= stages.closeStartMs);
  assert.ok(stages.socketClosedMs - stages.queryStartMs < 3000, "Query failure plus socket termination must be bounded");
  console.log(JSON.stringify({ mode, stages, socketsClosed: 1, cancellationConnections: 0 }));
})().catch(() => { console.error("Readiness resource regression failed"); process.exitCode = 1; }).finally(() => process.stdin.pause());
