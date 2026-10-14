import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
export function LinkButton({ href, children, outline = false }: { href: string; children: ReactNode; outline?: boolean }) {
  return <Link href={href} className={buttonVariants({ variant: outline ? "outline" : "default" })}>{children}<span aria-hidden="true">↗</span></Link>;
}
