import type { Metadata } from "next";
import { Review } from "@/components/editor/review";
export const metadata: Metadata = { title: "Composition review" };
export default async function ReviewPage({ params, searchParams }: Readonly<{ params: Promise<{ compositionId: string }>; searchParams: Promise<{ versionId?: string | string[] }> }>) {
  const { compositionId } = await params, { versionId } = await searchParams;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  return <Review compositionId={uuid.test(compositionId) ? compositionId : ""} versionId={typeof versionId === "string" && uuid.test(versionId) ? versionId : ""} />;
}
