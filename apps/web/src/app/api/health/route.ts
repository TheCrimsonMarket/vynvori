export const dynamic = "force-dynamic";
export const revalidate = 0;
/** Process liveness only. No downstream integrations are probed or implied. */
export function GET() {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store, max-age=0" } });
}
