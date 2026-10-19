import { randomUUID } from "node:crypto";
import { Modules, MedusaError, TransactionState, ContainerRegistrationKeys, generateJwtToken } from "@medusajs/framework/utils";
import { getAuthContextFromJwtToken } from "@medusajs/framework/http";
import type { IAuthModuleService, ICustomerModuleService, ILockingModule, IWorkflowEngineService, IOrderModuleService, ICartModuleService, MedusaContainer, ConfigModule } from "@medusajs/framework/types";
import { centralIdentityClient, centralEntityId } from "./central-identity";
import { centralCustomerWorkflow } from "../workflows/central-customer";
import { inspectCentralCustomer, type CentralCustomerInput } from "../workflows/steps/central-customer";
import type { BridgeSettings } from "./bridge-settings";
import { assertCentralAuthIdentity } from "../modules/tcm-auth/service";

export type ProvisionBody = Readonly<{ mode: "create" | "reconcile"; operationId: string; originalEmail: string }>;
type Headers = Readonly<{ authorization?: string; origin?: string; cookie?: string; proof?: string; customerBearer?: string }>;
export type ExchangeBody = Readonly<{ authIdentityId: string; customerId: string }>;
export type OwnedBody = ExchangeBody & Readonly<{ action: "read_customer" | "read_orders" | "read_cart"; resourceId?: string }>;
export class PrivateBridgeError extends Error { constructor(readonly status: number, readonly code: "BRIDGE_FORBIDDEN" | "BRIDGE_REAUTH_REQUIRED" | "BRIDGE_CONTACT_REQUIRED" | "BRIDGE_CONFLICT" | "BRIDGE_UNAVAILABLE" | "BRIDGE_NOT_FOUND") { super(code); this.name = "PrivateBridgeError"; } }
export function privateMedusaBridge(settings: Extract<BridgeSettings, { enabled: true }>, container: MedusaContainer, transport: typeof fetch = fetch) {
  const authority = centralIdentityClient(settings, transport);
  const auth = container.resolve<IAuthModuleService>(Modules.AUTH), customers = container.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const locks = container.resolve<ILockingModule>(Modules.LOCKING), engine = container.resolve<IWorkflowEngineService>(Modules.WORKFLOW_ENGINE);
  function credential(headers: Headers, body: Readonly<Record<string, string>>, path = "/auth/customer/tcm/provision") {
    if (headers.origin !== undefined || headers.cookie !== undefined || typeof headers.authorization !== "string" || !/^Bearer [^\s]{1,4096}$/.test(headers.authorization)) throw new PrivateBridgeError(403, "BRIDGE_FORBIDDEN");
    const token = headers.authorization.slice(7);
    if (!settings.proof.verify(headers.proof, path, body, token)) throw new PrivateBridgeError(403, "BRIDGE_FORBIDDEN");
    return token;
  }
  const missing = () => new PrivateBridgeError(404, "BRIDGE_NOT_FOUND");
  async function binding(token: string, body: ExchangeBody) {
    const identity = await authority.verifyIdentity(token);
    const authenticated = await auth.authenticate("tcm", { headers: { authorization: `Bearer ${token}` } });
    if (!authenticated.success || !authenticated.authIdentity || authenticated.mfaChallenge) throw new PrivateBridgeError(401, "BRIDGE_REAUTH_REQUIRED");
    assertCentralAuthIdentity(authenticated.authIdentity, identity);
    if (authenticated.authIdentity.id !== body.authIdentityId || authenticated.authIdentity.app_metadata?.customer_id !== body.customerId) throw missing();
    const customer = await customers.retrieveCustomer(body.customerId).catch(() => { throw missing(); });
    if (!customer.has_account || customer.metadata?.vynvori_identity_v1 !== centralEntityId(identity.issuer, identity.subject) ||
        customer.metadata?.vynvori_project_id !== settings.projectId || customer.metadata?.vynvori_auth_identity_id !== body.authIdentityId) throw missing();
    return { identity, customer };
  }
  function jwtSecret() { const value = container.resolve<ConfigModule>(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig.http.jwtSecret; if (typeof value !== "string" || value.length < 32) throw new PrivateBridgeError(503, "BRIDGE_UNAVAILABLE"); return value; }
  async function stillCurrent(token: string, subject: string) { if ((await authority.verifyIdentity(token)).subject !== subject) throw new PrivateBridgeError(401, "BRIDGE_REAUTH_REQUIRED"); }
  const text = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
  return Object.freeze({
    async exchange(headers: Headers, body: ExchangeBody) {
      const token = credential(headers, body, "/auth/customer/tcm/exchange"), current = await binding(token, body);
      await stillCurrent(token, current.identity.subject);
      const seconds = Math.floor(Date.now() / 1000), expiration = Math.min(seconds + 300, Math.floor(current.identity.expiresAt / 1000));
      if (expiration <= seconds) throw new PrivateBridgeError(401, "BRIDGE_REAUTH_REQUIRED");
      const customerToken = generateJwtToken({ actor_type: "customer", actor_id: body.customerId, auth_identity_id: body.authIdentityId, auth_provider: "tcm",
        app_metadata: { customer_id: body.customerId }, user_metadata: {}, iat: seconds, jti: randomUUID() },
      { secret: jwtSecret(), expiresIn: expiration - seconds, jwtOptions: { algorithm: "HS256", issuer: settings.origin, audience: "urn:vynvori:medusa:staging" } });
      return { token: customerToken, expiresAt: expiration * 1000, customerId: body.customerId, authIdentityId: body.authIdentityId, projectId: settings.projectId };
    },
    async owned(headers: Headers, body: OwnedBody) {
      const payload = { authIdentityId: body.authIdentityId, customerId: body.customerId, action: body.action, ...(body.resourceId ? { resourceId: body.resourceId } : {}) };
      const token = credential(headers, payload, "/auth/customer/tcm/owned");
      if (!headers.customerBearer || !/^Bearer [^\s]{1,8192}$/.test(headers.customerBearer)) throw new PrivateBridgeError(401, "BRIDGE_REAUTH_REQUIRED");
      const actor = getAuthContextFromJwtToken(headers.customerBearer, jwtSecret(), ["bearer"], ["customer"], undefined,
        { algorithms: ["HS256"], issuer: settings.origin, audience: "urn:vynvori:medusa:staging", ignoreExpiration: false, ignoreNotBefore: false });
      if (!actor || actor.actor_id !== body.customerId || actor.auth_identity_id !== body.authIdentityId || actor.auth_provider !== "tcm" || actor.app_metadata?.customer_id !== body.customerId) throw new PrivateBridgeError(401, "BRIDGE_REAUTH_REQUIRED");
      const current = await binding(token, body);
      let result;
      if (body.action === "read_customer") {
        result = { kind: "customer" as const, customer: { id: current.customer.id, email: text(current.customer.email, 254), firstName: text(current.customer.first_name, 200), lastName: text(current.customer.last_name, 200) } };
      } else if (body.action === "read_orders") {
        const orders = await container.resolve<IOrderModuleService>(Modules.ORDER).listOrders({ customer_id: body.customerId }, { take: 51, select: ["id", "customer_id", "status", "created_at"], order: { created_at: "DESC", id: "DESC" } });
        if (orders.some(order => order.customer_id !== body.customerId)) throw missing();
        result = { kind: "orders" as const, orders: orders.slice(0, 50).map(order => ({ id: order.id, status: order.status, createdAt: new Date(order.created_at).toISOString() })), hasMore: orders.length > 50 };
      } else {
        if (!body.resourceId) throw missing();
        const cart = await container.resolve<ICartModuleService>(Modules.CART).retrieveCart(body.resourceId, { select: ["id", "customer_id"] }).catch(() => { throw missing(); });
        if (cart.customer_id !== body.customerId) throw missing();
        result = { kind: "cart" as const, cart: { id: cart.id } };
      }
      await stillCurrent(token, current.identity.subject);
      return result;
    },
    async provision(headers: Headers, body: ProvisionBody) {
      const token = credential(headers, body);
      const identity = await authority.verifyContact(token);
      if (body.mode === "create" && body.originalEmail !== identity.email) throw new PrivateBridgeError(409, "BRIDGE_CONTACT_REQUIRED");
      const authenticated = await auth.authenticate("tcm", { headers: { authorization: headers.authorization! } });
      if (!authenticated.success || !authenticated.authIdentity || authenticated.mfaChallenge) throw new PrivateBridgeError(401, "BRIDGE_REAUTH_REQUIRED");
      const input: CentralCustomerInput = { ...body, authIdentityId: authenticated.authIdentity.id, issuer: identity.issuer, subject: identity.subject, projectId: settings.projectId };
      const entityId = centralEntityId(identity.issuer, identity.subject);
      const pending = () => ({ state: "reconcile_required" as const, projectId: settings.projectId, operationId: body.operationId, entityId });
      try {
        return await locks.execute(`vynvori-central:${entityId}`, async () => {
          credential(headers, body); // A request cannot sit in a queue until after its proof expires.
          const transactionId = `vynvori-create-${body.operationId}`;
          const executions = await engine.listWorkflowExecutions({ workflow_id: "vynvori-central-customer", transaction_id: transactionId }, { select: ["state"], take: 2 });
          if (executions.length > 1 || executions.some(execution => execution.state !== TransactionState.DONE)) return pending();
          if (executions.length) {
            const inspection = await inspectCentralCustomer(input, { auth, customers });
            if (inspection.existingCustomerId && !inspection.needsLink) {
              const current = await authority.verifyIdentity(token);
              if (current.subject !== identity.subject) throw new PrivateBridgeError(401, "BRIDGE_REAUTH_REQUIRED");
              return { state: "ready" as const, projectId: settings.projectId, operationId: body.operationId, entityId, authIdentityId: input.authIdentityId, customerId: inspection.existingCustomerId };
            }
            if (body.mode === "create") return pending();
          }
          // Never resume an uncertain create execution. Reconcile gets a distinct, no-create transaction.
          const contextId = body.mode === "create" ? transactionId : `vynvori-reconcile-${body.operationId}`;
          const result = await centralCustomerWorkflow(container).run({ input, context: { transactionId: contextId, runId: contextId }, logOnError: false });
          const current = await authority.verifyIdentity(token);
          if (current.subject !== identity.subject) throw new PrivateBridgeError(401, "BRIDGE_REAUTH_REQUIRED");
          return result.result;
        }, { provider: "postgres", timeout: 5 });
      } catch (error) {
        if (error instanceof PrivateBridgeError) throw error;
        if (error instanceof MedusaError && error.type === MedusaError.Types.DUPLICATE_ERROR) throw new PrivateBridgeError(409, "BRIDGE_CONFLICT");
        throw new PrivateBridgeError(503, "BRIDGE_UNAVAILABLE");
      }
    },
  });
}
