import { invokeCompositionRoute } from "@/server/composition-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Redeem a download grant: the unchanged original as an attachment, only to the principal that minted it (ADR-0022 D4, C6). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; assetId: string }> }) { return invokeCompositionRoute("downloadAsset", request, await params); }
