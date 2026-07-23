/**
 * Content script matching ONLY the landing-page domain (see manifest's
 * separate content_scripts entry for this) — deliberately not the
 * generic <all_urls> script, so landing-page-specific logic never runs
 * on every site a person visits.
 *
 * Talks to the landing page's own vanilla JS (app.js, served by the Go
 * server from server/static/join/) via CustomEvents on `window` — that's
 * the only channel available between a content script's isolated world
 * and the page's own scripts.
 */
import type { ToBackgroundMessage } from '../shared/runtime-messages.ts';

console.log('[CoWatch] landing-bridge content script loaded');

// US-2.10: proves the extension is installed just by existing — the page
// listens for this and falls back to an install prompt if it never hears it.
function announceExtension(): void {
  window.dispatchEvent(new CustomEvent('cowatch:extension-detected'));
}

window.addEventListener('cowatch:extension-check', announceExtension);
announceExtension();

// US-2.11: the page dispatches this when the user clicks "continue" on a
// resolved join link.
window.addEventListener('cowatch:join-requested', (event) => {
  const detail = (event as CustomEvent<{ roomId: string; videoUrl: string }>).detail;
  const msg: ToBackgroundMessage = {
    kind: 'joinRequested',
    roomId: detail.roomId,
    videoUrl: detail.videoUrl,
  };
  browser.runtime.sendMessage(msg);
});
