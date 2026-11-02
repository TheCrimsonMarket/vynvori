import { ModuleProvider, Modules } from "@medusajs/framework/utils";
import TcmAuthProvider from "./service";
// Exported for future reviewed enrollment; not registered by medusa-config.ts.
export default ModuleProvider(Modules.AUTH, { services: [TcmAuthProvider] });
