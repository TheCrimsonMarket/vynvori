// Engine selection for scripts/browser-web.mjs. Pure and dependency-free so it can be unit-tested.
// M0_BROWSER accepts exactly: chrome (default when unset), chromium, firefox, webkit.
// Any other value, including an empty string, is rejected. It is never mapped to a default.
export const ENGINES = Object.freeze({
  chrome: Object.freeze({ name: "chrome", type: "chromium", launch: Object.freeze({ headless: true, channel: "chrome" }) }),
  chromium: Object.freeze({ name: "chromium", type: "chromium", launch: Object.freeze({ headless: true }) }),
  firefox: Object.freeze({ name: "firefox", type: "firefox", launch: Object.freeze({ headless: true }) }),
  webkit: Object.freeze({ name: "webkit", type: "webkit", launch: Object.freeze({ headless: true }) }),
});

export function resolveEngine(value) {
  if (value === undefined) return ENGINES.chrome;
  if (typeof value === "string" && Object.hasOwn(ENGINES, value)) return ENGINES[value];
  throw new Error(`Unsupported M0_BROWSER ${JSON.stringify(value)}. Use one of: ${Object.keys(ENGINES).join(", ")} (unset means chrome).`);
}

/** Launches the engine through an already-loaded Playwright module. The type is always a known key, so no fallthrough exists. */
export function launchEngine(playwright, engine) {
  const launcher = playwright[engine.type];
  if (!launcher || typeof launcher.launch !== "function") throw new Error(`Playwright does not provide the ${engine.type} launcher.`);
  return launcher.launch({ ...engine.launch });
}
