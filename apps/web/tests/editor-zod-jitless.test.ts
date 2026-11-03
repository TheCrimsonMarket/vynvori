import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// M3 C1c. The CSP has no 'unsafe-eval'; zod 4 probes `new Function` unless `jitless` is set (see zod-jitless.ts).
// Each case runs in a fresh process because zod caches the probe result and keeps its config on globalThis.
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (body: string) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", body], { cwd: webRoot, encoding: "utf8" });

test("in a browser-like context, importing the editor model sets zod jitless and the eval probe never runs", () => {
  const out = run(`
    globalThis.window = {};
    let evalProbes = 0;
    const RealFunction = globalThis.Function;
    globalThis.Function = new Proxy(RealFunction, { construct(target, args) { evalProbes++; return Reflect.construct(target, args); }, apply(target, thisArg, args) { evalProbes++; return Reflect.apply(target, thisArg, args); } });
    await import("./src/components/editor/model.ts");
    const { CompositionSceneV1Schema, EMPTY_SYNTHETIC_SCENE } = await import("@vynvori/contracts");
    CompositionSceneV1Schema.safeParse(EMPTY_SYNTHETIC_SCENE);
    const { config } = await import("zod");
    console.log(JSON.stringify({ jitless: config().jitless === true, evalProbes }));
  `);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim().split("\n").at(-1)!), { jitless: true, evalProbes: 0 });
});

test("control: without the module a parse DOES reach the eval probe (so the assertion above can fail)", () => {
  const out = run(`
    let evalProbes = 0;
    const RealFunction = globalThis.Function;
    globalThis.Function = new Proxy(RealFunction, { construct(target, args) { evalProbes++; return Reflect.construct(target, args); }, apply(target, thisArg, args) { evalProbes++; return Reflect.apply(target, thisArg, args); } });
    const { CompositionSceneV1Schema, EMPTY_SYNTHETIC_SCENE } = await import("@vynvori/contracts");
    CompositionSceneV1Schema.safeParse(EMPTY_SYNTHETIC_SCENE);
    console.log(JSON.stringify({ evalProbes }));
  `);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(JSON.parse(out.stdout.trim().split("\n").at(-1)!).evalProbes > 0);
});

test("on the server (no window) the module leaves zod's default behaviour alone", () => {
  const out = run(`
    await import("./src/components/editor/zod-jitless.ts");
    const { config } = await import("zod");
    console.log(JSON.stringify({ jitless: config().jitless === true }));
  `);
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout.trim().split("\n").at(-1)!), { jitless: false });
});
