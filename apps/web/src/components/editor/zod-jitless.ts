// Browser-only zod configuration for the editor bundle (M3 C1c).
//
// zod 4 probes `new Function("")` once, on first use, to decide whether it may generate parsing code. The site's
// Content-Security-Policy deliberately has no 'unsafe-eval', so the probe is blocked: caught by zod, but reported by
// the browser as a CSP violation (Firefox writes a console error for every page load of /customize).
// `jitless` makes zod skip the probe and use its interpreted parser. This is a library setting, not a CSP change.
//
// Import this module FIRST in every editor module that reaches @vynvori/contracts, so it is evaluated before the
// first schema is parsed. It does nothing on the server: server-side parsing keeps zod's default behaviour.
import { config } from "zod";

if (typeof window !== "undefined") config({ jitless: true });
