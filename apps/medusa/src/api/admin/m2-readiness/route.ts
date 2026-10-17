import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { dependencyReadiness } from "../../../dependency-readiness";
// Native /admin authentication applies before this dependency diagnostic.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  try {
    const config = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE).projectConfig;
    await dependencyReadiness({ connectionString: config.databaseUrl, ssl: config.databaseDriverOptions?.connection?.ssl }, controller.signal);
    return res.json({ version: 1, service: "medusa", status: "ready", code: "OK" });
  } catch {
    return res.status(503).json({ version: 1, service: "medusa", status: "unavailable", code: "DEPENDENCY_UNAVAILABLE" });
  } finally {
    req.removeListener("aborted", abort);
    res.removeListener("close", abort);
  }
}
