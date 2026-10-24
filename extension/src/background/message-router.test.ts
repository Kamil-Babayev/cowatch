import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMessageRouter,
  type RoomAPI,
  type RoomControl,
  type SessionStorageAPI,
  type TabsAPI,
  type VideoRouting,
} from './message-router.ts';
import type { RoomManagerCallbacks, SessionInfo } from './room-manager.ts';
import type { ToContentMessage } from '../shared/runtime-messages.ts';
import type { AuthoritativePlayerState } from '../shared/player.ts';
import type { VideoSelection } from '../shared/video-frames.ts';

const PAGE = 'https://example.com/watch?v=1';

function fakeRoomManager() {
  const sessions = new Map<number, SessionInfo & { callbacks: RoomManagerCallbacks }>();
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const manager: RoomControl & { calls: typeof calls; callbacks: (tabId: number) => RoomManagerCallbacks } = {
    calls,
    callbacks: (tabId) => sessions.get(tabId)!.callbacks,
    connect: (tabId, roomId, hostToken, callbacks) => {
      calls.push({ method: 'connect', args: [tabId, roomId, hostToken] });
      sessions.set(tabId, { roomId, hostToken, isHost: Boolean(hostToken), controlMode: null, callbacks });
    },
    disconnect: (tabId, explicit) => {
      calls.push({ method: 'disconnect', args: [tabId, explicit] });
      sessions.delete(tabId);
    },
    getSession: (tabId) => sessions.get(tabId),
    requestState: (tabId) => calls.push({ method: 'requestState', args: [tabId] }),
    reportPlayerEvent: (...args) => calls.push({ method: 'reportPlayerEvent', args }),
    reportPlayerHeartbeat: (...args) => calls.push({ method: 'reportPlayerHeartbeat', args }),
  };
  return manager;
}

function fakeVideos(selectedFrame: number | null = 0) {
  const toTop: ToContentMessage[] = [];
  const toSelected: ToContentMessage[] = [];
  let listener: (tabId: number, selection: VideoSelection | null) => void = () => undefined;
  const videos: VideoRouting & {
    toTop: ToContentMessage[];
    toSelected: ToContentMessage[];
    fireSelection: (tabId: number, selection: VideoSelection | null) => void;
    topFails: boolean;
    navigations: number[][];
  } = {
    toTop,
    toSelected,
    topFails: false,
    navigations: [],
    fireSelection: (tabId, selection) => listener(tabId, selection),
    discover: async () => ({
      status: { hasVideo: true, candidates: [], selected: null },
      selectionChanged: false,
    }),
    select: async (_tabId, selection) => ({ hasVideo: true, candidates: [], selected: selection, manual: true }),
    clearManualSelection: async () => ({
      status: { hasVideo: true, candidates: [], selected: null, manual: false },
      selectionChanged: false,
    }),
    isSelected: (_tabId, frameId = 0) => frameId === selectedFrame,
    sendToSelected: async (_tabId, message) => {
      toSelected.push(message);
      return selectedFrame !== null;
    },
    sendToTop: async (_tabId, message) => {
      if (videos.topFails) throw new Error('no receiver');
      toTop.push(message);
    },
    clear: () => undefined,
    onSelectionChanged: (next) => {
      listener = next;
    },
    handleNavigation: (tabId, frameId) => {
      videos.navigations.push([tabId, frameId]);
    },
  };
  return videos;
}

function fakeStorage(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...initial };
  const storage: SessionStorageAPI & { stored: Record<string, unknown> } = {
    stored,
    set: (items) => {
      Object.assign(stored, items);
    },
    get: (keys) => Object.fromEntries(keys.map((key) => [key, stored[key]])),
    getAll: () => ({ ...stored }),
    remove: (keys) => {
      for (const key of keys) delete stored[key];
    },
  };
  return storage;
}

function fakeTabs(url = PAGE, existing = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 42])) {
  const updated: Array<{ tabId: number; url: string }> = [];
  const tabs: TabsAPI & { updated: typeof updated; url: string } = {
    updated,
    url,
    update: (tabId, props) => {
      updated.push({ tabId, url: props.url });
    },
    get: async (tabId) => {
      if (!existing.has(tabId)) throw new Error('no tab');
      return { url: tabs.url };
    },
  };
  return tabs;
}

function fakeApi(): RoomAPI & { minted: unknown[] } {
  const minted: unknown[] = [];
  return {
    minted,
    createRoom: async (videoUrl, controlMode) => {
      assert.equal(videoUrl, PAGE);
      assert.equal(controlMode, 'host-only');
      return { roomId: 'new-room', hostToken: 'host-token', joinToken: 'jt', joinUrl: 'http://x/join-page/?token=jt' };
    },
    mintFreshLink: async (roomId, hostToken) => {
      minted.push({ roomId, hostToken });
      return { joinUrl: 'http://x/join-page/?token=fresh', joinToken: 'fresh' };
    },
  };
}

function setup(options: { storage?: Record<string, unknown>; selectedFrame?: number | null; url?: string } = {}) {
  const roomManager = fakeRoomManager();
  const videos = fakeVideos(options.selectedFrame === undefined ? 0 : options.selectedFrame);
  const storage = fakeStorage(options.storage);
  const tabs = fakeTabs(options.url);
  const api = fakeApi();
  const router = createMessageRouter({ roomManager, tabs, storage, api, videos });
  return { router, roomManager, videos, storage, tabs, api };
}

function state(pageUrl = PAGE): AuthoritativePlayerState {
  return {
    revision: 2,
    source: { pageUrl, provider: 'native', mediaKey: pageUrl },
    position: 10,
    status: 'playing',
    timestamp: 1,
  };
}

test('ignores messages with no tab id', async () => {
  const { router, roomManager } = setup();
  await router.handleMessage({ kind: 'leaveRoom' }, {});
  assert.equal(roomManager.calls.length, 0);
});

test('player events count only from the selected frame', async () => {
  const { router, roomManager } = setup({ selectedFrame: 2 });
  const event = { action: 'play' as const, source: state().source, position: 1, status: 'playing' as const };
  await router.handleMessage({ kind: 'localPlayerEvent', event }, { tab: { id: 42, url: PAGE }, frameId: 0 });
  await router.handleMessage({ kind: 'playerHeartbeat', state: event }, { tab: { id: 42 }, frameId: 0 });
  assert.equal(roomManager.calls.length, 0);
  await router.handleMessage({ kind: 'localPlayerEvent', event }, { tab: { id: 42, url: PAGE }, frameId: 2 });
  await router.handleMessage({ kind: 'playerHeartbeat', state: event }, { tab: { id: 42, url: PAGE }, frameId: 2 });
  assert.deepEqual(roomManager.calls.map((call) => call.method), ['reportPlayerEvent', 'reportPlayerHeartbeat']);
  assert.equal(roomManager.calls[0].args[2], PAGE);
});

test('createRoom creates, remembers and connects the host tab', async () => {
  const { router, roomManager, storage, videos } = setup();
  const reply = await router.handleMessage(
    { kind: 'createRoom', tabId: 5, videoUrl: PAGE, controlMode: 'host-only' },
    {},
  );
  assert.deepEqual(reply, { roomId: 'new-room', joinUrl: 'http://x/join-page/?token=jt' });
  assert.deepEqual(roomManager.calls[0], { method: 'connect', args: [5, 'new-room', 'host-token'] });
  assert.deepEqual(storage.stored['activeSession:5'], { roomId: 'new-room', hostToken: 'host-token' });
  assert.equal((storage.stored['hostSession:5'] as { joinToken: string }).joinToken, 'jt');
  assert.deepEqual(videos.toTop[0], { kind: 'roomConnected', roomId: 'new-room' });
});

test('a reloaded page in the same room is brought up to date without reconnecting', async () => {
  const { router, roomManager, videos } = setup();
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', tabId: 1 }, {});
  const callbacks = roomManager.callbacks(1);
  await callbacks.onSession({ connectionId: 'c', isHost: false, controlMode: 'open' });
  await callbacks.onPresence({ connections: [{ connId: 'c', isHost: false }, { connId: 'h', isHost: true }] });
  videos.toTop.length = 0;
  videos.toSelected.length = 0;

  await router.handleMessage({ kind: 'checkPendingJoin' }, { tab: { id: 1 } });
  assert.equal(roomManager.calls.filter((call) => call.method === 'connect').length, 1);
  assert.deepEqual(videos.toTop.map((message) => message.kind), ['roomConnected', 'sessionInfo', 'presenceUpdate']);
  assert.deepEqual(videos.toSelected.map((message) => message.kind), ['sessionInfo']);
  assert.ok(roomManager.calls.some((call) => call.method === 'requestState'));
});

test('a pending join wins over the room the tab was in', async () => {
  const { router, roomManager, storage } = setup({
    storage: { 'activeSession:3': { roomId: 'old' }, 'pendingRoomId:3': 'new' },
  });
  await router.handleMessage({ kind: 'checkPendingJoin' }, { tab: { id: 3 } });
  assert.deepEqual(roomManager.calls[0], { method: 'connect', args: [3, 'new', undefined] });
  assert.equal(storage.stored['pendingRoomId:3'], undefined);
  await router.handleMessage({ kind: 'checkPendingJoin' }, { tab: { id: 4 } });
  assert.equal(roomManager.calls.length, 1, 'a tab with no room does nothing');
});

test('joinRequested leaves the current room and navigates to the video', async () => {
  const { router, roomManager, storage, tabs } = setup();
  await router.handleMessage({ kind: 'connectRoom', roomId: 'old', hostToken: 'h', tabId: 2 }, {});
  await router.handleMessage({ kind: 'joinRequested', roomId: 'new', videoUrl: PAGE }, { tab: { id: 2 } });
  assert.deepEqual(roomManager.calls.at(-1), { method: 'disconnect', args: [2, true] });
  assert.equal(storage.stored['activeSession:2'], undefined);
  assert.equal(storage.stored['hostSession:2'], undefined);
  assert.equal(storage.stored['pendingRoomId:2'], 'new');
  assert.deepEqual(tabs.updated, [{ tabId: 2, url: PAGE }]);
});

test('leaving tells the page the session ended and forgets the tab', async () => {
  const { router, roomManager, storage, videos } = setup();
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', hostToken: 'h', tabId: 6 }, {});
  storage.stored['hostSession:6'] = { roomId: 'r' };
  await router.handleMessage({ kind: 'leaveRoom', tabId: 6 }, {});
  assert.deepEqual(roomManager.calls.at(-1), { method: 'disconnect', args: [6, true] });
  assert.deepEqual(storage.stored, {});
  assert.deepEqual(videos.toTop.at(-1), { kind: 'roomEnded', reason: 'left' });
});

test('a closed room ends the tab session', async () => {
  const { router, roomManager, storage, videos } = setup();
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', tabId: 7 }, {});
  await roomManager.callbacks(7).onRoomClosed('room-gone');
  assert.equal(storage.stored['activeSession:7'], undefined);
  assert.deepEqual(videos.toTop.at(-1), { kind: 'roomEnded', reason: 'room-gone' });
});

test('room state goes to the selected player, with a notice after a resync', async () => {
  const { router, roomManager, videos } = setup();
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', tabId: 8 }, {});
  await roomManager.callbacks(8).onPlayerState(state('https://example.com/watch?t=30&v=1'), 'update');
  assert.deepEqual(videos.toSelected.at(-1), { kind: 'applyPlayerState', state: state('https://example.com/watch?t=30&v=1') });
  await roomManager.callbacks(8).onPlayerState(state(), 'resync');
  assert.deepEqual(videos.toTop.at(-1), { kind: 'resynced' });
});

test('a tab on another page follows the room once per source', async () => {
  const { router, roomManager, tabs, videos } = setup({ url: 'https://example.com/other' });
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', tabId: 9 }, {});
  const callbacks = roomManager.callbacks(9);
  await callbacks.onPlayerState(state(), 'update');
  await callbacks.onPlayerState(state(), 'update');
  assert.deepEqual(tabs.updated, [{ tabId: 9, url: PAGE }]);
  assert.equal(videos.toSelected.filter((message) => message.kind === 'applyPlayerState').length, 0);
  tabs.url = PAGE;
  await callbacks.onPlayerState(state(), 'update');
  tabs.url = 'https://example.com/other';
  await callbacks.onPlayerState(state(), 'update');
  assert.equal(tabs.updated.length, 2, 'following resumes after arriving');
});

test('a selection change sends the session and asks for state', async () => {
  const { router, roomManager, videos } = setup();
  videos.fireSelection(1, { frameId: 0, candidateId: 'x' });
  assert.equal(roomManager.calls.length, 0, 'ignored without a session');
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', tabId: 1 }, {});
  await roomManager.callbacks(1).onSession({ connectionId: 'c', isHost: true, controlMode: 'open' });
  videos.toSelected.length = 0;
  roomManager.calls.length = 0;
  videos.fireSelection(1, { frameId: 0, candidateId: 'y' });
  videos.fireSelection(1, null);
  assert.deepEqual(videos.toSelected.map((message) => message.kind), ['sessionInfo']);
  assert.deepEqual(roomManager.calls, [{ method: 'requestState', args: [1] }]);
});

test('restoreSessions reconnects stored tabs and drops closed ones', async () => {
  const { router, roomManager, storage } = setup({
    storage: {
      'activeSession:1': { roomId: 'a', hostToken: 'h' },
      'activeSession:777': { roomId: 'gone' },
      'hostSession:777': { roomId: 'gone' },
      'activeSession:bad': { roomId: 'x' },
      unrelated: true,
    },
  });
  await router.restoreSessions();
  assert.deepEqual(roomManager.calls, [{ method: 'connect', args: [1, 'a', 'h'] }]);
  assert.equal(storage.stored['activeSession:777'], undefined);
  assert.equal(storage.stored['hostSession:777'], undefined);
});

test('keepalive reconnects a tab whose session the event page lost', async () => {
  const { router, roomManager } = setup({ storage: { 'activeSession:4': { roomId: 'r' } } });
  await router.handleMessage({ kind: 'keepalive' }, { tab: { id: 4 } });
  await router.handleMessage({ kind: 'keepalive' }, { tab: { id: 4 } });
  assert.equal(roomManager.calls.filter((call) => call.method === 'connect').length, 1);
});

test('fresh links are minted for hosts only and update the stored link', async () => {
  const { router, storage, videos, api } = setup();
  await router.handleMessage({ kind: 'requestFreshLink' }, { tab: { id: 2 } });
  assert.deepEqual(videos.toTop.at(-1), { kind: 'freshLinkError', message: 'Only the host can generate a new link' });
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', hostToken: 'h', tabId: 2 }, {});
  storage.stored['hostSession:2'] = { roomId: 'r', hostToken: 'h', joinToken: 'old', joinUrl: 'old' };
  await router.handleMessage({ kind: 'requestFreshLink' }, { tab: { id: 2 } });
  assert.deepEqual(api.minted, [{ roomId: 'r', hostToken: 'h' }]);
  assert.deepEqual(videos.toTop.at(-1), { kind: 'freshLinkResult', joinUrl: 'http://x/join-page/?token=fresh' });
  assert.equal((storage.stored['hostSession:2'] as { joinToken: string }).joinToken, 'fresh');
});

test('a failed mint is reported to the page', async () => {
  const { router, videos, api } = setup();
  api.mintFreshLink = async () => {
    throw new Error('server down');
  };
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', hostToken: 'h', tabId: 3 }, {});
  await router.handleMessage({ kind: 'requestFreshLink' }, { tab: { id: 3 } });
  assert.deepEqual(videos.toTop.at(-1), { kind: 'freshLinkError', message: 'server down' });
});

test('video queries, selection and frame status routing', async () => {
  const { router, videos } = setup({ selectedFrame: 0 });
  assert.equal(((await router.handleMessage({ kind: 'queryVideoCandidates', tabId: 1 }, {})) as { hasVideo: boolean }).hasVideo, true);
  assert.equal(((await router.handleMessage({ kind: 'selectVideoCandidate', selection: { frameId: 0, candidateId: 'a' } }, { tab: { id: 1 } })) as { manual: boolean }).manual, true);
  assert.equal(((await router.handleMessage({ kind: 'clearVideoSelection' }, { tab: { id: 1 } })) as { manual: boolean }).manual, false);
  await router.handleMessage({ kind: 'frameVideoCandidatesChanged' }, { tab: { id: 1 } });
  await router.handleMessage({ kind: 'playerAdapterStatus', status: 'error' }, { tab: { id: 1 }, frameId: 3 });
  await router.handleMessage({ kind: 'playbackApplyFailed' }, { tab: { id: 1 }, frameId: 0 });
  assert.deepEqual(videos.toTop.map((message) => message.kind), ['playbackApplyFailed']);
  router.handleNavigation(1, 0);
  assert.deepEqual(videos.navigations, [[1, 0]]);
});

test('an unreachable top frame does not break connecting', async () => {
  const { router, roomManager, videos } = setup();
  videos.topFails = true;
  await router.handleMessage({ kind: 'connectRoom', roomId: 'r', tabId: 5 }, {});
  assert.equal(roomManager.calls[0].method, 'connect');
});
