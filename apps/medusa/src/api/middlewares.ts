import { defineMiddlewares, validateAndTransformBody, type MedusaRequest, type MedusaResponse, type MedusaNextFunction } from "@medusajs/framework/http";
import { ProvisionSchema, ExchangeSchema, OwnedSchema } from "../auth/provision-schema";
export function foundationBoundary(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  // CORS is not authorization. Explicitly block provisioning and ALL Store writes.
  // Express global mounts can trim req.path; retain the original path and match case-insensitively.
  let path: string;
  try { path = decodeURIComponent(req.originalUrl.split("?")[0] ?? "").toLowerCase(); }
  catch { res.status(400).json({ code: "INVALID_PATH" }); return; }
  const enrolled = req.scope?.hasRegistration("vynvoriTcmBridge") === true;
  const privateProvision = req.method === "POST" && ["/auth/customer/tcm/provision", "/auth/customer/tcm/exchange", "/auth/customer/tcm/owned"].includes(req.originalUrl) && enrolled;
  if ((path.startsWith("/auth/customer") && !privateProvision) ||
      (["/store/customers", "/store/orders", "/store/carts"].some(prefix => path.startsWith(prefix))) ||
      (path.startsWith("/store") && !["GET", "HEAD", "OPTIONS"].includes(req.method))) {
    res.status(403).json({ code: "M2_OPERATION_DISABLED" });
    return;
  }
  next();
}
export default defineMiddlewares({ routes: [{ matcher: "/*", middlewares: [foundationBoundary] },
  { matcher: "/auth/customer/tcm/provision", method: "POST", bodyParser: { sizeLimit: "2kb" }, middlewares: [validateAndTransformBody(ProvisionSchema)] },
  { matcher: "/auth/customer/tcm/exchange", method: "POST", bodyParser: { sizeLimit: "2kb" }, middlewares: [validateAndTransformBody(ExchangeSchema)] },
  { matcher: "/auth/customer/tcm/owned", method: "POST", bodyParser: { sizeLimit: "2kb" }, middlewares: [validateAndTransformBody(OwnedSchema)] }] });
