import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
// Native /admin authentication applies before this dependency diagnostic.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
    await query.graph({ entity: "product", fields: ["id"], pagination: { take: 1 } });
    return res.json({ version: 1, service: "medusa", status: "ready", code: "OK" });
  } catch {
    return res.status(503).json({ version: 1, service: "medusa", status: "unavailable", code: "DEPENDENCY_UNAVAILABLE" });
  }
}
