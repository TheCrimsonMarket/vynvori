import Link from "next/link";
export function SiteFooter() {
  return <footer className="site-footer"><div><p className="eyebrow">VYNVORI / IMAGINATION, GIVEN FORM.</p><p>Original graphics. A canvas of your own.</p></div>
    <nav aria-label="Footer navigation"><Link href="/studio">AI Design Studio</Link><Link href="/customize">Bring Your Own Art</Link><Link href="/gallery">Community</Link></nav>
    <p className="footer-note">Private M0 preview. Illustrative reference art; commercial rights and product details await verification. No purchases, uploads or generation.</p>
  </footer>;
}
