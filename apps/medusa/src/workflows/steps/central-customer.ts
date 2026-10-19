import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { Modules, MedusaError } from "@medusajs/framework/utils";
import type { CustomerDTO, IAuthModuleService, ICustomerModuleService } from "@medusajs/framework/types";
import { assertCentralAuthIdentity, centralEntityId } from "../../modules/tcm-auth/service";

/** Internal workflow input: boundary must freshly authenticate central bearer first. No token is persisted in workflow input. */
export type CentralCustomerInput = Readonly<{ mode: "create" | "reconcile"; authIdentityId: string; issuer: string; subject: string; projectId: string; operationId: string; originalEmail: string }>;
type Services = { auth: Pick<IAuthModuleService, "retrieveAuthIdentity">; customers: Pick<ICustomerModuleService, "retrieveCustomer" | "listCustomers"> };
export type CustomerInspection = Readonly<{ existingCustomerId: string | null; needsLink: boolean; canCreate: boolean }>;
const conflict = () => new MedusaError(MedusaError.Types.DUPLICATE_ERROR, "Commerce identity conflict");
export function customerIdentityMetadata(input: CentralCustomerInput): Record<string, string> {
  return { vynvori_identity_v1: centralEntityId(input.issuer, input.subject), vynvori_project_id: input.projectId,
    vynvori_auth_identity_id: input.authIdentityId, vynvori_operation_id: input.operationId };
}
function belongs(customer: CustomerDTO, input: CentralCustomerInput): boolean {
  return Object.entries(customerIdentityMetadata(input)).every(([key, value]) => customer.metadata?.[key] === value);
}
function validate(input: CentralCustomerInput) {
  let validIssuer = false;
  try { const url = new URL(input.issuer); validIssuer = url.protocol === "https:" && url.origin === input.issuer; } catch { /* sanitized below */ }
  if (!validIssuer || !input.subject || input.subject.length > 4096 || !input.projectId || input.projectId.length > 256 ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(input.authIdentityId) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.operationId) ||
      !["create", "reconcile"].includes(input.mode) || input.originalEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.originalEmail) || /[\x00-\x1f\x7f]/.test(input.originalEmail)) throw conflict();
}
export async function inspectCentralCustomer(input: CentralCustomerInput, services: Services): Promise<CustomerInspection> {
  validate(input);
  const auth = await services.auth.retrieveAuthIdentity(input.authIdentityId, { relations: ["provider_identities"] });
  assertCentralAuthIdentity(auth, input);
  const linked = auth.app_metadata?.customer_id;
  if (linked !== undefined && linked !== null) {
    if (typeof linked !== "string" || !linked) throw conflict();
    const customer = await services.customers.retrieveCustomer(linked);
    if (!belongs(customer, input) || !customer.has_account) throw conflict();
    return { existingCustomerId: customer.id, needsLink: false, canCreate: false };
  }
  // Email only narrows the native read. All identity+operation metadata must match before orphan repair.
  const candidates = await services.customers.listCustomers({ email: input.originalEmail }, { take: 100 });
  if (candidates.length >= 100) throw conflict();
  const own = candidates.filter(customer => belongs(customer, input) && customer.has_account);
  if (own.length > 1) throw conflict();
  if (own.length === 1) return { existingCustomerId: own[0]!.id, needsLink: true, canCreate: false };
  if (candidates.length) throw conflict(); // No email-only linking, guest conversion or silent merge.
  return { existingCustomerId: null, needsLink: false, canCreate: input.mode === "create" };
}
export const inspectCentralCustomerStep = createStep("vynvori-inspect-central-customer", async (input: CentralCustomerInput, { container }) => {
  return new StepResponse(await inspectCentralCustomer(input, { auth: container.resolve(Modules.AUTH), customers: container.resolve(Modules.CUSTOMER) }));
});
export const confirmCentralCustomerStep = createStep("vynvori-confirm-central-customer", async (input: CentralCustomerInput & { customerId: string | null }, { container }) => {
  if (!input.customerId) return new StepResponse<string | null>(null);
  const authService = container.resolve<IAuthModuleService>(Modules.AUTH), customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const auth = await authService.retrieveAuthIdentity(input.authIdentityId, { relations: ["provider_identities"] });
  assertCentralAuthIdentity(auth, input);
  if (auth.app_metadata?.customer_id !== input.customerId || !belongs(await customers.retrieveCustomer(input.customerId), input)) throw conflict();
  return new StepResponse<string | null>(input.customerId);
});
