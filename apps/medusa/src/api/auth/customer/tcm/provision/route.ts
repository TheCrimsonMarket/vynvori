import { randomUUID } from "node:crypto";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { PrivateBridgeError, type privateMedusaBridge, type ProvisionBody } from "../../../../../auth/private-bridge";
import { CentralIdentityError } from "../../../../../auth/central-identity";
export async function POST(req: MedusaRequest<ProvisionBody>, res: MedusaResponse) {
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
  try {
    if (!req.is("application/json")) { res.status(415).json({ error: { code: "BRIDGE_INVALID_REQUEST" } }); return; }
    const bridge = req.scope.resolve<ReturnType<typeof privateMedusaBridge>>("vynvoriTcmBridge");
    const result = await bridge.provision({ authorization: req.get("authorization"), origin: req.get("origin"), cookie: req.get("cookie"), proof: req.get("x-vynvori-bridge") }, req.validatedBody);
    res.status(result.state === "ready" ? 200 : 202).json(result);
  } catch (error) {
    const central = error instanceof CentralIdentityError;
    const status = error instanceof PrivateBridgeError ? error.status : central && error.code === "reauth_required" ? 401 : central && error.code === "insufficient_scope" ? 403 : central && error.code === "contact_required" ? 409 : 503;
    const code = error instanceof PrivateBridgeError ? error.code : central && error.code === "contact_required" ? "BRIDGE_CONTACT_REQUIRED" : "BRIDGE_UNAVAILABLE";
    res.status(status).json({ error: { code, message: "Commerce identity request could not be completed.", correlationId: randomUUID() } });
  }
}
