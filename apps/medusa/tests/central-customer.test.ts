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
