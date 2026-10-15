import "server-only";
import { required, scope, serviceOrigin, type InfraEnv } from "@vynvori/shared/infrastructure";
// No arbitrary paths, methods, Admin credentials or customer tokens in M2.
export function medusaClient(env: InfraEnv, fetcher: typeof fetch = fetch) {
  const origin = serviceOrigin(required(env, "M2_MEDUSA_ORIGIN"), scope(env));
  return {
    async ready(): Promise<void> {
      const response = await fetcher(new URL("/health", origin), { method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
      if (response.status !== 200) throw new Error("Medusa unavailable");
      // Built-in health confirms process reachability only. DB migration/startup tested separately.
      await response.body?.cancel();
    },
  };
}
