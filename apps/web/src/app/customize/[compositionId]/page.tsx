import type { Metadata } from "next";
import { Editor } from "@/components/editor/editor";
import { editorCapabilities } from "@/server/composition-runtime";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Composition" };
/** ED-02. Ownership is enforced by the API (verified session or the scoped guest capability); this shell holds no data. */
export default async function Composition({ params }: Readonly<{ params: Promise<{ compositionId: string }> }>) {
  const { compositionId } = await params, { artworkUpload, uploadLimits } = editorCapabilities(process.env);
  return /^[0-9a-f-]{36}$/.test(compositionId) ? <Editor compositionId={compositionId} artworkUpload={artworkUpload} uploadLimits={uploadLimits} /> : <Editor artworkUpload={artworkUpload} uploadLimits={uploadLimits} />;
}
