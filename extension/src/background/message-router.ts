import type { RoomManager } from './room-manager.ts';
import type { ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';

/**
 * Minimal surface of `browser.tabs` this router actually needs — injected
 * rather than imported directly so this file is testable with a fake in
 * Node, and so background/index.ts is the only place that ever touches
 * the real `browser` global.
 */
export interface TabsAPI {
  sendMessage(tabId: number, message: ToContentMessage): void | Promise<void>;
  update(tabId: number, updateProps: { url: string }): void | Promise<unknown>;
}

/** Minimal surface of `browser.storage.session` this router needs. */
export interface SessionStorageAPI {
  set(items: Record<string, unknown>): void | Promise<void>;
  get(keys: string[]): Record<string, unknown> | Promise<Record<string, unknown>>;
  remove(keys: string[]): void | Promise<void>;
}

/**
 * Minimal surface of shared/api-client.ts's mintFreshLink this router
 * needs — injected for the same reason as TabsAPI/SessionStorageAPI:
 * testable with a fake in Node, real fetch only ever wired in
 * background/index.ts.
 */
export interface LinkMinter {
  mintFreshLink(roomId: string, hostToken: string): Promise<{ joinUrl: string; joinToken: string }>;
}

export interface MessageSender {
  tab?: { id?: number };
}

export function createMessageRouter(
  roomManager: RoomManager,
  tabs: TabsAPI,
  sessionStorage: SessionStorageAPI,
  linkMinter: LinkMinter,
) {
  return async function handleMessage(msg: ToBackgroundMessage, sender: MessageSender): Promise<void> {
    const tabId = sender.tab?.id;
    if (tabId == null) return; // every message this router handles is tab-scoped

    switch (msg.kind) {
      case 'localPlaybackEvent':
        roomManager.reportLocalEvent(tabId, msg.event);
        return;

      case 'connectRoom':
        roomManager.connect(tabId, msg.roomId, msg.hostToken, {
          onRemotePlayback: (event) => tabs.sendMessage(tabId, { kind: 'remotePlaybackEvent', event }),
          onJoinSeek: (targetSeconds) => tabs.sendMessage(tabId, { kind: 'joinSeek', targetSeconds }),
          onControlDenied: (reason) => tabs.sendMessage(tabId, { kind: 'controlDenied', reason }),
          onPresence: (payload) => tabs.sendMessage(tabId, { kind: 'presenceUpdate', payload }),
        });
        await tabs.sendMessage(tabId, { kind: 'roomConnected', roomId: msg.roomId });
        return;

      case 'leaveRoom':
        roomManager.disconnect(tabId);
        return;

      case 'joinRequested':
        // US-2.11: navigate this tab (currently the landing page) to the
        // real videoUrl, remembering which room to auto-join once that
        // page loads. storage.session (not a plain variable) survives the
        // background script being suspended/restarted — Firefox's MV3
        // background is a non-persistent event page, not a Chrome-style
        // service worker that's guaranteed to stay resident.
        await sessionStorage.set({ [`pendingRoomId:${tabId}`]: msg.roomId });
        await tabs.update(tabId, { url: msg.videoUrl });
        return;

      case 'extensionInstalledCheck':
        await tabs.sendMessage(tabId, { kind: 'extensionInstalledResponse' });
        return;

      case 'checkPendingJoin': {
        const key = `pendingRoomId:${tabId}`;
        const result = await sessionStorage.get([key]);
        const roomId = (result[key] as string | undefined) ?? null;
        if (roomId) {
          // Cleared once read — a stale leftover key must never cause a
          // second, unrelated page load to auto-join the same room.
          await sessionStorage.remove([key]);
        }
        await tabs.sendMessage(tabId, { kind: 'pendingJoinResult', roomId });
        return;
      }

      case 'requestFreshLink': {
        const session = roomManager.getSession(tabId);
        if (!session || !session.hostToken) {
          // Either no active session for this tab, or this tab isn't the
          // host — distinct from a network/server failure, worth telling
          // the overlay apart so it doesn't imply "try again" for
          // something retrying won't fix.
          await tabs.sendMessage(tabId, {
            kind: 'freshLinkError',
            message: 'Only the host can generate a new link',
          });
          return;
        }
        try {
          const result = await linkMinter.mintFreshLink(session.roomId, session.hostToken);
          await tabs.sendMessage(tabId, { kind: 'freshLinkResult', joinUrl: result.joinUrl });
        } catch (err) {
          await tabs.sendMessage(tabId, { kind: 'freshLinkError', message: (err as Error).message });
        }
        return;
      }
    }
  };
}
