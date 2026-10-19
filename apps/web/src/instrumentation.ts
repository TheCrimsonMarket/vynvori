/** Validate runtime configuration even when all presentation pages were prerendered. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerConfig } = await import("@vynvori/shared/server");
    const config = getServerConfig();
    if (config.features["identity.central_sso"]) {
      const { getIdentityRuntime } = await import("@/server/auth-runtime");
      getIdentityRuntime();
    }
  }
}
