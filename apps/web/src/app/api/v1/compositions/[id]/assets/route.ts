import { invokeCompositionRoute } from "@/server/composition-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) { return invokeCompositionRoute("uploadAsset", request, await params); }
