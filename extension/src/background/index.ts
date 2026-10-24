import { SERVER_BASE_URL } from '../shared/config.ts';
import { createRoom, mintFreshLink, roomExists } from '../shared/api-client.ts';
import { RoomManager } from './room-manager.ts';
import { createMessageRouter } from './message-router.ts';
import type { ToBackgroundMessage } from '../shared/runtime-messages.ts';
import { VideoCoordinator } from './video-coordinator.ts';

console.log('[CoWatch] background script loaded, server:', SERVER_BASE_URL);

// This file is the only place that touches the real `browser.*` APIs; the
// modules it wires together only ever see the thin adapters below.
const roomManager = new RoomManager({ roomExists });

const videoCoordinator = new VideoCoordinator(
  {
    sendMessage: (tabId, message, options) => browser.tabs.sendMessage(tabId, message, options),
  },
  {
    getAllFrames: async (details) => (await browser.webNavigation.getAllFrames(details)) ?? null,
  },
);

const router = createMessageRouter({
  roomManager,
  tabs: {
    update: (tabId, props) => browser.tabs.update(tabId, props),
    get: (tabId) => browser.tabs.get(tabId),
  },
  storage: {
    set: (items) => browser.storage.session.set(items),
    get: (keys) => browser.storage.session.get(keys),
    getAll: () => browser.storage.session.get(null),
    remove: (keys) => browser.storage.session.remove(keys),
  },
  api: { createRoom, mintFreshLink },
  videos: videoCoordinator,
});

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  return router.handleMessage(message as ToBackgroundMessage, sender).catch((err) => {
    console.error('[CoWatch] background message failed:', err);
    throw err;
  });
});

// Candidate ids belong to a document; a navigated frame needs choosing again.
browser.webNavigation.onCommitted.addListener((details) => {
  router.handleNavigation(details.tabId, details.frameId);
});

// Prevents a leaked session (and its open WebSocket) once a tab closes.
browser.tabs.onRemoved.addListener((tabId) => {
  void router.handleMessage({ kind: 'leaveRoom', tabId }, {}).finally(() =>
    browser.storage.session.remove([`pendingRoomId:${tabId}`]),
  );
});

// Firefox may have unloaded this event page while rooms were active.
void router.restoreSessions().catch((err) => {
  console.error('[CoWatch] could not restore room sessions:', err);
});
