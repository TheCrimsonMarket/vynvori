import "server-only";
import { randomUUID } from "node:crypto";
import { authHttpHandlers, centralIdentityClient, credentialVault, loginTransactions, authSessionService, privateMedusaClient, commerceIdentityCoordinator, revocationReconciler } from "@vynvori/commerce/identity";
import { connectIdentityDatabase, identityStateStore, commerceMappingStore } from "@vynvori/db/identity";
import { identitySettings } from "./identity-settings";
import { privateMedusaSettings } from "./medusa-settings";

export function createIdentityRuntime(env: Readonly<Record<string, string | undefined>>) {
  const settings = identitySettings(env);
  if (!settings.enabled) return { enabled: false as const, http: authHttpHandlers({ enabled: false, appOrigin: "" }), reconcileRevocations: undefined, close: async () => {} };
  const vault = credentialVault(settings.currentKeyId, settings.keys);
  const authority = centralIdentityClient(settings);
  const medusa = privateMedusaSettings(env, settings);
  const connection = connectIdentityDatabase({ M2_ENV: "staging", M2_CREATIVE_DATABASE_URL: settings.databaseUrl, M2_CREATIVE_DATABASE_HOST: settings.databaseHost });
  const store = identityStateStore(connection.pool), transactions = loginTransactions(settings, store, vault);
  const privateClient = medusa ? privateMedusaClient(medusa.config, medusa.serviceIdentity) : undefined;
  const commerce = medusa && privateClient ? commerceIdentityCoordinator({ enabled: true, deployment: settings.deployment, issuer: settings.issuer, clientId: settings.clientId, audience: settings.audience, projectId: medusa.config.projectId },
    commerceMappingStore(connection.pool), privateClient, vault) : undefined;
  const sessions = authSessionService(settings, store, authority, transactions, vault, Date.now, commerce, privateClient);
  // Explicit trusted server call only. No HTTP route, startup batch or scheduler enrollment.
  const revocations = revocationReconciler(settings, store, authority, vault);
  return { enabled: true as const, http: authHttpHandlers(settings, sessions, transactions), reconcileRevocations: revocations.run, close: connection.close };
}
let current: ReturnType<typeof createIdentityRuntime> | undefined;
export function getIdentityRuntime() { return current ??= createIdentityRuntime(process.env); }
export type AuthHttpOperation = keyof ReturnType<typeof authHttpHandlers>;
export async function invokeAuthRoute(operation: AuthHttpOperation, request: Request): Promise<Response> {
  try { return await getIdentityRuntime().http[operation](request); }
  catch { return Response.json({ error: { code: "AUTH_UNAVAILABLE", message: "Account services are temporarily unavailable.", retryable: true, correlationId: randomUUID() } }, { status: 503, headers: { "cache-control": "no-store, max-age=0", "referrer-policy": "no-referrer", vary: "Cookie" } }); }
}
