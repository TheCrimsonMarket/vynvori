import { Unavailable } from "@/components/unavailable";
import { AuthPanel } from "@/components/auth-panel";
import { getServerConfig } from "@vynvori/shared/server";
export const metadata = { title: "Account" };
export const dynamic = "force-dynamic";
export default function Account() {
  if (!getServerConfig().features["identity.central_sso"]) return <Unavailable title="ACCOUNT, COMING LATER." description="Sign-in and account services are unavailable. No customer session, saved project or credit balance is connected." />;
  return <section className="atelier unavailable"><p className="eyebrow">VYNVORI / YOUR ACCOUNT</p><h1>YOUR ACCOUNT.</h1><AuthPanel /></section>;
}
