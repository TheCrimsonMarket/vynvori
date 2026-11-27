import { invokeCompositionRoute } from "@/server/composition-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Mint a short-lived, principal-bound, single-use download grant for a clean original (ADR-0022 D4, C6). No body is accepted. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; assetId: string }> }) { return invokeCompositionRoute("mintDownloadGrant", request, await params); }
