import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { LinkButton } from "@/components/link-button";
import { Button } from "@/components/ui/button";
export const metadata: Metadata = { title: "Black oversized T-shirt study" };
export function generateStaticParams() { return [{ handle: "black-oversized-tshirt" }]; }
export default async function Product({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  if (handle !== "black-oversized-tshirt") notFound();
  return <section className="atelier"><p className="eyebrow">THE GARMENT / REFERENCE STUDY</p><div className="product-entry"><figure className="garment-study"><Image src="/assets/blank-garment.png" width={1536} height={1024} sizes="(max-width: 700px) 100vw, 55vw" alt="Approved illustrative reference of a black oversized T-shirt, front and back" priority /><figcaption>ILLUSTRATIVE GARMENT / SUPPLIER DETAILS UNVERIFIED</figcaption></figure>
    <div><h1>THE BLACK<br />CANVAS.</h1><p className="lede">Oversized styling direction.<br />A canvas for personal expression.</p><dl className="product-facts"><div><dt>Price</dt><dd>To be confirmed</dd></div><div><dt>Sizes & availability</dt><dd>Awaiting verified catalog</dd></div><div><dt>Delivery</dt><dd>Rates and regions unconfirmed</dd></div></dl><Button disabled aria-describedby="purchase-status">Purchasing unavailable</Button><p className="meta muted" id="purchase-status">No checkout is connected. No stock or delivery promise is made.</p><LinkButton href="/customize" outline>Explore Bring Your Own Art</LinkButton><details className="rule"><summary>Fit & construction</summary><p>Garment measurements, fabric composition and manufacturing specifications await supplier verification.</p></details><details className="rule"><summary>Production & delivery</summary><p>Future paid custom orders require validated print assets and human pre-print approval. Shipping and return terms remain unconfirmed.</p></details></div></div></section>;
}
