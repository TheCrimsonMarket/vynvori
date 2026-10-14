import type { Metadata } from "next";
import localFont from "next/font/local";
import { getServerConfig } from "@vynvori/shared/server";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import "./globals.css";
const archivo = localFont({ src: "../fonts/archivo.ttf", display: "swap", variable: "--font-archivo", weight: "100 900" });
export const metadata: Metadata = {
  title: { default: "VYNVORI — Imagination, given form", template: "%s / VYNVORI" },
  description: "The VYNVORI atelier. Explore original graphics and an oversized canvas for personal expression. Private foundation preview.",
  robots: { index: false, follow: false }, icons: { icon: "/assets/vynvori-symbol-black.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  getServerConfig();
  return <html lang="en" className={archivo.variable}><body><a className="skip-link" href="#main">Skip to content</a><SiteHeader /><main id="main" tabIndex={-1}>{children}</main><SiteFooter /></body></html>;
}
