import type { Metadata } from "next";
import Image from "next/image";
import { Button } from "@/components/ui/button";
export const metadata: Metadata = { title: "Community" };
export default function Gallery() {
  return <section className="atelier"><p className="eyebrow">COMMUNITY / A FUTURE SHARED SPACE</p><div className="gallery-entry"><div><h1>PERSONAL FIRST.<br />SHARED BY CHOICE.</h1><p className="lede">Your projects will begin privately. Sharing will be a separate, explicit choice.</p><p className="notice" id="gallery-availability">Community introduction. Publishing, moderation, likes and sharing are unavailable. No customer projects are displayed.</p><Button disabled aria-describedby="gallery-availability">Publishing unavailable</Button><div className="rule"><h2>Expression, with permission.</h2><p>The future showcase will display approved representations only. Public visibility will not grant download, remix or resale rights.</p></div></div><figure className="gallery-art"><Image src="/assets/arch-study.svg" width={720} height={960} alt="Illustrative house artwork of three ivory arches; not a customer project" /><figcaption>HOUSE STUDY / NOT A COMMUNITY SUBMISSION</figcaption></figure></div></section>;
}
