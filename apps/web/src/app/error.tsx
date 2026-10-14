"use client";
import { Button } from "@/components/ui/button";
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <section className="atelier" role="alert"><h1>THE PAGE COULD NOT OPEN.</h1><p>Try loading this page again.</p><Button onClick={reset}>Try again</Button></section>;
}
