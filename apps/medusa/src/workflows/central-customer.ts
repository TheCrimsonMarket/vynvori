import { createWorkflow, WorkflowResponse, transform, when } from "@medusajs/framework/workflows-sdk";
import { createCustomerAccountWorkflow, createCustomersWorkflow, setAuthAppMetadataStep } from "@medusajs/medusa/core-flows";
import { centralEntityId } from "../modules/tcm-auth/service";
import { inspectCentralCustomerStep, confirmCentralCustomerStep, customerIdentityMetadata, type CentralCustomerInput } from "./steps/central-customer";

/** Only the durable journal's winning dispatch may use create mode. Reconciliation never creates. */
export const centralCustomerWorkflow = createWorkflow({ name: "vynvori-central-customer", store: true, idempotent: true, retentionTime: 28800 }, function (input: CentralCustomerInput) {
  const inspection = inspectCentralCustomerStep(input);
  const created = when("create-new-central-customer", { inspection, input }, ({ inspection, input }) => inspection.canCreate && input.originalEmail !== "").then(() => {
    const customerData = transform({ input }, ({ input }) => ({ email: input.originalEmail, metadata: customerIdentityMetadata(input) }));
    return createCustomerAccountWorkflow.runAsStep({ input: { authIdentityId: input.authIdentityId, customerData } });
  });
  // Stock account creation requires an email. With no verified email, use the stock customer step without one;
  // the single link step below then binds it, exactly as it binds an exact operation-marked orphan.
  const createdBlank = when("create-new-central-customer-without-contact", { inspection, input }, ({ inspection, input }) => inspection.canCreate && input.originalEmail === "").then(() => {
    const customersData = transform({ input }, ({ input }) => [{ metadata: customerIdentityMetadata(input), has_account: true }]);
    const customers = createCustomersWorkflow.runAsStep({ input: { customersData } });
    return transform({ customers }, ({ customers }) => customers[0]!);
  });
  const repaired = when("link-central-customer", { inspection, createdBlank }, ({ inspection, createdBlank }) => inspection.needsLink || !!createdBlank).then(() => {
    const customerId = transform({ inspection, createdBlank }, ({ inspection, createdBlank }) => (inspection.existingCustomerId ?? createdBlank?.id) as string);
    return setAuthAppMetadataStep({ authIdentityId: input.authIdentityId, actorType: "customer", value: customerId });
  });
  const confirmation = transform({ input, inspection, created, createdBlank, repaired }, ({ input, inspection, created, createdBlank }) => ({ ...input, customerId: inspection.existingCustomerId ?? created?.id ?? createdBlank?.id ?? null }));
  const customerId = confirmCentralCustomerStep(confirmation);
  const result = transform({ input, customerId }, ({ input, customerId }) => ({ state: customerId ? "ready" as const : "reconcile_required" as const,
    projectId: input.projectId, entityId: centralEntityId(input.issuer, input.subject), operationId: input.operationId,
    ...(customerId ? { authIdentityId: input.authIdentityId, customerId } : {}) }));
  return new WorkflowResponse(result);
});
