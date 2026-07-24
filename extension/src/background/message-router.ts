import type { RoomManager } from './room-manager.ts';
import type { ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';
import type { VideoCoordinator } from './video-coordinator.ts';
import type { VideoSelection, VideoTabStatus } from '../shared/video-frames.ts';
import type { SessionPayload } from '../shared/messages.ts';

/**
 * Minimal surface of `browser.tabs` this router actually needs — injected
 * rather than imported directly so this file is testable with a fake in
 * Node, and so background/index.ts is the only place that ever touches
 * the real `browser` global.
 */
export interface TabsAPI {
  sendMessage(
    tabId: number,
    message: ToContentMessage,
    options?: { frameId?: number },
  ): unknown | Promise<unknown>;
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
  frameId?: number;
  documentId?: string;
}

type VideoRouting = Pick<
  VideoCoordinator,
  | 'discover'
  | 'select'
  | 'clearManualSelection'
  | 'noteDocument'
  | 'isSelected'
  | 'sendToSelected'
  | 'sendToTop'
  | 'clear'
>;

export function createMessageRouter(
  roomManager: RoomManager,
  tabs: TabsAPI,
  sessionStorage: SessionStorageAPI,
  linkMinter: LinkMinter,
  videos?: VideoRouting,
) {
  const emptyStatus: VideoTabStatus = {
    hasVideo: false,
    candidates: [],
    selected: null,
  };
  const videoRouting: VideoRouting = videos ?? {
    discover: async () => ({ status: emptyStatus, selectionChanged: false }),
    select: async (_tabId: number, selection: VideoSelection) => ({
      ...emptyStatus,
      selected: selection,
    }),
    clearManualSelection: async () => ({ status: emptyStatus, selectionChanged: false }),
    noteDocument: () => undefined,
    isSelected: () => true,
    sendToSelected: async (tabId, message) => {
      await tabs.sendMessage(tabId, message);
      return true;
    },
    sendToTop: async (tabId, message) => {
      await tabs.sendMessage(tabId, message);
    },
    clear: () => undefined,
  };
  const sessionPayloads = new Map<number, SessionPayload>();
  function activeSessionKey(tabId: number): string {
    return `activeSession:${tabId}`;
  }

  function hostSessionKey(tabId: number): string {
    return `hostSession:${tabId}`;
  }

  async function clearSessionIfCurrent(tabId: number, roomId: string): Promise<void> {
    const activeKey = activeSessionKey(tabId);
    const result = await sessionStorage.get([activeKey]);
    const active = result[activeKey] as { roomId?: string } | undefined;
    if (active?.roomId === roomId) {
      await sessionStorage.remove([activeKey, hostSessionKey(tabId)]);
    }
  }

  async function connectTab(tabId: number, roomId: string, hostToken?: string): Promise<void> {
    await videoRouting.discover(tabId);
    const current = roomManager.getSession(tabId);
    if (
      current?.roomId === roomId
      && current.hostToken === hostToken
    ) {
      await videoRouting.sendToTop(tabId, { kind: 'roomConnected', roomId });
      return;
    }

    await sessionStorage.set({
      [activeSessionKey(tabId)]: { roomId, hostToken },
    });
    roomManager.connect(tabId, roomId, hostToken, {
      onRemotePlayback: (event) =>
        videoRouting.sendToSelected(tabId, { kind: 'remotePlaybackEvent', event }),
      onAuthoritativeState: (state, source) => {
        void videoRouting.sendToTop(tabId, {
          kind: 'authoritativeState',
          currentTime: state.currentTime,
          isPlaying: state.isPlaying,
          source,
        });
        return videoRouting.sendToSelected(tabId, {
          kind: 'authoritativeState',
          currentTime: state.currentTime,
          isPlaying: state.isPlaying,
          source,
        });
      },
      onTimeSync: (state, timestamp) =>
        videoRouting.sendToSelected(tabId, { kind: 'timeSync', state, timestamp }),
      onControlDenied: (reason) =>
        videoRouting.sendToTop(tabId, { kind: 'controlDenied', reason }),
      onPresence: (payload) =>
        videoRouting.sendToTop(tabId, { kind: 'presenceUpdate', payload }),
      onSession: (payload) => {
        sessionPayloads.set(tabId, payload);
        void videoRouting.sendToSelected(tabId, { kind: 'sessionInfo', payload });
        return videoRouting.sendToTop(tabId, { kind: 'sessionInfo', payload });
      },
      onConnectionState: (state) => {
        if (state === 'error' || state === 'disconnected') {
          void clearSessionIfCurrent(tabId, roomId);
        }
        return videoRouting.sendToTop(tabId, { kind: 'connectionState', state });
      },
      onRoomClosed: (reason) => {
        sessionPayloads.delete(tabId);
        void clearSessionIfCurrent(tabId, roomId);
        void videoRouting.sendToTop(tabId, { kind: 'roomClosed', reason });
      },
    });
    await videoRouting.sendToTop(tabId, { kind: 'roomConnected', roomId });
  }

  return async function handleMessage(msg: ToBackgroundMessage, sender: MessageSender): Promise<unknown> {
    const explicitTabId =
      msg.kind === 'queryVideoCandidates'
      || msg.kind === 'connectRoom'
      || msg.kind === 'leaveRoom'
        ? msg.tabId
        : undefined;
    const tabId = explicitTabId ?? sender.tab?.id;
    if (tabId == null) return; // every message this router handles is tab-scoped

    switch (msg.kind) {
      case 'queryVideoCandidates':
        return (await videoRouting.discover(tabId)).status;

      case 'selectVideoCandidate':
        return videoRouting.select(tabId, msg.selection);

      case 'clearVideoSelection':
        return (await videoRouting.clearManualSelection(tabId)).status;

      case 'frameVideoCandidatesChanged': {
        videoRouting.noteDocument(tabId, sender.frameId ?? 0, sender.documentId);
        const result = await videoRouting.discover(tabId);
        if (result.selectionChanged && roomManager.getSession(tabId)) {
          const sessionPayload = sessionPayloads.get(tabId);
          if (sessionPayload) {
            await videoRouting.sendToSelected(tabId, {
              kind: 'sessionInfo',
              payload: sessionPayload,
            });
          }
          roomManager.requestState(tabId);
        }
        return;
      }

      case 'localPlaybackEvent':
        if (!videoRouting.isSelected(tabId, sender.frameId, sender.documentId)) return;
        roomManager.reportLocalEvent(tabId, msg.event);
        return;

      case 'playbackHeartbeat':
        if (!videoRouting.isSelected(tabId, sender.frameId, sender.documentId)) return;
        roomManager.reportHeartbeat(tabId, msg.state);
        return;

      case 'playbackApplyFailed':
        if (!videoRouting.isSelected(tabId, sender.frameId, sender.documentId)) return;
        await videoRouting.sendToTop(tabId, { kind: 'playbackApplyFailed' });
        return;

      case 'connectRoom':
        await connectTab(tabId, msg.roomId, msg.hostToken);
        return;

      case 'leaveRoom':
        roomManager.disconnect(tabId);
        sessionPayloads.delete(tabId);
        videoRouting.clear(tabId);
        await sessionStorage.remove([activeSessionKey(tabId), hostSessionKey(tabId)]);
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
        await videoRouting.sendToTop(tabId, { kind: 'extensionInstalledResponse' });
        return;

      case 'checkPendingJoin': {
        const activeKey = activeSessionKey(tabId);
        const key = `pendingRoomId:${tabId}`;
        const result = await sessionStorage.get([activeKey, key]);
        const active = result[activeKey] as
          | { roomId: string; hostToken?: string }
          | undefined;
        if (active?.roomId) {
          await connectTab(tabId, active.roomId, active.hostToken);
          await videoRouting.sendToTop(tabId, { kind: 'pendingJoinResult', roomId: null });
          return;
        }
        const roomId = (result[key] as string | undefined) ?? null;
        if (roomId) {
          // Cleared once read — a stale leftover key must never cause a
          // second, unrelated page load to auto-join the same room.
          await sessionStorage.remove([key]);
          await connectTab(tabId, roomId);
          await videoRouting.sendToTop(tabId, { kind: 'pendingJoinResult', roomId: null });
          return;
        }
        await videoRouting.sendToTop(tabId, { kind: 'pendingJoinResult', roomId });
        return;
      }

      case 'requestFreshLink': {
        const session = roomManager.getSession(tabId);
        if (!session || !session.hostToken) {
          // Either no active session for this tab, or this tab isn't the
          // host — distinct from a network/server failure, worth telling
          // the overlay apart so it doesn't imply "try again" for
          // something retrying won't fix.
          await videoRouting.sendToTop(tabId, {
            kind: 'freshLinkError',
            message: 'Only the host can generate a new link',
          });
          return;
        }
        try {
          const result = await linkMinter.mintFreshLink(session.roomId, session.hostToken);
          await videoRouting.sendToTop(tabId, { kind: 'freshLinkResult', joinUrl: result.joinUrl });
        } catch (err) {
          await videoRouting.sendToTop(tabId, { kind: 'freshLinkError', message: (err as Error).message });
        }
        return;
      }
    }
  };
}
