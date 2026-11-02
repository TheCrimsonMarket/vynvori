import { invokeCompositionRoute } from "@/server/composition-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function GET(request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) { return invokeCompositionRoute("review", request, await params); }
