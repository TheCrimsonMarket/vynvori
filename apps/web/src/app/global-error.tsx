"use client";
import Link from "next/link";
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="en"><body><main role="alert"><h1>The application could not open.</h1><p>Try again. If the problem continues, contact the site operator.</p><button type="button" onClick={reset}>Try again</button><Link href="/">Return home</Link></main></body></html>;
}
