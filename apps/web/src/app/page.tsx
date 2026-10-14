import Image from "next/image";
import Link from "next/link";
import { LinkButton } from "@/components/link-button";
export default function Home() {
  return <>
    <div className="home-masthead"><Image src="/assets/vynvori-wordmark-black.svg" alt="VYNVORI" width={2287} height={320} priority className="wordmark" /></div>
    <section className="home-body" aria-labelledby="home-heading">
      <div className="home-rail"><div className="home-index"><p className="eyebrow">RUPTURE / 01</p><p className="meta">A STUDY IN EXPRESSION<br />OVERSIZED GRAPHIC T-SHIRTS</p><div className="short-rule" /><p className="meta">FRONT / BACK<br />ONE COMPOSITION</p></div>
        <div><p className="eyebrow">IMAGINATION, GIVEN FORM.</p><h1 id="home-heading">WEAR WHAT<br />YOU IMAGINE.</h1><p>Original graphics.<br />An oversized black canvas.</p></div>
      </div>
      <figure className="campaign"><Image src="/assets/campaign.png" width={1536} height={1024} sizes="(max-width: 700px) 100vw, (min-width: 1440px) 80vw, 70vw" priority alt="Rupture illustrative campaign: coordinated black oversized tees with an ivory ring and three arches" /><figcaption>ILLUSTRATIVE CAMPAIGN CONCEPT / RUPTURE 01</figcaption></figure>
    </section>
    <section className="home-tail" aria-labelledby="expression-heading"><div><p className="eyebrow">THE COLLECTION / YOUR EXPRESSION</p><h2 id="expression-heading">A considered garment.<br />A world of your own.</h2><Link href="/products/black-oversized-tshirt" className="text-link">Discover the garment study <span aria-hidden="true">↗</span></Link></div>
      <div className="journey-entry"><div className="entry-pair"><LinkButton href="/studio">AI Design Studio</LinkButton><LinkButton href="/customize" outline>Bring Your Own Art</LinkButton></div><p className="meta muted">Two independent beginnings. Explore the entries; creation opens in a later release.</p></div>
    </section>
  </>;
}
