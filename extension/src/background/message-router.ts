import type { RoomManager, RoomManagerCallbacks } from './room-manager.ts';
import type { RoomEndReason, ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';
import type { VideoCoordinator } from './video-coordinator.ts';
import type { PresencePayload, SessionPayload } from '../shared/messages.ts';
import type { ControlMode, CreateRoomResult } from '../shared/api-client.ts';
import { pageKey, samePage } from '../shared/page-key.ts';

/**
 * Minimal surface of `browser.tabs` this router actually needs — injected
 * rather than imported directly so this file is testable with a fake in
 * Node, and so background/index.ts is the only place that ever touches
 * the real `browser` global.
 */
export interface TabsAPI {
  update(tabId: number, updateProps: { url: string }): void | Promise<unknown>;
  get(tabId: number): Promise<{ url?: string }>;
}

/** Minimal surface of `browser.storage.session` this router needs. */
export interface SessionStorageAPI {
  set(items: Record<string, unknown>): void | Promise<void>;
  get(keys: string[]): Record<string, unknown> | Promise<Record<string, unknown>>;
  getAll(): Record<string, unknown> | Promise<Record<string, unknown>>;
  remove(keys: string[]): void | Promise<void>;
}

/** The parts of shared/api-client.ts this router needs, injected for tests. */
export interface RoomAPI {
  createRoom(videoUrl: string, controlMode: ControlMode): Promise<CreateRoomResult>;
  mintFreshLink(roomId: string, hostToken: string): Promise<{ joinUrl: string; joinToken: string }>;
}

export interface MessageSender {
  tab?: { id?: number; url?: string };
  frameId?: number;
}

export type RoomControl = Pick<
  RoomManager,
  'connect' | 'disconnect' | 'getSession' | 'requestState' | 'reportPlayerEvent' | 'reportPlayerHeartbeat'
>;

export type VideoRouting = Pick<
  VideoCoordinator,
  | 'discover'
  | 'select'
  | 'clearManualSelection'
  | 'isSelected'
  | 'sendToSelected'
  | 'sendToTop'
  | 'clear'
  | 'onSelectionChanged'
  | 'handleNavigation'
>;

export interface RouterDeps {
  roomManager: RoomControl;
  tabs: TabsAPI;
  storage: SessionStorageAPI;
  api: RoomAPI;
  videos: VideoRouting;
}

interface ActiveSession {
  roomId: string;
  hostToken?: string;
}

/** What the popup shows for a room this tab hosts. */
export interface HostSession {
  roomId: string;
  hostToken: string;
  joinToken: string;
  joinUrl: string;
}

export function activeSessionKey(tabId: number): string {
  return `activeSession:${tabId}`;
}

export function hostSessionKey(tabId: number): string {
  return `hostSession:${tabId}`;
}

function pendingRoomKey(tabId: number): string {
  return `pendingRoomId:${tabId}`;
}

export function createMessageRouter({ roomManager, tabs, storage, api, videos }: RouterDeps) {
  const sessionPayloads = new Map<number, SessionPayload>();
  const presence = new Map<number, PresencePayload>();
  // The page each tab was last sent to while following the room, so a
  // redirect that never lands on the exact URL cannot reload forever.
  const followed = new Map<number, string>();

  /** The top frame may have no listener yet (page still loading). */
  async function toTop(tabId: number, message: ToContentMessage): Promise<void> {
    try {
      await videos.sendToTop(tabId, message);
    } catch {
      // It asks again with checkPendingJoin once its content script runs.
    }
  }

  // Whatever changed the selection (discovery, the user, a navigation, a
  // frame disappearing), the newly selected frame needs to know whether it
  // is the host — so it heartbeats — and the room's current state.
  videos.onSelectionChanged((tabId, selection) => {
    if (!selection || !roomManager.getSession(tabId)) return;
    const payload = sessionPayloads.get(tabId);
    if (payload) void videos.sendToSelected(tabId, { kind: 'sessionInfo', payload });
    roomManager.requestState(tabId);
  });

  function forget(tabId: number): void {
    sessionPayloads.delete(tabId);
    presence.delete(tabId);
    followed.delete(tabId);
    videos.clear(tabId);
  }

  async function endTab(tabId: number, reason: RoomEndReason): Promise<void> {
    forget(tabId);
    await storage.remove([activeSessionKey(tabId), hostSessionKey(tabId)]);
    await toTop(tabId, { kind: 'roomEnded', reason });
  }

  function callbacksFor(tabId: number): RoomManagerCallbacks {
    return {
      onPlayerState: async (state, cause) => {
        const tab = await tabs.get(tabId).catch(() => null);
        if (tab?.url && !samePage(tab.url, state.source.pageUrl)) {
          const target = pageKey(state.source.pageUrl);
          if (followed.get(tabId) !== target) {
            followed.set(tabId, target);
            await tabs.update(tabId, { url: state.source.pageUrl });
          }
          return;
        }
        followed.delete(tabId);
        await videos.sendToSelected(tabId, { kind: 'applyPlayerState', state });
        if (cause === 'resync') await toTop(tabId, { kind: 'resynced' });
      },
      onControlDenied: (reason) => toTop(tabId, { kind: 'controlDenied', reason }),
      onPresence: (payload) => {
        presence.set(tabId, payload);
        return toTop(tabId, { kind: 'presenceUpdate', payload });
      },
      onSession: (payload) => {
        sessionPayloads.set(tabId, payload);
        void videos.sendToSelected(tabId, { kind: 'sessionInfo', payload });
        return toTop(tabId, { kind: 'sessionInfo', payload });
      },
      onConnectionState: (state) => toTop(tabId, { kind: 'connectionState', state }),
      onRoomClosed: (reason) => endTab(tabId, reason),
    };
  }

  /** Brings a freshly loaded top frame up to date with the tab's room. */
  async function announce(tabId: number, roomId: string): Promise<void> {
    await toTop(tabId, { kind: 'roomConnected', roomId });
    const payload = sessionPayloads.get(tabId);
    if (payload) await toTop(tabId, { kind: 'sessionInfo', payload });
    const current = presence.get(tabId);
    if (current) await toTop(tabId, { kind: 'presenceUpdate', payload: current });
  }

  async function connectTab(tabId: number, roomId: string, hostToken?: string): Promise<void> {
    const current = roomManager.getSession(tabId);
    if (current?.roomId === roomId && current.hostToken === hostToken) {
      // Same room, new page (a reload or a followed navigation): the socket
      // is fine, but the page's overlay and player know nothing yet.
      await announce(tabId, roomId);
      const payload = sessionPayloads.get(tabId);
      if (payload) void videos.sendToSelected(tabId, { kind: 'sessionInfo', payload });
      roomManager.requestState(tabId);
      void videos.discover(tabId);
      return;
    }

    forget(tabId);
    await storage.set({ [activeSessionKey(tabId)]: { roomId, hostToken } satisfies ActiveSession });
    roomManager.connect(tabId, roomId, hostToken, callbacksFor(tabId));
    await announce(tabId, roomId);
    void videos.discover(tabId);
  }

  async function storedActiveSession(tabId: number): Promise<ActiveSession | undefined> {
    const key = activeSessionKey(tabId);
    const result = await storage.get([key]);
    const active = result[key] as ActiveSession | undefined;
    return active?.roomId ? active : undefined;
  }

  /**
   * Firefox may unload the background event page and start it again later
   * with empty memory; reconnect every tab storage says is in a room.
   */
  async function restoreSessions(): Promise<void> {
    const all = await storage.getAll();
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith('activeSession:')) continue;
      const tabId = Number(key.slice('activeSession:'.length));
      const active = value as ActiveSession | undefined;
      if (!Number.isInteger(tabId) || !active?.roomId || roomManager.getSession(tabId)) continue;
      try {
        await tabs.get(tabId);
      } catch {
        await storage.remove([key, hostSessionKey(tabId), pendingRoomKey(tabId)]);
        continue;
      }
      await connectTab(tabId, active.roomId, active.hostToken);
    }
  }

  async function handleMessage(msg: ToBackgroundMessage, sender: MessageSender): Promise<unknown> {
    const explicitTabId =
      msg.kind === 'queryVideoCandidates'
      || msg.kind === 'connectRoom'
      || msg.kind === 'leaveRoom'
      || msg.kind === 'createRoom'
        ? msg.tabId
        : undefined;
    const tabId = explicitTabId ?? sender.tab?.id;
    if (tabId == null) return; // every message this router handles is tab-scoped
    const fromSelectedFrame = () => videos.isSelected(tabId, sender.frameId ?? 0);

    switch (msg.kind) {
      case 'queryVideoCandidates':
        return (await videos.discover(tabId)).status;

      case 'selectVideoCandidate':
        return videos.select(tabId, msg.selection);

      case 'clearVideoSelection':
        return (await videos.clearManualSelection(tabId)).status;

      case 'frameVideoCandidatesChanged':
        await videos.discover(tabId);
        return;

      case 'localPlayerEvent':
        if (fromSelectedFrame()) roomManager.reportPlayerEvent(tabId, msg.event, sender.tab?.url);
        return;

      case 'playerHeartbeat':
        if (fromSelectedFrame()) roomManager.reportPlayerHeartbeat(tabId, msg.state, sender.tab?.url);
        return;

      case 'playerAdapterStatus':
        if (fromSelectedFrame()) await toTop(tabId, msg);
        return;

      case 'playbackApplyFailed':
        if (fromSelectedFrame()) await toTop(tabId, { kind: 'playbackApplyFailed' });
        return;

      case 'createRoom': {
        const created = await api.createRoom(msg.videoUrl, msg.controlMode);
        await storage.set({
          [hostSessionKey(tabId)]: {
            roomId: created.roomId,
            hostToken: created.hostToken,
            joinToken: created.joinToken,
            joinUrl: created.joinUrl,
          } satisfies HostSession,
        });
        await connectTab(tabId, created.roomId, created.hostToken);
        return { roomId: created.roomId, joinUrl: created.joinUrl };
      }

      case 'connectRoom':
        await connectTab(tabId, msg.roomId, msg.hostToken);
        return;

      case 'leaveRoom':
        roomManager.disconnect(tabId, true);
        await endTab(tabId, 'left');
        return;

      case 'joinRequested':
        // A new join link replaces whatever room this tab was in. Then
        // navigate the landing page to the video, remembering which room to
        // join once it loads. storage.session survives the event page being
        // unloaded in between.
        if (roomManager.getSession(tabId)) roomManager.disconnect(tabId, true);
        forget(tabId);
        await storage.remove([activeSessionKey(tabId), hostSessionKey(tabId)]);
        await storage.set({ [pendingRoomKey(tabId)]: msg.roomId });
        await tabs.update(tabId, { url: msg.videoUrl });
        return;

      case 'checkPendingJoin': {
        const key = pendingRoomKey(tabId);
        const pending = (await storage.get([key]))[key] as string | undefined;
        if (pending) {
          // Cleared once read — a leftover key must never make a later,
          // unrelated page load join the same room again.
          await storage.remove([key]);
          await connectTab(tabId, pending);
          return;
        }
        const active = await storedActiveSession(tabId);
        if (active) await connectTab(tabId, active.roomId, active.hostToken);
        return;
      }

      case 'keepalive': {
        if (roomManager.getSession(tabId)) return;
        const active = await storedActiveSession(tabId);
        if (active) await connectTab(tabId, active.roomId, active.hostToken);
        return;
      }

      case 'requestFreshLink': {
        const session = roomManager.getSession(tabId);
        if (!session?.hostToken) {
          // No session, or not the host — retrying will not help, unlike a
          // network failure.
          await toTop(tabId, { kind: 'freshLinkError', message: 'Only the host can generate a new link' });
          return;
        }
        try {
          const result = await api.mintFreshLink(session.roomId, session.hostToken);
          const key = hostSessionKey(tabId);
          const stored = (await storage.get([key]))[key] as HostSession | undefined;
          if (stored) await storage.set({ [key]: { ...stored, joinToken: result.joinToken, joinUrl: result.joinUrl } });
          await toTop(tabId, { kind: 'freshLinkResult', joinUrl: result.joinUrl });
        } catch (err) {
          await toTop(tabId, { kind: 'freshLinkError', message: (err as Error).message });
        }
        return;
      }
    }
  }

  return {
    handleMessage,
    restoreSessions,
    handleNavigation: (tabId: number, frameId: number) => videos.handleNavigation(tabId, frameId),
  };
}
