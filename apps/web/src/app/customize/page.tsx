import type { Metadata } from "next";
import { Editor } from "@/components/editor/editor";
export const metadata: Metadata = { title: "Bring Your Own Art" };
/** ED-01. Guest-permitted, no auth and no AI wallet; back/resume never routes to AI results. */
export default function Customize() { return <Editor />; }
