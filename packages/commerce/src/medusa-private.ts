import "server-only";
import Medusa, { FetchError } from "@medusajs/js-sdk";
import { bridgeRequestProof, type BridgePayload } from "./medusa-proof-core";
import { centralEntityId } from "./central-identity";
import { CommerceIdentityError, type NativeCustomerProvisioner, type ProvisioningResult } from "./commerce-identity";
import { CustomerAccessError, type PrivateCustomerTransport, type CustomerMappingRef, type OwnedCustomerResult, type CustomerCredential } from "./customer-access";

export type PrivateMedusaConfig = Readonly<{ enabled: boolean; deployment: "local" | "staging"; origin: string; projectId: string; proofKeyId: string; proofKeys: Readonly<Record<string, Uint8Array>> }>;
export type PrivateServiceIdentity = (audience: string) => Promise<string>;
/** Fixed server-only SDK surface. No Admin API key, cookie jar, generic path or token persistence. */
export function privateMedusaClient(input: PrivateMedusaConfig, serviceIdentity: PrivateServiceIdentity): NativeCustomerProvisioner & PrivateCustomerTransport {
  const config = Object.freeze({ ...input });
  let sdk: Medusa | undefined, proof: ReturnType<typeof bridgeRequestProof> | undefined;
  if (config.enabled) {
    const url = new URL(config.origin);
    const local = config.deployment === "local" && url.protocol === "http:" && url.hostname === "127.0.0.1";
    const staging = config.deployment === "staging" && url.protocol === "https:" && url.hostname.endsWith(".run.app");
    if ((!local && !staging) || url.origin !== config.origin || !config.projectId || config.projectId.length > 256) throw new CommerceIdentityError("unavailable");
    proof = bridgeRequestProof({ origin: config.origin, projectId: config.projectId, keyId: config.proofKeyId, keys: config.proofKeys });
    const ignore = () => {};
    sdk = new Medusa({ baseUrl: config.origin, debug: false, auth: { type: "jwt", jwtTokenStorageMethod: "nostore", fetchCredentials: "omit" }, logger: { error: ignore, warn: ignore, info: ignore, debug: ignore } });
  }
  function mapping(value: CustomerMappingRef) {
    if (value.projectId !== config.projectId || ![value.authIdentityId, value.customerId].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new CustomerAccessError("not_found");
  }
  function customerFailure(error: unknown): CustomerAccessError {
    if (error instanceof CustomerAccessError) return error;
    if (error instanceof FetchError && error.status === 404) return new CustomerAccessError("not_found");
    if (error instanceof FetchError && error.status === 401) return new CustomerAccessError("reauth_required");
    return new CustomerAccessError("unavailable");
  }
  async function customerRpc(path: "/auth/customer/tcm/exchange" | "/auth/customer/tcm/owned", body: BridgePayload, accessToken: string, customerToken?: string): Promise<Record<string, unknown>> {
    if (!config.enabled || !sdk || !proof) throw new CustomerAccessError("disabled");
    try {
      const iam = await serviceIdentity(config.origin);
      if (!iam || iam.length > 16384 || /[\x00-\x20\x7f]/.test(iam)) throw new Error();
      const response = await sdk.client.fetch<Response>(path, { method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${accessToken}`, "x-serverless-authorization": `Bearer ${iam}`, "x-vynvori-bridge": proof.sign(path, body, accessToken), accept: "application/vnd.vynvori.bridge+json",
          ...(customerToken ? { "x-vynvori-customer-bearer": `Bearer ${customerToken}` } : {}) } });
      if (response.status !== 200 || !response.body) throw new Error();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 32768) throw new Error(); chunks.push(part.value); } }
      finally { await reader.cancel(); reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch (error) { throw customerFailure(error); }
  }
  const contactText = (value: unknown, max: number): value is string | null => value === null || (typeof value === "string" && value.length <= max && !/[\x00-\x1f\x7f]/.test(value));
  return Object.freeze({
    async exchange(value: Parameters<PrivateCustomerTransport["exchange"]>[0]): Promise<CustomerCredential> {
      try {
        mapping(value.mapping);
        const data = await customerRpc("/auth/customer/tcm/exchange", { authIdentityId: value.mapping.authIdentityId, customerId: value.mapping.customerId }, value.accessToken);
        if (data.projectId !== config.projectId || data.customerId !== value.mapping.customerId || data.authIdentityId !== value.mapping.authIdentityId || typeof data.token !== "string" || data.token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token)) throw new Error();
        // Consistency only. Medusa verifies the signature; its signing secret never enters the BFF.
        const header = JSON.parse(Buffer.from(data.token.split(".")[0]!, "base64url").toString()) as Record<string, unknown>;
        if (header.alg !== "HS256" || header.typ !== "JWT") throw new Error();
        const claims = JSON.parse(Buffer.from(data.token.split(".")[1]!, "base64url").toString()) as Record<string, unknown>, metadata = claims.app_metadata as Record<string, unknown> | undefined;
        if (claims.actor_type !== "customer" || claims.actor_id !== value.mapping.customerId || claims.auth_identity_id !== value.mapping.authIdentityId || claims.auth_provider !== "tcm" || metadata?.customer_id !== value.mapping.customerId ||
            claims.iss !== config.origin || claims.aud !== "urn:vynvori:medusa:staging" || !Number.isSafeInteger(claims.exp) || (claims.exp as number) * 1000 !== data.expiresAt ||
            (data.expiresAt as number) <= Date.now() || (data.expiresAt as number) > value.identity.expiresAt) throw new Error();
        return Object.freeze({ token: data.token, expiresAt: data.expiresAt as number });
      } catch (error) { throw customerFailure(error); }
    },
    async owned(value: Parameters<PrivateCustomerTransport["owned"]>[0]): Promise<OwnedCustomerResult> {
      try {
        mapping(value.mapping);
        const data = await customerRpc("/auth/customer/tcm/owned", { authIdentityId: value.mapping.authIdentityId, customerId: value.mapping.customerId, action: value.request.action,
          ...(value.request.action === "read_cart" ? { resourceId: value.request.resourceId } : {}) }, value.accessToken, value.customerToken);
        if (value.request.action === "read_customer" && data.kind === "customer") {
          const row = data.customer as Record<string, unknown>;
          if (!row || row.id !== value.mapping.customerId || !contactText(row.email, 254) || !contactText(row.firstName, 200) || !contactText(row.lastName, 200)) throw new Error();
          return { kind: "customer", customer: { id: value.mapping.customerId, email: row.email, firstName: row.firstName, lastName: row.lastName } };
        }
        if (value.request.action === "read_cart" && data.kind === "cart") { const row = data.cart as Record<string, unknown>; if (!row || row.id !== value.request.resourceId) throw new Error(); return { kind: "cart", cart: { id: value.request.resourceId } }; }
        if (value.request.action === "read_orders" && data.kind === "orders" && Array.isArray(data.orders) && data.orders.length <= 50 && typeof data.hasMore === "boolean") {
          const orders = data.orders.map((row: Record<string, unknown>) => { if (!row || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(row.id) || typeof row.status !== "string" || row.status.length > 64 || typeof row.createdAt !== "string" || row.createdAt.length > 32 || !Number.isFinite(Date.parse(row.createdAt))) throw new Error(); return { id: row.id, status: row.status, createdAt: row.createdAt }; });
          return { kind: "orders", orders, hasMore: data.hasMore };
        }
        throw new Error();
      } catch (error) { throw customerFailure(error); }
    },
    async ensure(value: Parameters<NativeCustomerProvisioner["ensure"]>[0]): Promise<ProvisioningResult> {
      if (!config.enabled || !sdk || !proof) throw new CommerceIdentityError("disabled");
      if (value.projectId !== config.projectId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.operationId) || !["create", "reconcile"].includes(value.mode)) throw new CommerceIdentityError("conflict");
      const path = "/auth/customer/tcm/provision", body = { mode: value.mode, operationId: value.operationId, originalEmail: value.originalEmail };
      let dispatched = false;
      try {
        const iam = await serviceIdentity(config.origin);
        if (!iam || iam.length > 16384 || /[\x00-\x20\x7f]/.test(iam)) throw new Error();
        const headers = { authorization: `Bearer ${value.accessToken}`, "x-serverless-authorization": `Bearer ${iam}`, "x-vynvori-bridge": proof.sign(path, body, value.accessToken), accept: "application/vnd.vynvori.bridge+json" };
        dispatched = true;
        const response = await sdk.client.fetch<Response>(path, { method: "POST", body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000), headers });
        if (![200, 202].includes(response.status) || !response.body) throw new Error();
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
        try {
          while (true) { const part = await reader.read(); if (part.done) break; bytes += part.value.length; if (bytes > 16384) throw new Error(); chunks.push(part.value); }
        } finally { await reader.cancel(); reader.releaseLock(); }
        const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!result || typeof result !== "object") throw new Error();
        const data = result as Record<string, unknown>, entityId = centralEntityId(value.identity.issuer, value.identity.subject);
        if (data.operationId !== value.operationId || data.projectId !== config.projectId || data.entityId !== entityId) throw new CommerceIdentityError("conflict");
        if (data.state === "reconcile_required") return { state: "reconcile_required", projectId: config.projectId, entityId, operationId: value.operationId };
        if (data.state !== "ready" || ![data.authIdentityId, data.customerId].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new Error();
        return { state: "ready", projectId: config.projectId, operationId: value.operationId, entityId, authIdentityId: data.authIdentityId as string, customerId: data.customerId as string };
      } catch (error) {
        if (!dispatched) throw new CommerceIdentityError("not_started");
        if (error instanceof CommerceIdentityError) throw error;
        if (error instanceof FetchError && error.status === 409) throw new CommerceIdentityError("conflict");
        throw new CommerceIdentityError("unavailable");
      }
    },
  });
}
