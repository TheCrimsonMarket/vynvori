import type { LoaderOptions } from "@medusajs/framework/types";
import { asValue } from "@medusajs/framework/awilix";
import { bridgeSettings } from "../auth/bridge-settings";
import { privateMedusaBridge } from "../auth/private-bridge";
export default async function loadPrivateBridge({ container }: LoaderOptions) {
  const settings = bridgeSettings(process.env);
  if (!settings.enabled) return;
  container.register({ vynvoriTcmBridge: asValue(privateMedusaBridge(settings, container)) });
}
