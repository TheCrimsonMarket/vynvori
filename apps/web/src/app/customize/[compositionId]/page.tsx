import type { Metadata } from "next";
import { Editor } from "@/components/editor/editor";
export const metadata: Metadata = { title: "Composition" };
/** ED-02. Ownership is enforced by the API (verified session or the scoped guest capability); this shell holds no data. */
export default async function Composition({ params }: Readonly<{ params: Promise<{ compositionId: string }> }>) {
  const { compositionId } = await params;
  return /^[0-9a-f-]{36}$/.test(compositionId) ? <Editor compositionId={compositionId} /> : <Editor />;
}
