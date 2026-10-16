import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
// Native /admin authentication applies before this dependency diagnostic.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const connection = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    // Native Knex query timeout cancels work instead of abandoning a Promise.race.
    await connection.raw("SELECT 1").timeout(3000, { cancel: true });
    return res.json({ version: 1, service: "medusa", status: "ready", code: "OK" });
  } catch {
    return res.status(503).json({ version: 1, service: "medusa", status: "unavailable", code: "DEPENDENCY_UNAVAILABLE" });
  }
}
