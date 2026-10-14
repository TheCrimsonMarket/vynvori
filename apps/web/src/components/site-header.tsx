"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
const links = [
  ["Shop", "/products/black-oversized-tshirt"], ["AI Design Studio", "/studio"],
  ["Customize", "/customize"], ["Community", "/gallery"], ["Account", "/account"],
] as const;
export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = pathname.startsWith("/studio") ? "studio" : "storefront";
    return () => { delete document.documentElement.dataset.theme; };
  }, [pathname]);
  return <header className="site-header">
    <div className="preview-strip">M0 / PRIVATE REVIEW <span>Purchasing & creation unavailable</span></div>
    <div className="navigation" onKeyDown={event => {
      if (event.key === "Escape" && open) { setOpen(false); toggle.current?.focus(); }
    }}>
      <Link href="/" className="brand" aria-label="VYNVORI home" onClick={() => setOpen(false)}>
        <Image src="/assets/vynvori-symbol-black.svg" width={32} height={32} alt="" className="brand-symbol" />
        <span>OBJECTS OF EXPRESSION</span>
      </Link>
      <Button variant="outline" className="menu-toggle" ref={toggle} aria-expanded={open} aria-controls="main-navigation" onClick={() => setOpen(!open)}>Menu</Button>
      <nav id="main-navigation" aria-label="Main navigation" className={open ? "main-navigation is-open" : "main-navigation"}>
        {links.map(([label, href]) => <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} onClick={() => setOpen(false)}>{label}</Link>)}
      </nav>
      <Link href="/cart" className="cart-link" aria-current={pathname === "/cart" ? "page" : undefined} onClick={() => setOpen(false)}>Cart<span className="sr-only"> — unavailable</span></Link>
    </div>
  </header>;
}
