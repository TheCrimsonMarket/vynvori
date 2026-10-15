import "server-only";
import { required, scope, serviceOrigin, type InfraEnv } from "@vynvori/shared/infrastructure";
export function processingClient(env: InfraEnv, fetcher: typeof fetch = fetch) {
  const origin = serviceOrigin(required(env, "M2_PROCESSING_ORIGIN"), scope(env));
  const token = required(env, "M2_PROCESSING_TOKEN");
  if (token.length < 32) throw new Error("Strong processing token required");
  // Cloud Run validates the short-lived Google ID token independently of the app token.
  const iamToken = scope(env) === "staging" ? required(env, "M2_PROCESSING_ID_TOKEN") : undefined;
  return {
    async ready(): Promise<void> {
      const response = await fetcher(new URL("/ready", origin), { headers: { authorization: `Bearer ${token}`, ...(iamToken ? { "X-Serverless-Authorization": `Bearer ${iamToken}` } : {}) }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.status !== 200) throw new Error("Processing unavailable");
      await response.body?.cancel();
    },
  };
}
