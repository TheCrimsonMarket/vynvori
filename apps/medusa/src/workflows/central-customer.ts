import { createWorkflow, WorkflowResponse, transform, when } from "@medusajs/framework/workflows-sdk";
import { createCustomerAccountWorkflow, setAuthAppMetadataStep } from "@medusajs/medusa/core-flows";
import { centralEntityId } from "../modules/tcm-auth/service";
import { inspectCentralCustomerStep, confirmCentralCustomerStep, customerIdentityMetadata, type CentralCustomerInput } from "./steps/central-customer";

/** Only the durable journal's winning dispatch may use create mode. Reconciliation never creates. */
export const centralCustomerWorkflow = createWorkflow({ name: "vynvori-central-customer", store: true, idempotent: true, retentionTime: 28800 }, function (input: CentralCustomerInput) {
  const inspection = inspectCentralCustomerStep(input);
  const created = when("create-new-central-customer", { inspection }, ({ inspection }) => inspection.canCreate).then(() => {
    const customerData = transform({ input }, ({ input }) => ({ email: input.originalEmail, metadata: customerIdentityMetadata(input) }));
    return createCustomerAccountWorkflow.runAsStep({ input: { authIdentityId: input.authIdentityId, customerData } });
  });
  const repaired = when("repair-orphan-central-customer-link", { inspection }, ({ inspection }) => inspection.needsLink).then(() => {
    return setAuthAppMetadataStep({ authIdentityId: input.authIdentityId, actorType: "customer", value: inspection.existingCustomerId });
  });
  const confirmation = transform({ input, inspection, created, repaired }, ({ input, inspection, created }) => ({ ...input, customerId: inspection.existingCustomerId ?? created?.id ?? null }));
  const customerId = confirmCentralCustomerStep(confirmation);
  const result = transform({ input, customerId }, ({ input, customerId }) => ({ state: customerId ? "ready" as const : "reconcile_required" as const,
    projectId: input.projectId, entityId: centralEntityId(input.issuer, input.subject), operationId: input.operationId,
    ...(customerId ? { authIdentityId: input.authIdentityId, customerId } : {}) }));
  return new WorkflowResponse(result);
});
