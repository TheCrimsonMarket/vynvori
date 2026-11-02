import type { Metadata } from "next";
import { Editor } from "@/components/editor/editor";
import { editorCapabilities } from "@/server/composition-runtime";
export const metadata: Metadata = { title: "Bring Your Own Art" };
export const dynamic = "force-dynamic"; // capability flags are read per request, never baked in at build
/** ED-01. Guest-permitted, no auth and no AI wallet; back/resume never routes to AI results. */
export default function Customize() { return <Editor artworkUpload={editorCapabilities(process.env).artworkUpload} />; }
