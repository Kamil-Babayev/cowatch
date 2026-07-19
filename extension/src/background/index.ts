import { SERVER_BASE_URL } from '../shared/config.ts';
import { RoomManager } from './room-manager.ts';
import { createMessageRouter, type TabsAPI, type SessionStorageAPI } from './message-router.ts';
import type { ToBackgroundMessage } from '../shared/runtime-messages.ts';

console.log('[CoWatch] background script loaded, server:', SERVER_BASE_URL);

const roomManager = new RoomManager();

// Thin adapters over the real `browser.*` APIs — this file is the only
// place that touches them directly; message-router.ts (and its tests)
// only ever see the TabsAPI/SessionStorageAPI shape.
const tabsAdapter: TabsAPI = {
  sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
  update: (tabId, props) => browser.tabs.update(tabId, props),
};

const sessionStorageAdapter: SessionStorageAPI = {
  set: (items) => browser.storage.session.set(items),
  get: (keys) => browser.storage.session.get(keys),
  remove: (keys) => browser.storage.session.remove(keys),
};

const handleMessage = createMessageRouter(roomManager, tabsAdapter, sessionStorageAdapter);

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  handleMessage(message as ToBackgroundMessage, sender);
  // No return value: every response this router produces is sent
  // proactively via tabs.sendMessage, not as a reply to this listener.
});

// Prevents a leaked RoomManager session (and its open WebSocket) once a
// tab closes — not called out as its own story anywhere, but the
// alternative is a slow, silent resource leak in normal use.
browser.tabs.onRemoved.addListener((tabId) => {
  roomManager.disconnect(tabId);
});

(globalThis as unknown as { cowatchConnect: typeof roomManager.connect }).cowatchConnect =
  roomManager.connect.bind(roomManager);
