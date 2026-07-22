/**
 * Pure re-parenting decision, separated from the real `fullscreenchange`
 * listener — jsdom has no Fullscreen API at all (no `requestFullscreen`,
 * no `fullscreenElement` getter; confirmed while building this story), so
 * `reparentForFullscreen` takes "what's currently fullscreen" as a plain
 * function argument instead of reading `document.fullscreenElement`
 * directly. That's what makes it testable at all in this sandbox.
 */
export function reparentForFullscreen(
  host: Element,
  getFullscreenElement: () => Element | null,
  fallbackParent: Element,
): void {
  const target = getFullscreenElement() ?? fallbackParent;
  if (host.parentElement !== target) {
    target.appendChild(host);
  }
}

/**
 * Real wiring — attaches a `fullscreenchange` listener that re-parents
 * `host` into the browser's actual fullscreen element (or back to
 * `fallbackParent` on exit). Untestable here for the same reason as
 * above; only `reparentForFullscreen`'s decision logic is covered.
 */
export function setupFullscreenReparenting(
  host: Element,
  fallbackParent: Element = document.body,
): () => void {
  const handler = () => reparentForFullscreen(host, () => document.fullscreenElement, fallbackParent);
  document.addEventListener('fullscreenchange', handler);
  return () => document.removeEventListener('fullscreenchange', handler);
}
