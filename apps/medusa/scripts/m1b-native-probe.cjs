// Explicit synthetic test fixture; never registered as an application script/route.
/* eslint-disable @typescript-eslint/no-require-imports -- This fixture deliberately loads the compiled CommonJS backend through Medusa exec. */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { Modules } = require("@medusajs/framework/utils");
const { createCustomersWorkflow } = require("@medusajs/medusa/core-flows");
const originalFetch = global.fetch;
let privateCentralRevoked = false;
let browserAuthority;
// Installed providers capture fetch during module bootstrap, after this fixture is loaded.
global.fetch = async function (input, init) {
  const url = new URL(String(input));
  if (url.origin !== "https://dev.portal.raum.au") return originalFetch(input, init);
  const token = new URLSearchParams(String(init?.body)).get("token");
  if (browserAuthority && token?.startsWith("synthetic-browser-")) return originalFetch(browserAuthority + url.pathname, init);
  assert.match(token, /^synthetic-private-http-[AB]$/);
  if (privateCentralRevoked) return url.pathname.endsWith("/profile") ? Response.json({}, { status: 401 }) : Response.json({ active: false });
  const letter = token.slice(-1), identity = { iss: url.origin, sub: "synthetic-private-subject-" + letter, client_id: process.env.M1B_CENTRAL_CLIENT_ID, aud: "urn:vynvori:staging" };
  return Response.json(url.pathname.endsWith("/profile") ? { ...identity, email: `http-${letter.toLowerCase()}@example.invalid`, email_verified: false }
    : { ...identity, active: true, exp: Math.floor(Date.now() / 1000) + 300, verified_at: Math.floor(Date.now() / 1000) });
};
module.exports.default = async function ({ container }) {
  let browserEvidence = "NOT_RUN";
  const Provider = require("./src/modules/tcm-auth/service.js").default;
  const { centralCustomerWorkflow } = require("./src/workflows/central-customer.js");
  const { customerIdentityMetadata } = require("./src/workflows/steps/central-customer.js");
  const options = { enabled: true, issuer: "https://identity.example.invalid", apiBase: "https://identity.example.invalid/mana", clientId: "synthetic-native-client", clientSecret: "synthetic-private-only", audience: "urn:vynvori:staging" };
  const auth = container.resolve(Modules.AUTH), customers = container.resolve(Modules.CUSTOMER);
  const service = auth.getAuthIdentityProviderService("tcm");
  const provider = new Provider({}, options, async (url, init) => {
    assert.equal(String(url), options.apiBase + "/oauth/strict/v1/introspect");
    const token = new URLSearchParams(String(init.body)).get("token");
    assert.match(token, /^synthetic-access-[ABCD]$/);
    return Response.json({ active: true, iss: options.issuer, sub: "synthetic-subject-" + token.slice(-1), client_id: options.clientId, aud: options.audience,
      exp: Math.floor(Date.now() / 1000) + 300, verified_at: Math.floor(Date.now() / 1000) });
  });
  const authenticate = letter => provider.authenticate({ headers: { authorization: "Bearer synthetic-access-" + letter } }, service);
  const raced = await Promise.all(Array.from({ length: 12 }, () => authenticate("A")));
  assert.ok(raced.every(result => result.success));
  assert.equal(new Set(raced.map(result => result.authIdentity.id)).size, 1);
  assert.equal((await auth.listAuthIdentities({}, { take: 100 })).length, 1);
  const authA = raced[0].authIdentity;
  const input = { mode: "create", authIdentityId: authA.id, issuer: options.issuer, subject: "synthetic-subject-A", projectId: "synthetic-native-project", operationId: randomUUID(), originalEmail: "native-a@example.invalid" };
  const first = await centralCustomerWorkflow(container).run({ input, logOnError: false });
  assert.equal(first.result.state, "ready");
  const repeat = await centralCustomerWorkflow(container).run({ input, logOnError: false });
  assert.equal(repeat.result.customerId, first.result.customerId);
  assert.equal((await customers.listCustomers({ email: input.originalEmail })).length, 1);
  const changed = await centralCustomerWorkflow(container).run({ input: { ...input, originalEmail: "native-changed@example.invalid" }, logOnError: false });
  assert.equal(changed.result.customerId, first.result.customerId);
  assert.equal((await customers.listCustomers({ email: "native-changed@example.invalid" })).length, 0);
  const authB = (await authenticate("B")).authIdentity;
  assert.ok(authB);
  await assert.rejects(centralCustomerWorkflow(container).run({ input: { ...input, authIdentityId: authB.id, subject: "synthetic-subject-B", operationId: randomUUID() }, logOnError: false }));
  assert.equal((await auth.retrieveAuthIdentity(authB.id)).app_metadata?.customer_id, undefined);
  const authC = (await authenticate("C")).authIdentity;
  assert.ok(authC);
  const repair = { ...input, authIdentityId: authC.id, subject: "synthetic-subject-C", originalEmail: "native-c@example.invalid", operationId: randomUUID() };
  const orphan = await createCustomersWorkflow(container).run({ input: { customersData: [{ email: repair.originalEmail, has_account: true, metadata: customerIdentityMetadata(repair) }] }, logOnError: false });
  const recovered = await centralCustomerWorkflow(container).run({ input: { ...repair, mode: "reconcile" }, logOnError: false });
  assert.equal(recovered.result.customerId, orphan.result[0].id);
  assert.equal((await customers.listCustomers({ email: repair.originalEmail })).length, 1);
  const authD = (await authenticate("D")).authIdentity;
  assert.ok(authD);
  const pending = await centralCustomerWorkflow(container).run({ input: { ...input, mode: "reconcile", authIdentityId: authD.id, subject: "synthetic-subject-D", originalEmail: "native-absent@example.invalid", operationId: randomUUID() }, logOnError: false });
  assert.equal(pending.result.state, "reconcile_required");
  assert.equal((await customers.listCustomers({ email: "native-absent@example.invalid" })).length, 0);
  const express = require("express"), { asValue } = require("@medusajs/framework/awilix"), { validateAndTransformBody } = require("@medusajs/framework/http");
  const { bridgeSettings } = require("./src/auth/bridge-settings.js"), { privateMedusaBridge } = require("./src/auth/private-bridge.js"), { bridgeRequestProof } = require("./src/auth/medusa-proof.js");
  const { ProvisionSchema, ExchangeSchema, OwnedSchema } = require("./src/auth/provision-schema.js"), { foundationBoundary } = require("./src/api/middlewares.js");
  const { POST } = require("./src/api/auth/customer/tcm/provision/route.js");
  const exchangeRoute = require("./src/api/auth/customer/tcm/exchange/route.js").POST, ownedRoute = require("./src/api/auth/customer/tcm/owned/route.js").POST;
  const Medusa = require("@medusajs/js-sdk").default;
  const app = express();
  app.use((req, _res, next) => { req.scope = container.createScope(); next(); }); app.use(foundationBoundary);
  app.post("/auth/customer/tcm/provision", express.json({ limit: "2kb" }), validateAndTransformBody(ProvisionSchema), POST);
  app.post("/auth/customer/tcm/exchange", express.json({ limit: "2kb" }), validateAndTransformBody(ExchangeSchema), exchangeRoute);
  app.post("/auth/customer/tcm/owned", express.json({ limit: "2kb" }), validateAndTransformBody(OwnedSchema), ownedRoute);
  app.use((_error, _req, res, _next) => { void _next; res.status(400).json({ error: { code: "BRIDGE_INVALID_REQUEST" } }); });
  const listener = await new Promise(resolve => { const server = app.listen(0, "127.0.0.1", () => resolve(server)); });
  try {
    const origin = "http://127.0.0.1:" + listener.address().port, baseSettings = bridgeSettings(process.env);
    assert.equal(baseSettings.enabled, true);
    const proof = bridgeRequestProof({ origin, projectId: baseSettings.projectId, keyId: "synthetic", keys: { synthetic: Buffer.alloc(32, 31) } });
    container.register({ vynvoriTcmBridge: asValue(privateMedusaBridge({ ...baseSettings, origin, proof }, container)) });
    const ignore = () => {};
    const sdk = new Medusa({ baseUrl: origin, debug: false, auth: { type: "jwt", jwtTokenStorageMethod: "nostore" }, logger: { error: ignore, warn: ignore, info: ignore, debug: ignore } });
    const operationId = randomUUID(), body = { mode: "create", operationId, originalEmail: "http-a@example.invalid" }, path = "/auth/customer/tcm/provision", access = "synthetic-private-http-A";
    function send(payload, token = access, extra = {}) {
      return sdk.client.fetch(path, { method: "POST", body: payload, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000), headers: {
        authorization: "Bearer " + token, "x-serverless-authorization": "Bearer synthetic-service-identity", "x-vynvori-bridge": proof.sign(path, payload, token), ...extra } });
    }
    const results = await Promise.all([send(body), send(body), send(body)]);
    assert.ok(results.every(result => result.state === "ready")); assert.equal(new Set(results.map(result => result.customerId)).size, 1);
    assert.equal((await customers.listCustomers({ email: body.originalEmail })).length, 1);
    await assert.rejects(send(body, access, { "x-vynvori-bridge": "invalid" }), error => error.status === 403);
    await assert.rejects(send(body, access, { origin: "https://browser.invalid" }), error => error.status === 403);
    await assert.rejects(send({ ...body, customerId: "cus_override" }), error => error.status === 400);
    const engine = container.resolve(Modules.WORKFLOW_ENGINE), executions = await engine.listWorkflowExecutions({ workflow_id: "vynvori-central-customer", transaction_id: "vynvori-create-" + operationId });
    assert.equal(executions.length, 1); assert.equal(executions[0].state, "done");
    const pendingId = randomUUID();
    await engine.createWorkflowExecutions({ workflow_id: "vynvori-central-customer", transaction_id: "vynvori-create-" + pendingId, run_id: "synthetic-incomplete", state: "invoking", execution: {}, context: {} });
    const pendingHttp = await send({ mode: "create", operationId: pendingId, originalEmail: "http-b@example.invalid" }, "synthetic-private-http-B");
    assert.equal(pendingHttp.state, "reconcile_required"); assert.equal((await customers.listCustomers({ email: "http-b@example.invalid" })).length, 0);
    function requestAt(target, payload, customerToken) {
      return sdk.client.fetch(target, { method: "POST", body: payload, redirect: "error", cache: "no-store", headers: { authorization: "Bearer " + access,
        "x-serverless-authorization": "Bearer synthetic-service-identity", "x-vynvori-bridge": proof.sign(target, payload, access),
        ...(customerToken ? { "x-vynvori-customer-bearer": "Bearer " + customerToken } : {}) } });
    }
    const actor = { authIdentityId: results[0].authIdentityId, customerId: results[0].customerId };
    const credential = await requestAt("/auth/customer/tcm/exchange", actor);
    const claims = JSON.parse(Buffer.from(credential.token.split(".")[1], "base64url").toString());
    assert.equal(claims.actor_type, "customer"); assert.equal(claims.actor_id, actor.customerId); assert.ok(claims.exp * 1000 <= Date.now() + 300000);
    const owned = await requestAt("/auth/customer/tcm/owned", { ...actor, action: "read_customer" }, credential.token);
    assert.equal(owned.customer.id, actor.customerId); assert.equal(owned.customer.email, body.originalEmail); assert.equal(owned.token, undefined);
    const orders = await requestAt("/auth/customer/tcm/owned", { ...actor, action: "read_orders" }, credential.token);
    assert.deepEqual(orders.orders, []); assert.equal(orders.hasMore, false);
    const { createStep, StepResponse, createWorkflow, WorkflowResponse } = require("@medusajs/framework/workflows-sdk");
    const makeCart = createStep("synthetic-native-customer-cart", async (data, { container }) => {
      const cart = await container.resolve(Modules.CART).createCarts({ currency_code: "usd", customer_id: data.customerId, metadata: { fixture: "m1b-synthetic-only" } });
      return new StepResponse(cart, cart.id);
    }, async (id, { container }) => { if (id) await container.resolve(Modules.CART).deleteCarts(id); });
    const cartWorkflow = createWorkflow("synthetic-native-customer-cart", function (input) { return new WorkflowResponse(makeCart(input)); });
    const cartA = (await cartWorkflow(container).run({ input: { customerId: actor.customerId }, logOnError: false })).result;
    const cartB = (await cartWorkflow(container).run({ input: { customerId: first.result.customerId }, logOnError: false })).result;
    assert.equal((await requestAt("/auth/customer/tcm/owned", { ...actor, action: "read_cart", resourceId: cartA.id }, credential.token)).cart.id, cartA.id);
    await assert.rejects(requestAt("/auth/customer/tcm/owned", { ...actor, action: "read_cart", resourceId: cartB.id }, credential.token), error => error.status === 404);
    const makeOrder = createStep("synthetic-native-owned-order", async (data, { container }) => {
      const order = await container.resolve(Modules.ORDER).createOrders({ currency_code: "usd", customer_id: data.customerId, metadata: { fixture: "m1b-synthetic-only" } });
      return new StepResponse(order);
    });
    const orderWorkflow = createWorkflow("synthetic-native-owned-order", function (input) { return new WorkflowResponse(makeOrder(input)); });
    const orderA = (await orderWorkflow(container).run({ input: { customerId: actor.customerId }, logOnError: false })).result;
    await orderWorkflow(container).run({ input: { customerId: first.result.customerId }, logOnError: false });
    const ownedOrders = await requestAt("/auth/customer/tcm/owned", { ...actor, action: "read_orders" }, credential.token);
    assert.deepEqual(ownedOrders.orders.map(order => order.id), [orderA.id]);
    const { generateJwtToken, ContainerRegistrationKeys } = require("@medusajs/framework/utils");
    const adminLike = generateJwtToken({ actor_type: "user", actor_id: "user_synthetic", auth_identity_id: actor.authIdentityId, app_metadata: { customer_id: actor.customerId } },
      { secret: container.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig.http.jwtSecret, expiresIn: 300, jwtOptions: { algorithm: "HS256", issuer: origin, audience: "urn:vynvori:medusa:staging" } });
    await assert.rejects(requestAt("/auth/customer/tcm/owned", { ...actor, action: "read_customer" }, adminLike), error => error.status === 401);
    await assert.rejects(sdk.client.fetch("/store/customers/me", { headers: { authorization: "Bearer " + credential.token } }), error => error.status === 401);
    privateCentralRevoked = true;
    await assert.rejects(requestAt("/auth/customer/tcm/owned", { ...actor, action: "read_customer" }, credential.token), error => error.status === 401);
    if (process.env.M1B_BROWSER_FIXTURE_ROOT) {
      const { join } = require("node:path"), { pathToFileURL } = require("node:url");
      const root = process.env.M1B_BROWSER_FIXTURE_ROOT;
      const { startProcess, waitProcess, stopProcess } = await import(pathToFileURL(join(root, "scripts/process-lifecycle.mjs")).href);
      const child = startProcess(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/m1b-browser-stack-fixture.mjs"],
        { cwd: root, env: { ...process.env, M1B_TEST_MEDUSA_ORIGIN: origin } });
      let stdout = "", stderr = "", pending = "", readyError;
      child.child.stdout.on("data", chunk => {
        stdout += chunk; pending += chunk;
        let boundary;
        while ((boundary = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, boundary).trim(); pending = pending.slice(boundary + 1);
          if (line.startsWith("M1B_BROWSER_AUTHORITY ")) {
            const parsed = new URL(line.slice("M1B_BROWSER_AUTHORITY ".length));
            assert.equal(parsed.protocol, "http:"); assert.equal(parsed.hostname, "127.0.0.1"); browserAuthority = parsed.origin;
            void originalFetch(browserAuthority + "/_fixture/ready", { method: "POST" }).catch(() => { readyError = true; });
          }
        }
      });
      child.child.stderr.on("data", chunk => { stderr += chunk; });
      try {
        await waitProcess(child, 70000, "Synthetic connected browser fixture");
        assert.ok(!readyError);
        const marker = stdout.split(/\r?\n/).find(line => line.startsWith("M1B_BROWSER_RECEIPT ")); assert.ok(marker);
        browserEvidence = JSON.parse(marker.slice("M1B_BROWSER_RECEIPT ".length));
      } finally {
        browserAuthority = undefined;
        await stopProcess(child, { graceMs: 1000, killMs: 3000, report: () => {} });
        // Synthetic fixture diagnostics remain in the existing private native-run log directory.
        const { writeFile } = require("node:fs/promises");
        await writeFile(join(process.cwd(), "browser-stack.stdout.private.log"), stdout);
        await writeFile(join(process.cwd(), "browser-stack.stderr.private.log"), stderr);
      }
    }
  } finally { await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
  console.log("M1B_NATIVE_RECEIPT " + JSON.stringify({ status: "PASS_NATIVE_MODULES_AND_WORKFLOWS", authIdentityRace: "ONE_NATIVE_IDENTITY", firstCustomer: "ONE_NATIVE_CUSTOMER", emailCollision: "DENIED_NO_LINK", contactChange: "SAME_CUSTOMER", orphanRecovery: "SAME_CUSTOMER_NO_CREATE", unresolvedReconcile: "NO_CREATE", privateHttp: "ACTUAL_SDK_ROUTER_PROVIDER_LOCKS_AND_MODULES_PASS", duplicateDelivery: "ONE_CUSTOMER_AND_PERSISTED_EXECUTION", incompleteExecution: "PENDING_NO_CREATE", requestProof: "INVALID_OR_BROWSER_OR_OVERRIDE_DENIED", customerBearer: "CUSTOMER_ONLY_BOUND_MAX300_SECONDS", ownedReads: "PROFILE_ORDERS_OWN_CART_PASS", crossAccountCart: "DENIED_404", staffToken: "DENIED_401", directStockCustomerRoute: "DENIED_401", centralRevocationWithLiveCustomerJwt: "DENIED_401", browser: browserEvidence, platformIam: "TOKEN_FORWARDED_NOT_CLOUD_VALIDATED", providerRegistration: "LOCAL_TEST_CONFIGURATION_ONLY", publicServer: false }));
};
