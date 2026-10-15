import { defineMiddlewares, type MedusaRequest, type MedusaResponse, type MedusaNextFunction } from "@medusajs/framework/http";
export function foundationBoundary(req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) {
  // CORS is not authorization. Explicitly block provisioning and ALL Store writes.
  // Express global mounts can trim req.path; retain the original path and match case-insensitively.
  let path: string;
  try { path = decodeURIComponent(req.originalUrl.split("?")[0] ?? "").toLowerCase(); }
  catch { res.status(400).json({ code: "INVALID_PATH" }); return; }
  if (path.startsWith("/auth/customer") ||
      (path.startsWith("/store") && !["GET", "HEAD", "OPTIONS"].includes(req.method))) {
    res.status(403).json({ code: "M2_OPERATION_DISABLED" });
    return;
  }
  next();
}
export default defineMiddlewares({ routes: [{ matcher: "/*", middlewares: [foundationBoundary] }] });
