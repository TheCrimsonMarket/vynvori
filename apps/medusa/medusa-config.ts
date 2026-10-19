import { defineConfig, loadEnv } from "@medusajs/framework/utils";
import { medusaEnvironment } from "./src/config";
import { bridgeSettings } from "./src/auth/bridge-settings";
loadEnv(process.env.NODE_ENV || "development", process.cwd());
const bridge = bridgeSettings(process.env);
const projectConfig = medusaEnvironment(process.env);
if (bridge.enabled) projectConfig.http.authMethodsPerActor.customer = ["tcm"];
module.exports = defineConfig({
  projectConfig,
  ...(bridge.enabled ? { modules: [
    { resolve: "@medusajs/locking", options: { providers: [{ resolve: "@medusajs/locking-postgres", id: "postgres", is_default: true }] } },
    { resolve: "@medusajs/auth", options: { providers: [
      { resolve: "@medusajs/auth-emailpass", id: "emailpass" },
      { resolve: "./src/modules/tcm-auth", id: "tcm", options: { enabled: true, issuer: bridge.issuer, apiBase: bridge.apiBase, audience: bridge.audience, clientId: bridge.clientId, clientSecret: bridge.clientSecret } },
    ] } },
  ] } : {}),
  // M2 has no operator UI/custom auth. Admin API retains native user auth.
  admin: { disable: true },
});
