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

const controller = new OverlayController({
  createView: (actions) => createOverlayView(document, actions, {
    load: async () => ((await browser.storage.local.get(layoutKey))[layoutKey] as OverlayLayout | undefined) ?? null,
    save: (layout) => void browser.storage.local.set({ [layoutKey]: layout }),
  }, overlayStyles),
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
