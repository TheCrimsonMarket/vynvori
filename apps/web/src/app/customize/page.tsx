import type { Metadata } from "next";
import Image from "next/image";
import { LinkButton } from "@/components/link-button";
import { Button } from "@/components/ui/button";
export const metadata: Metadata = { title: "Bring Your Own Art" };
export default function Customize() {
  return <section className="atelier"><p className="eyebrow">THE INDEPENDENT EDITOR / YOUR ORIGINAL ART</p><div className="editor-entry"><div><h1>YOUR ART.<br />YOUR CANVAS.</h1><p className="lede">A space for the artwork you bring. Independent of AI Design Studio. No AI credits required.</p><p className="notice" id="editor-availability">Editor introduction. Artwork upload, composition editing and saving arrive in M3. No file is collected in this preview.</p><Button disabled aria-describedby="editor-availability">Upload artwork — coming later</Button><div className="rule"><h2>Bring a point of view.</h2><p>The future editor will let you arrange your own artwork and text on a garment. Preview and manufacturing approval remain separate.</p><LinkButton href="/products/black-oversized-tshirt" outline>Explore the garment study</LinkButton></div></div>
    <figure className="garment-study"><Image src="/assets/blank-garment.png" width={1536} height={1024} sizes="(max-width: 700px) 100vw, 50vw" alt="Illustrative black oversized garment reference, front and back views" priority /><figcaption>BLANK GARMENT STUDY / NOT A PRINT TEMPLATE</figcaption></figure></div></section>;
}
