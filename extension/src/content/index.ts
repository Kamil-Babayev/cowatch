// Top-frame bootstrap: wires the overlay controller to the real `browser`
// APIs and the DOM. All behavior lives in overlay-controller.ts (lifecycle)
// and overlay-view.ts (DOM).
import { injectJitsi, jitsiRoomUrl } from './jitsi.ts';
import { OverlayController } from './overlay-controller.ts';
import { createOverlayView, type OverlayLayout } from './overlay-view.ts';
import overlayStyles from './overlay.css';
import type { ToContentMessage } from '../shared/runtime-messages.ts';
import { debugLog } from '../shared/config.ts';

debugLog('top-frame coordinator loaded', { pageUrl: window.location.href });

const layoutKey = `overlayLayout:${window.location.hostname}`;

// Macs render the overlay in the system font. Elsewhere it uses the bundled
// Inter, registered on the page from binary data so the page's font-src CSP
// cannot block it. Loaded once, the first time an overlay appears.
let fontRequested = false;
function loadFallbackFont(): void {
  if (fontRequested || /Mac/i.test(navigator.platform)) return;
  fontRequested = true;
  void fetch(browser.runtime.getURL('fonts/inter-latin-wght.woff2'))
    .then((response) => response.arrayBuffer())
    .then((data) => {
      const face = new FontFace('CoWatch Inter', data, { weight: '100 900' });
      document.fonts.add(face);
      return face.load();
    })
    .catch(() => undefined); // Segoe UI / system-ui remain as fallbacks.
}

const controller = new OverlayController({
  createView: (actions) => {
    loadFallbackFont();
    return createOverlayView(document, actions, {
      load: async () => ((await browser.storage.local.get(layoutKey))[layoutKey] as OverlayLayout | undefined) ?? null,
      save: (layout) => void browser.storage.local.set({ [layoutKey]: layout }),
    }, overlayStyles);
  },
  sendMessage: (message) => browser.runtime.sendMessage(message),
  injectJitsi: (roomId, slot, onEvent) => injectJitsi(roomId, slot, onEvent),
  openCallWindow: (roomId) => {
    void jitsiRoomUrl(roomId).then((url) => {
      window.open(url, 'cowatch-call', 'popup,width=480,height=360');
    });
  },
  writeClipboard: (text) => navigator.clipboard.writeText(text),
});

browser.runtime.onMessage.addListener((message: unknown) => {
  controller.handleMessage(message as ToContentMessage);
});

controller.start();
