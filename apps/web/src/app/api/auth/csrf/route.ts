import { invokeAuthRoute } from "@/server/auth-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET(request: Request) { return invokeAuthRoute("csrf", request); }
