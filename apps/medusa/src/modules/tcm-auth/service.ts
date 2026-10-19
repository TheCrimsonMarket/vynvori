import { AbstractAuthModuleProvider, MedusaError } from "@medusajs/framework/utils";
import type { AuthenticationInput, AuthenticationResponse, AuthIdentityDTO, AuthIdentityProviderService } from "@medusajs/framework/types";
import { centralIdentityClient, CentralIdentityError, centralEntityId, type CentralIdentityConfig, type VerifiedCentralIdentity } from "../../auth/central-identity";
export { centralEntityId } from "../../auth/central-identity";

export const TCM_PROVIDER_ID = "tcm";
/** Hash is bounded for the native unique index; exact issuer+subject metadata is also verified. */
export function assertCentralAuthIdentity(auth: AuthIdentityDTO, identity: Pick<VerifiedCentralIdentity, "issuer" | "subject">): void {
  const entityId = centralEntityId(identity.issuer, identity.subject);
  const providers = auth.provider_identities?.filter(p => p.provider === TCM_PROVIDER_ID && p.entity_id === entityId) ?? [];
  if (providers.length !== 1 || providers[0]!.provider_metadata?.issuer !== identity.issuer || providers[0]!.provider_metadata?.subject !== identity.subject ||
      Object.prototype.hasOwnProperty.call(auth.app_metadata ?? {}, "user_id") || auth.app_metadata?.actor_type === "user") throw new Error("Identity conflict");
}

export default class TcmAuthProvider extends AbstractAuthModuleProvider {
  static identifier = TCM_PROVIDER_ID;
  static DISPLAY_NAME = "TCM";
  private readonly authority: ReturnType<typeof centralIdentityClient>;
  private readonly enabled: boolean;
  constructor(_container: Record<string, unknown>, options: CentralIdentityConfig, transport: typeof fetch = fetch) {
    super();
    this.enabled = options.enabled === true;
    this.authority = centralIdentityClient({ ...options, enabled: this.enabled }, transport);
  }
  static validateOptions(options: CentralIdentityConfig): void { centralIdentityClient({ ...options, enabled: options.enabled === true }); }

  async authenticate(data: AuthenticationInput, service: AuthIdentityProviderService): Promise<AuthenticationResponse> {
    if (!this.enabled) return { success: false, error: "Authentication disabled" };
    try {
      const headers = data.headers ?? {};
      const names = Object.keys(headers);
      if (names.some(key => ["origin", "cookie"].includes(key.toLowerCase())) || names.filter(key => key.toLowerCase() === "authorization").length !== 1) return { success: false, error: "Authentication failed" };
      const authorization = headers[names.find(key => key.toLowerCase() === "authorization")!];
      if (typeof authorization !== "string" || !/^Bearer [^\s]+$/.test(authorization) || authorization.length > 4103) return { success: false, error: "Authentication failed" };
      // Never accept caller email, roles, customer IDs, entity IDs or body token overrides.
      if (data.body && Object.keys(data.body).length) return { success: false, error: "Authentication failed" };
      const identity = await this.authority.verifyIdentity(authorization.slice(7));
      const entityId = centralEntityId(identity.issuer, identity.subject);
      let auth: AuthIdentityDTO;
      try { auth = await service.retrieve({ entity_id: entityId }); }
      catch (error) {
        if (!(error instanceof MedusaError) || error.type !== MedusaError.Types.NOT_FOUND) throw error;
        try {
          auth = await service.create({ entity_id: entityId, provider_metadata: { issuer: identity.issuer, subject: identity.subject } });
        } catch {
          // A raced native unique insert or lost create response is reconciled by exact identity read, never another create.
          auth = await service.retrieve({ entity_id: entityId });
        }
      }
      assertCentralAuthIdentity(auth, identity);
      const current = await this.authority.verifyIdentity(authorization.slice(7));
      if (current.subject !== identity.subject) return { success: false, error: "Authentication failed" };
      return { success: true, authIdentity: auth };
    } catch (error) {
      return { success: false, error: error instanceof CentralIdentityError && error.code === "unavailable" ? "Authentication unavailable" : "Authentication failed" };
    }
  }
}
