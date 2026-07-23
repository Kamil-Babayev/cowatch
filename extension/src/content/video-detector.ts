/**
 * Generic <video> element detection, usable on any site.
 *
 * Two responsibilities kept deliberately separate:
 *  - `pickLargestVisible` — pure, no DOM observation, easy to unit test.
 *  - `VideoDetector` — the stateful wrapper (MutationObserver, manual
 *    override) that content/index.ts actually uses.
 *
 * The manual-override path exists now, not just the auto-pick, because
 * Epic 3's US-3.4 "select the video" UI is specified to call into this
 * exact logic rather than invent its own — see cowatch-implementation-sequence.md.
 */

export function listCandidates(root: ParentNode = document): HTMLVideoElement[] {
  return Array.from(root.querySelectorAll('video'));
}

function visibleArea(el: HTMLVideoElement): number {
  const rect = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView;
  const style = view?.getComputedStyle(el);
  if (
    style?.display === 'none' ||
    style?.visibility === 'hidden' ||
    Number(style?.opacity) === 0
  ) {
    return 0;
  }
  const viewportWidth =
    el.ownerDocument.documentElement.clientWidth || view?.innerWidth || Number.MAX_SAFE_INTEGER;
  const viewportHeight =
    el.ownerDocument.documentElement.clientHeight || view?.innerHeight || Number.MAX_SAFE_INTEGER;
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return width * height;
}

/**
 * Picks the largest visible candidate. "Visible" means non-zero rendered
 * area — this deliberately doesn't check CSS `display`/`visibility`
 * directly, since a non-zero bounding rect already implies both.
 *
 * Falls back to the first candidate if none have a non-zero area (e.g. a
 * page that hasn't finished laying out yet) rather than returning null —
 * the caller can always re-run this once layout settles via the
 * MutationObserver-driven re-detection in VideoDetector.
 */
export function pickLargestVisible(candidates: HTMLVideoElement[]): HTMLVideoElement | null {
  if (candidates.length === 0) return null;

  let best = candidates[0];
  let bestArea = visibleArea(best);

  for (const el of candidates.slice(1)) {
    const area = visibleArea(el);
    if (area > bestArea) {
      best = el;
      bestArea = area;
    }
  }

  return best;
}

export type VideoDetectorChangeHandler = (video: HTMLVideoElement | null) => void;

export class VideoDetector {
  // No TS constructor parameter-property shorthand anywhere in this
  // codebase: Node's `--experimental-strip-types` (used to run tests
  // directly, see package.json's "test" script) only *erases* type
  // annotations — it can't transform syntax, and parameter properties are
  // sugar that expands into real assignment statements, not just a type
  // annotation. Every field is declared and assigned explicitly instead,
  // project-wide.
  private root: ParentNode;
  private observer: MutationObserver;
  private current: HTMLVideoElement | null = null;
  private manualOverride: HTMLVideoElement | null = null;
  private changeHandlers: VideoDetectorChangeHandler[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private view: Window | null;
  private readonly layoutHandler = () => this.reevaluate();

  constructor(root: ParentNode = document) {
    this.root = root;
    const ownerDocument =
      root === document ? document : (root as Node).ownerDocument;
    this.view = ownerDocument?.defaultView ?? null;
    this.observer = new MutationObserver(() => this.reevaluate());
    // childList + subtree: catches lazy-loaded players inserted anywhere
    // under root, which is the common case this story exists to handle.
    this.observer.observe(this.root === document ? document.body : (this.root as Node), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden'],
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.reevaluate());
      this.observeCandidateSizes();
    }
    this.view?.addEventListener('resize', this.layoutHandler);
    this.view?.addEventListener('scroll', this.layoutHandler, true);
    this.reevaluate();
  }

  private reevaluate(): void {
    this.observeCandidateSizes();
    if (this.manualOverride && this.manualOverride.isConnected) {
      this.setCurrent(this.manualOverride);
      return;
    }
    if (this.manualOverride && !this.manualOverride.isConnected) {
      // The manually-selected element was removed from the DOM (e.g. an ad
      // player that got torn down) — fall back to auto-pick rather than
      // holding a dangling reference.
      this.manualOverride = null;
    }
    this.setCurrent(pickLargestVisible(this.listCandidates()));
  }

  private observeCandidateSizes(): void {
    if (!this.resizeObserver) return;
    this.resizeObserver.disconnect();
    for (const video of this.listCandidates()) this.resizeObserver.observe(video);
  }

  private setCurrent(video: HTMLVideoElement | null): void {
    if (video === this.current) return;
    this.current = video;
    for (const handler of this.changeHandlers) handler(video);
  }

  listCandidates(): HTMLVideoElement[] {
    return listCandidates(this.root);
  }

  getCurrent(): HTMLVideoElement | null {
    return this.current;
  }

  /** Called by Epic 3's "select the video" overlay when auto-detection guesses wrong. */
  selectOverride(video: HTMLVideoElement): void {
    this.manualOverride = video;
    this.setCurrent(video);
  }

  clearOverride(): void {
    this.manualOverride = null;
    this.reevaluate();
  }

  onChange(handler: VideoDetectorChangeHandler): () => void {
    this.changeHandlers.push(handler);
    return () => {
      this.changeHandlers = this.changeHandlers.filter((h) => h !== handler);
    };
  }

  destroy(): void {
    this.observer.disconnect();
    this.resizeObserver?.disconnect();
    this.view?.removeEventListener('resize', this.layoutHandler);
    this.view?.removeEventListener('scroll', this.layoutHandler, true);
    this.changeHandlers = [];
  }
}
