import { defineConfig, loadEnv } from "@medusajs/framework/utils";
import { medusaEnvironment } from "./src/config";
loadEnv(process.env.NODE_ENV || "development", process.cwd());
module.exports = defineConfig({
  projectConfig: medusaEnvironment(process.env),
  // M2 has no operator UI/custom auth. Admin API retains native user auth.
  admin: { disable: true },
});
