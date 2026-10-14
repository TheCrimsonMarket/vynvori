import type { Metadata } from "next";
import Image from "next/image";
import { LinkButton } from "@/components/link-button";
import { Button } from "@/components/ui/button";
export const metadata: Metadata = { title: "AI Design Studio" };
export default function Studio() {
  return <section className="atelier studio-surface"><div className="studio-entry"><div><p className="eyebrow">THE CREATIVE ATELIER / IDEA TO WEAR</p><h1>A COLLECTION<br />OF ONE.</h1><p className="lede">Start with a point of view. Shape an original world. Give it form on a garment, or keep it as art.</p>
    <div className="path-options"><article className="path-card"><p className="eyebrow">01 / GUIDED</p><h2>Guide Me</h2><p>A visual brief, one considered choice at a time.</p><Button variant="outline" disabled aria-describedby="studio-availability">Guide Me — coming later</Button></article><article className="path-card"><p className="eyebrow">02 / FREEFORM</p><h2>Create Freely</h2><p>Your words. Your references. An open beginning.</p><Button variant="outline" disabled aria-describedby="studio-availability">Create Freely — coming later</Button></article></div>
    <p id="studio-availability" className="notice">Studio entry preview. Brief drafting, sign-in, promotional eligibility and generation are unavailable. No AI credits are used.</p><LinkButton href="/customize" outline>Bring Your Own Art</LinkButton>
    </div><figure className="entry-art"><Image src="/assets/studio-sentinel-study.svg" width={900} height={1200} alt="Illustrative Midnight Sentinel: an ivory geometric helmet, crown and wings against black, with the words After Dark" priority /><figcaption>HOUSE STUDY / ILLUSTRATIVE ARTWORK</figcaption></figure></div></section>;
}
