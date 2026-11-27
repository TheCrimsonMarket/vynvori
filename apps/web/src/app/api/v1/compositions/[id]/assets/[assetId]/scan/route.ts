import { invokeCompositionRoute } from "@/server/composition-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Explicit rescan request (ADR-0022 C5). No body is accepted; the verdict only ever comes from the server's scan port. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string; assetId: string }> }) { return invokeCompositionRoute("scanAsset", request, await params); }
