/**
 * Query parameters that never change which video a page shows: tracking
 * tags, share attribution, and start-time hints. Dropping them lets two
 * browsers agree they are on "the same page" even when one arrived through
 * a shared link and the other did not.
 */
const IGNORED_PARAMS = new Set([
  'fbclid',
  'gclid',
  'si',
  'feature',
  'pp',
  'ref',
  't',
  'start',
  'time_continue',
]);

/**
 * A stable identifier for the video a page shows: origin + path + the
 * meaningful query parameters (sorted), without the fragment. Native
 * players are keyed by this instead of `video.currentSrc`, because
 * streaming players expose per-browser `blob:` URLs.
 */
export function pageKey(href: string): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !IGNORED_PARAMS.has(name) && !name.startsWith('utm_'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const query = new URLSearchParams(params).toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

export function samePage(a: string, b: string): boolean {
  return pageKey(a) === pageKey(b);
}
