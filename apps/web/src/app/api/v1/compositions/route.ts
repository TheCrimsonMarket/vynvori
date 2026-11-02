import { invokeCompositionRoute } from "@/server/composition-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function POST(request: Request) { return invokeCompositionRoute("create", request); }
export async function GET(request: Request) { return invokeCompositionRoute("list", request); }
