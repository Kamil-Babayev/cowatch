import { SERVER_BASE_URL } from '../shared/config.ts';
import { mintFreshLink } from '../shared/api-client.ts';
import { RoomManager } from './room-manager.ts';
import { createMessageRouter, type TabsAPI, type SessionStorageAPI, type LinkMinter } from './message-router.ts';
import type { ToBackgroundMessage } from '../shared/runtime-messages.ts';
import { VideoCoordinator } from './video-coordinator.ts';

console.log('[CoWatch] background script loaded, server:', SERVER_BASE_URL);

const roomManager = new RoomManager();

// Thin adapters over the real `browser.*` APIs — this file is the only
// place that touches them directly; message-router.ts (and its tests)
// only ever see the TabsAPI/SessionStorageAPI shape.
const tabsAdapter: TabsAPI = {
  sendMessage: (tabId, message, options) =>
    browser.tabs.sendMessage(tabId, message, options),
  update: (tabId, props) => browser.tabs.update(tabId, props),
};

const sessionStorageAdapter: SessionStorageAPI = {
  set: (items) => browser.storage.session.set(items),
  get: (keys) => browser.storage.session.get(keys),
  remove: (keys) => browser.storage.session.remove(keys),
};

const linkMinterAdapter: LinkMinter = { mintFreshLink };
const videoCoordinator = new VideoCoordinator(
  {
    sendMessage: (tabId, message, options) =>
      browser.tabs.sendMessage(tabId, message, options),
  },
  {
    getAllFrames: (details) =>
      browser.webNavigation.getAllFrames(details) as Promise<
        Array<{
          frameId: number;
          parentFrameId: number;
          documentId?: string;
        }> | null
      >,
  },
);

const handleMessage = createMessageRouter(
  roomManager,
  tabsAdapter,
  sessionStorageAdapter,
  linkMinterAdapter,
  videoCoordinator,
);

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  return handleMessage(message as ToBackgroundMessage, sender).catch((err) => {
    console.error('[CoWatch] background message failed:', err);
    throw err;
  });
});

// Prevents a leaked RoomManager session (and its open WebSocket) once a
// tab closes — not called out as its own story anywhere, but the
// alternative is a slow, silent resource leak in normal use.
browser.tabs.onRemoved.addListener((tabId) => {
  void handleMessage({ kind: 'leaveRoom', tabId }, {}).finally(() =>
    browser.storage.session.remove([`pendingRoomId:${tabId}`]),
  );
});

(globalThis as unknown as { cowatchConnect: typeof roomManager.connect }).cowatchConnect =
  roomManager.connect.bind(roomManager);
