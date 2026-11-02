import { invokeCompositionRoute } from "@/server/composition-runtime";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) { return invokeCompositionRoute("get", request, await params); }
export async function PUT(request: Request, { params }: Context) { return invokeCompositionRoute("save", request, await params); }
