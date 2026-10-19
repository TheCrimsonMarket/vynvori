import "server-only";
import type { VerifiedCentralIdentity } from "./central-identity";
export type CustomerMappingRef = Readonly<{ userId: string; projectId: string; authIdentityId: string; customerId: string }>;
export type CustomerCredential = Readonly<{ token: string; expiresAt: number }>;
export type CustomerRead = Readonly<{ action: "read_customer" | "read_orders" }> | Readonly<{ action: "read_cart"; resourceId: string }>;
export type OwnedCustomerData = Readonly<{ kind: "customer"; customer: Readonly<{ id: string; email: string | null; firstName: string | null; lastName: string | null }> }>;
export type OwnedOrdersData = Readonly<{ kind: "orders"; orders: readonly Readonly<{ id: string; status: string; createdAt: string }>[]; hasMore: boolean }>;
export type OwnedCartData = Readonly<{ kind: "cart"; cart: Readonly<{ id: string }> }>;
export type OwnedCustomerResult = OwnedCustomerData | OwnedOrdersData | OwnedCartData;
export interface PrivateCustomerTransport {
  exchange(value: { identity: VerifiedCentralIdentity; mapping: CustomerMappingRef; accessToken: string }): Promise<CustomerCredential>;
  owned(value: { identity: VerifiedCentralIdentity; mapping: CustomerMappingRef; accessToken: string; customerToken: string; request: CustomerRead }): Promise<OwnedCustomerResult>;
}
export class CustomerAccessError extends Error {
  constructor(readonly code: "not_found" | "reauth_required" | "unavailable" | "disabled") { super(code); this.name = "CustomerAccessError"; }
}
