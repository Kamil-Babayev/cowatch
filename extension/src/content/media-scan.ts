/**
 * DOM helpers for finding players, including inside shadow DOM — custom
 * player elements commonly keep their <video> in a shadow root, where a
 * plain document.querySelectorAll never looks.
 */

/**
 * Firefox content scripts can also see *closed* shadow roots through
 * `openOrClosedShadowRoot`; elsewhere (tests) only open ones are visible.
 */
export function shadowRootOf(element: Element): ShadowRoot | null {
  const firefox = element as Element & { openOrClosedShadowRoot?: ShadowRoot | null };
  return firefox.openOrClosedShadowRoot ?? element.shadowRoot ?? null;
}

export interface MediaScan {
  videos: HTMLVideoElement[];
  iframes: HTMLIFrameElement[];
  shadowRoots: ShadowRoot[];
}

export function scanMedia(root: Document | ShadowRoot): MediaScan {
  const scan: MediaScan = { videos: [], iframes: [], shadowRoots: [] };
  const visit = (node: Document | ShadowRoot) => {
    for (const element of node.querySelectorAll('*')) {
      const tag = element.localName;
      if (tag === 'video') scan.videos.push(element as HTMLVideoElement);
      else if (tag === 'iframe') scan.iframes.push(element as HTMLIFrameElement);
      const shadow = shadowRootOf(element);
      if (shadow) {
        scan.shadowRoots.push(shadow);
        visit(shadow);
      }
    }
  };
  visit(root);
  return scan;
}

/** Whether added/removed nodes could change the set of players. */
export function touchesMedia(node: Node): boolean {
  if (node.nodeType !== 1) return false;
  const element = node as Element;
  return element.localName === 'video'
    || element.localName === 'iframe'
    || shadowRootOf(element) !== null
    || element.querySelector('video, iframe') !== null;
}

/** On-screen area of an element in CSS px², 0 when hidden. */
export function elementVisibleArea(element: Element): number {
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (style?.display === 'none' || style?.visibility === 'hidden' || Number(style?.opacity) === 0) {
    return 0;
  }
  const rect = element.getBoundingClientRect();
  // innerWidth/innerHeight are the viewport in quirks mode too, where
  // documentElement.clientHeight is the whole document height instead.
  const viewportWidth = view?.innerWidth || element.ownerDocument.documentElement.clientWidth;
  const viewportHeight = view?.innerHeight || element.ownerDocument.documentElement.clientHeight;
  const width = Math.max(0, Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0));
  const height = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
  return width * height;
}
