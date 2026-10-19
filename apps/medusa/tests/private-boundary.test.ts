import test from "node:test";
import assert from "node:assert/strict";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { foundationBoundary } from "../src/api/middlewares";
test("stock private customer resources stay closed both before enrollment and during rollback", () => {
  for (const enrolled of [false, true]) for (const path of ["/store/customers/me", "/store/orders/order_synthetic", "/store/carts/cart_synthetic", "/STORE/CUSTOMERS/me"]) {
    let next = false, status = 0;
    foundationBoundary({ originalUrl: path, method: "GET", scope: { hasRegistration: () => enrolled } } as unknown as MedusaRequest,
      { status(code: number) { status = code; return this; }, json() {} } as unknown as MedusaResponse, () => { next = true; });
    assert.equal(status, 403); assert.equal(next, false);
  }
  let catalogAllowed = false;
  foundationBoundary({ originalUrl: "/store/products", method: "GET" } as MedusaRequest, {} as MedusaResponse, () => { catalogAllowed = true; });
  assert.equal(catalogAllowed, true);
});
