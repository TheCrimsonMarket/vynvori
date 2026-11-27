import { defineConfig, loadEnv } from "@medusajs/framework/utils";
import { medusaEnvironment } from "./src/config";
import { bridgeSettings } from "./src/auth/bridge-settings";
loadEnv(process.env.NODE_ENV || "development", process.cwd());
const bridge = bridgeSettings(process.env);
const projectConfig = medusaEnvironment(process.env);
if (bridge.enabled) projectConfig.http.authMethodsPerActor.customer = ["tcm"];
// biome-ignore lint/style/noCommonJs: Medusa loads medusa-config through module.exports, as its docs show
module.exports = defineConfig({
  projectConfig,
  ...(bridge.enabled ? { modules: [
    { resolve: "@medusajs/locking", options: { providers: [{ resolve: "@medusajs/locking-postgres", id: "postgres", is_default: true }] } },
    { resolve: "@medusajs/auth", options: { providers: [
      { resolve: "@medusajs/auth-emailpass", id: "emailpass" },
      { resolve: "./src/modules/tcm-auth", id: "tcm", options: { enabled: true, issuer: bridge.issuer, apiBase: bridge.apiBase, audience: bridge.audience, clientId: bridge.clientId, clientSecret: bridge.clientSecret } },
    ] } },
  ] } : {}),
  // Medusa 2.23 loads the Medusa Cloud plugin by default (admin announcement routes that call api.prod.medusajs.cloud,
  // a cloud table and RBAC policy script). VYNVORI is self-hosted with no cloud egress, so it stays out (ADR-0024).
  plugins: [{ resolve: "@medusajs/cloud", options: { disabled: true } }],
  // M2 has no operator UI/custom auth. Admin API retains native user auth.
  admin: { disable: true },
});
