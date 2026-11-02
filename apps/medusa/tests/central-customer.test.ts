import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createMedusaContainer, Modules } from "@medusajs/framework/utils";
import { asValue } from "@medusajs/framework/awilix";
import type { AuthIdentityDTO, CustomerDTO, CreateCustomerDTO } from "@medusajs/framework/types";
import { inspectCentralCustomer, customerIdentityMetadata, type CentralCustomerInput } from "../src/workflows/steps/central-customer";
import { centralCustomerWorkflow } from "../src/workflows/central-customer";
import { centralEntityId } from "../src/modules/tcm-auth/service";

function fixture() {
  const input: CentralCustomerInput = { mode: "create", authIdentityId: "authid_synthetic", issuer: "https://identity.example.invalid", subject: "synthetic-subject", projectId: "synthetic-project", operationId: randomUUID(), originalEmail: "synthetic@example.invalid" };
  const identity: AuthIdentityDTO = { id: input.authIdentityId, app_metadata: {}, provider_identities: [{ id: "pi_synthetic", provider: "tcm", entity_id: centralEntityId(input.issuer, input.subject), provider_metadata: { issuer: input.issuer, subject: input.subject } }] };
  const rows = new Map<string, CustomerDTO>(); let created = 0, linked = 0;
  const auth = {
    async retrieveAuthIdentity() { return { ...identity, app_metadata: { ...identity.app_metadata } }; },
    async updateAuthIdentities(data: { id: string; app_metadata: Record<string, unknown> }) { linked++; identity.app_metadata = { ...data.app_metadata }; return identity; },
  };
  const customers = {
    async retrieveCustomer(id: string) { const row = rows.get(id); assert.ok(row); return row; },
    async listCustomers(filters: { email?: unknown }) { return [...rows.values()].filter(row => row.email === filters.email); },
    async createCustomers(inputs: CreateCustomerDTO[]) {
      return inputs.map(data => { const customer = { ...data, id: `cus_synthetic_${++created}` } as CustomerDTO; rows.set(customer.id, customer); return customer; });
    },
    async deleteCustomers(ids: string[]) { for (const id of ids) rows.delete(id); },
  };
  const container = createMedusaContainer();
  container.register({ [Modules.AUTH]: asValue(auth), [Modules.CUSTOMER]: asValue(customers),
    [Modules.EVENT_BUS]: asValue({ async emit() {}, async releaseGroupedEvents() {}, async clearGroupedEvents() {} }) });
  return { input, identity, rows, services: { auth, customers }, container, counts: () => ({ created, linked }) };
}
test("native workflow creates one customer through stock account workflow and preserves repeat mapping", async () => {
  const f = fixture(); const first = await centralCustomerWorkflow(f.container).run({ input: f.input, logOnError: false });
  assert.equal(first.result.state, "ready"); assert.equal(first.result.customerId, "cus_synthetic_1");
  assert.equal(f.identity.app_metadata?.customer_id, "cus_synthetic_1");
  assert.deepEqual(f.rows.get("cus_synthetic_1")?.metadata, customerIdentityMetadata(f.input));
  const repeated = await centralCustomerWorkflow(f.container).run({ input: f.input, logOnError: false });
  assert.equal(repeated.result.customerId, first.result.customerId); assert.equal(f.counts().created, 1);
});
test("native reconciliation repairs an exact operation-marked orphan without creating another customer", async () => {
  const f = fixture();
  f.rows.set("cus_orphan", { id: "cus_orphan", email: f.input.originalEmail, has_account: true, metadata: customerIdentityMetadata(f.input) } as CustomerDTO);
  const result = await centralCustomerWorkflow(f.container).run({ input: { ...f.input, mode: "reconcile" }, logOnError: false });
  assert.equal(result.result.customerId, "cus_orphan"); assert.equal(f.counts().created, 0); assert.equal(f.counts().linked, 1);
});
test("reconciliation with no proven native customer remains pending and never creates", async () => {
  const f = fixture(); const result = await centralCustomerWorkflow(f.container).run({ input: { ...f.input, mode: "reconcile" }, logOnError: false });
  assert.equal(result.result.state, "reconcile_required"); assert.deepEqual(f.counts(), { created: 0, linked: 0 });
});
test("email collision alone is a conflict, including an existing guest customer", async () => {
  for (const has_account of [true, false]) {
    const f = fixture(); f.rows.set("cus_other", { id: "cus_other", email: f.input.originalEmail, has_account, metadata: {} } as CustomerDTO);
    await assert.rejects(inspectCentralCustomer(f.input, f.services), /Commerce identity conflict/);
    assert.deepEqual(f.counts(), { created: 0, linked: 0 });
  }
});
test("a customer linked to another identity/operation cannot be adopted", async () => {
  const f = fixture(); f.identity.app_metadata = { customer_id: "cus_other" };
  f.rows.set("cus_other", { id: "cus_other", email: f.input.originalEmail, has_account: true, metadata: { ...customerIdentityMetadata(f.input), vynvori_operation_id: randomUUID() } } as CustomerDTO);
  await assert.rejects(inspectCentralCustomer(f.input, f.services), /Commerce identity conflict/);
});
test("changed contact cannot create a new customer for an existing identity mapping", async () => {
  const f = fixture(); await centralCustomerWorkflow(f.container).run({ input: f.input, logOnError: false });
  const result = await centralCustomerWorkflow(f.container).run({ input: { ...f.input, originalEmail: "changed@example.invalid" }, logOnError: false });
  assert.equal(result.result.customerId, "cus_synthetic_1"); assert.equal(f.counts().created, 1);
});

// Unverified central email: no contact email is written, login/account creation still proceed.
import { verifiedContactEmail } from "../src/workflows/steps/central-customer";
import { ProvisionSchema } from "../src/auth/provision-schema";
test("only a centrally verified email is eligible as the Medusa contact email", () => {
  assert.equal(verifiedContactEmail({ email: "a@example.invalid", emailVerified: true }), "a@example.invalid");
  assert.equal(verifiedContactEmail({ email: "a@example.invalid", emailVerified: false }), "");
});
test("provision wire schema keeps the email key required but accepts only empty or a valid address", () => {
  const base = { mode: "create", operationId: randomUUID() };
  assert.ok(ProvisionSchema.safeParse({ ...base, originalEmail: "" }).success);
  assert.ok(ProvisionSchema.safeParse({ ...base, originalEmail: "a@example.invalid" }).success);
  for (const originalEmail of ["not-an-email", " a@example.invalid", "a@example.invalid\n", null, undefined, 7]) assert.equal(ProvisionSchema.safeParse({ ...base, originalEmail }).success, false);
  assert.equal(ProvisionSchema.safeParse(base).success, false);
});
test("blank contact creates a linked account customer with no email through stock customer steps, once", async () => {
  const f = fixture(); const input = { ...f.input, originalEmail: "" };
  f.rows.set("cus_unrelated", { id: "cus_unrelated", email: "someone@example.invalid", has_account: true, metadata: {} } as CustomerDTO);
  const first = await centralCustomerWorkflow(f.container).run({ input, logOnError: false });
  assert.equal(first.result.state, "ready"); assert.equal(first.result.customerId, "cus_synthetic_1");
  const row = f.rows.get("cus_synthetic_1")!;
  assert.ok(!row.email, "no email may be written"); assert.equal(row.has_account, true);
  assert.deepEqual(row.metadata, customerIdentityMetadata(input));
  assert.equal(f.identity.app_metadata?.customer_id, "cus_synthetic_1");
  assert.deepEqual(f.counts(), { created: 1, linked: 1 });
  const repeated = await centralCustomerWorkflow(f.container).run({ input, logOnError: false });
  assert.equal(repeated.result.customerId, "cus_synthetic_1"); assert.deepEqual(f.counts(), { created: 1, linked: 1 });
});
test("blank contact never creates during reconciliation, even with an unprovable orphan", async () => {
  const f = fixture(); const input = { ...f.input, originalEmail: "", mode: "reconcile" as const };
  f.rows.set("cus_orphan", { id: "cus_orphan", has_account: true, metadata: customerIdentityMetadata(input) } as CustomerDTO);
  const result = await centralCustomerWorkflow(f.container).run({ input, logOnError: false });
  assert.equal(result.result.state, "reconcile_required"); assert.deepEqual(f.counts(), { created: 0, linked: 0 });
});
test("blank contact still validates identity and rejects malformed addresses", async () => {
  const f = fixture();
  await assert.rejects(inspectCentralCustomer({ ...f.input, originalEmail: "bad address" }, f.services), /Commerce identity conflict/);
  await assert.rejects(inspectCentralCustomer({ ...f.input, originalEmail: "", operationId: "not-a-uuid" }, f.services), /Commerce identity conflict/);
  assert.deepEqual(await inspectCentralCustomer({ ...f.input, originalEmail: "" }, f.services), { existingCustomerId: null, needsLink: false, canCreate: true });
});
