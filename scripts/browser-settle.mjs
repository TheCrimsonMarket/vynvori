// Synchronisation helpers for scripts/browser-web.mjs (M3 C1c). They make the page do what it would do for a user;
// they never filter, skip or relax an assertion.

/** Scrolls every <img> into view until it has finished loading, then returns to the top, so lazy images load on every
 *  engine. Chromium and Firefox load lazy images from far below the fold; WebKit's threshold is smaller (C1c triage).
 *  The wait per image is bounded and never throws: an image that does not load is left for the caller's own assertion. */
export async function loadLazyImages(page, { perImageTimeoutMs = 5000 } = {}) {
  await page.evaluate(async timeoutMs => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    for (const image of document.images) {
      image.scrollIntoView({ block: "center", inline: "nearest" });
      const deadline = performance.now() + timeoutMs;
      while (!(image.complete && image.naturalWidth > 0) && performance.now() < deadline) await frame();
    }
    window.scrollTo(0, 0);
  }, perImageTimeoutMs);
}
