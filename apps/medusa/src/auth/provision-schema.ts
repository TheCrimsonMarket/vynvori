import { z } from "@medusajs/framework/zod";
export const ProvisionSchema = z.object({
  mode: z.enum(["create", "reconcile"]),
  operationId: z.string().uuid(),
  originalEmail: z.string().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
}).strict();
const actorFields = { authIdentityId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), customerId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) };
export const ExchangeSchema = z.object(actorFields).strict();
export const OwnedSchema = z.discriminatedUnion("action", [
  z.object({ ...actorFields, action: z.literal("read_customer") }).strict(),
  z.object({ ...actorFields, action: z.literal("read_orders") }).strict(),
  z.object({ ...actorFields, action: z.literal("read_cart"), resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) }).strict(),
]);
