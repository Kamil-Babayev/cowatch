import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageRouter, type TabsAPI, type SessionStorageAPI, type LinkMinter } from './message-router.ts';

function makeFakeRoomManager(sessions: Record<number, { roomId: string; hostToken?: string; isHost: boolean }> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    calls,
    connect: (...args: unknown[]) => calls.push({ method: 'connect', args }),
    disconnect: (...args: unknown[]) => calls.push({ method: 'disconnect', args }),
    reportLocalEvent: (...args: unknown[]) => calls.push({ method: 'reportLocalEvent', args }),
    getSession: (tabId: number) => sessions[tabId],
  };
}

function makeFakeLinkMinter(
  impl: (roomId: string, hostToken: string) => Promise<{ joinUrl: string; joinToken: string }> = async (
    _roomId,
    _hostToken,
  ) => ({ joinUrl: 'http://x/join-page/?token=fresh', joinToken: 'fresh' }),
): LinkMinter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    mintFreshLink: (roomId, hostToken) => {
      calls.push({ roomId, hostToken });
      return impl(roomId, hostToken);
    },
  };
}

function makeFakeTabs(): TabsAPI & { sent: unknown[]; updated: unknown[] } {
  const sent: unknown[] = [];
  const updated: unknown[] = [];
  return {
    sent,
    updated,
    sendMessage: (tabId, message) => {
      sent.push({ tabId, message });
    },
    update: (tabId, props) => {
      updated.push({ tabId, props });
    },
  };
}

function makeFakeSessionStorage(): SessionStorageAPI & { stored: Record<string, unknown> } {
  const stored: Record<string, unknown> = {};
  return {
    stored,
    set: (items) => {
      Object.assign(stored, items);
    },
    get: (keys) => {
      const result: Record<string, unknown> = {};
      for (const key of keys) result[key] = stored[key];
      return result;
    },
    remove: (keys) => {
      for (const key of keys) delete stored[key];
    },
  };
}

test('ignores messages with no tab id (not from a content script)', async () => {
  const roomManager = makeFakeRoomManager();
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const handle = createMessageRouter(roomManager as never, tabs, storage, makeFakeLinkMinter());

  await handle({ kind: 'leaveRoom' }, {});

  assert.equal(roomManager.calls.length, 0);
});

test('localPlaybackEvent forwards to roomManager.reportLocalEvent with the right tabId', async () => {
  const roomManager = makeFakeRoomManager();
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const handle = createMessageRouter(roomManager as never, tabs, storage, makeFakeLinkMinter());

  const event = { type: 'play' as const, currentTime: 5, isPlaying: true };
  await handle({ kind: 'localPlaybackEvent', event }, { tab: { id: 42 } });

  assert.deepEqual(roomManager.calls, [{ method: 'reportLocalEvent', args: [42, event] }]);
});

test('connectRoom wires callbacks that route back to the same tab', async () => {
  const roomManager = makeFakeRoomManager();
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const handle = createMessageRouter(roomManager as never, tabs, storage, makeFakeLinkMinter());

  await handle({ kind: 'connectRoom', roomId: 'room-1', hostToken: 'tok' }, { tab: { id: 7 } });

  assert.equal(roomManager.calls.length, 1);
  assert.equal(roomManager.calls[0].method, 'connect');
  const [tabId, roomId, hostToken, callbacks] = roomManager.calls[0].args as [
    number,
    string,
    string,
    Record<string, (arg: unknown) => void>,
  ];
  assert.equal(tabId, 7);
  assert.equal(roomId, 'room-1');
  assert.equal(hostToken, 'tok');

  assert.equal(tabs.sent.length, 1);
  assert.deepEqual(tabs.sent[0], { tabId: 7, message: { kind: 'roomConnected', roomId: 'room-1' } });

  // Exercise the injected callbacks directly — this is exactly how
  // RoomManager will call them, without needing a real WebSocket here.
  callbacks.onRemotePlayback({ type: 'pause', currentTime: 1, isPlaying: false });
  callbacks.onJoinSeek(12);
  callbacks.onControlDenied('host-only room');
  callbacks.onPresence({ connections: [] });

  assert.equal(tabs.sent.length, 5);
  assert.deepEqual(tabs.sent[1], {
    tabId: 7,
    message: { kind: 'remotePlaybackEvent', event: { type: 'pause', currentTime: 1, isPlaying: false } },
  });
  assert.deepEqual(tabs.sent[2], { tabId: 7, message: { kind: 'joinSeek', targetSeconds: 12 } });
  assert.deepEqual(tabs.sent[3], {
    tabId: 7,
    message: { kind: 'controlDenied', reason: 'host-only room' },
  });
});

test('joinRequested stores pendingRoomId keyed by tab and navigates the tab', async () => {
  const roomManager = makeFakeRoomManager();
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const handle = createMessageRouter(roomManager as never, tabs, storage, makeFakeLinkMinter());

  await handle(
    { kind: 'joinRequested', roomId: 'room-9', videoUrl: 'https://example.com/watch' },
    { tab: { id: 3 } },
  );

  assert.deepEqual(storage.stored, { 'pendingRoomId:3': 'room-9' });
  assert.deepEqual(tabs.updated, [{ tabId: 3, props: { url: 'https://example.com/watch' } }]);
});

test('leaveRoom disconnects the right tab', async () => {
  const roomManager = makeFakeRoomManager();
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const handle = createMessageRouter(roomManager as never, tabs, storage, makeFakeLinkMinter());

  await handle({ kind: 'leaveRoom' }, { tab: { id: 99 } });

  assert.deepEqual(roomManager.calls, [{ method: 'disconnect', args: [99] }]);
});

test('extensionInstalledCheck replies on the same tab', async () => {
  const roomManager = makeFakeRoomManager();
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const handle = createMessageRouter(roomManager as never, tabs, storage, makeFakeLinkMinter());

  await handle({ kind: 'extensionInstalledCheck' }, { tab: { id: 5 } });

  assert.deepEqual(tabs.sent, [{ tabId: 5, message: { kind: 'extensionInstalledResponse' } }]);
});

test('checkPendingJoin returns the stored roomId and clears it after reading', async () => {
  const roomManager = makeFakeRoomManager();
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  storage.stored['pendingRoomId:11'] = 'room-abc';
  const handle = createMessageRouter(roomManager as never, tabs, storage, makeFakeLinkMinter());

  await handle({ kind: 'checkPendingJoin' }, { tab: { id: 11 } });

  assert.deepEqual(tabs.sent, [{ tabId: 11, message: { kind: 'pendingJoinResult', roomId: 'room-abc' } }]);
  assert.equal(storage.stored['pendingRoomId:11'], undefined);
});

test('checkPendingJoin returns null when nothing is pending for this tab', async () => {
  const roomManager = makeFakeRoomManager();
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const handle = createMessageRouter(roomManager as never, tabs, storage, makeFakeLinkMinter());

  await handle({ kind: 'checkPendingJoin' }, { tab: { id: 12 } });

  assert.deepEqual(tabs.sent, [{ tabId: 12, message: { kind: 'pendingJoinResult', roomId: null } }]);
});

test('requestFreshLink mints via the injected LinkMinter and replies with the result', async () => {
  const roomManager = makeFakeRoomManager({ 20: { roomId: 'room-20', hostToken: 'host-tok-20', isHost: true } });
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const linkMinter = makeFakeLinkMinter(async (roomId, hostToken) => {
    assert.equal(roomId, 'room-20');
    assert.equal(hostToken, 'host-tok-20');
    return { joinUrl: 'http://x/join-page/?token=abc', joinToken: 'abc' };
  });
  const handle = createMessageRouter(roomManager as never, tabs, storage, linkMinter);

  await handle({ kind: 'requestFreshLink' }, { tab: { id: 20 } });

  assert.equal(linkMinter.calls.length, 1);
  assert.deepEqual(tabs.sent, [
    { tabId: 20, message: { kind: 'freshLinkResult', joinUrl: 'http://x/join-page/?token=abc' } },
  ]);
});

test('requestFreshLink replies with freshLinkError when the tab has no host session', async () => {
  const roomManager = makeFakeRoomManager(); // no session for tab 21 at all
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const linkMinter = makeFakeLinkMinter();
  const handle = createMessageRouter(roomManager as never, tabs, storage, linkMinter);

  await handle({ kind: 'requestFreshLink' }, { tab: { id: 21 } });

  assert.equal(linkMinter.calls.length, 0); // never even attempted
  assert.deepEqual(tabs.sent, [
    { tabId: 21, message: { kind: 'freshLinkError', message: 'Only the host can generate a new link' } },
  ]);
});

test('requestFreshLink replies with freshLinkError when the tab is a joiner, not the host', async () => {
  // Present in the room, but hostToken is undefined — a non-host session.
  const roomManager = makeFakeRoomManager({ 22: { roomId: 'room-22', hostToken: undefined, isHost: false } });
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const linkMinter = makeFakeLinkMinter();
  const handle = createMessageRouter(roomManager as never, tabs, storage, linkMinter);

  await handle({ kind: 'requestFreshLink' }, { tab: { id: 22 } });

  assert.equal(linkMinter.calls.length, 0);
  assert.deepEqual(tabs.sent, [
    { tabId: 22, message: { kind: 'freshLinkError', message: 'Only the host can generate a new link' } },
  ]);
});

test('requestFreshLink replies with freshLinkError when minting itself fails', async () => {
  const roomManager = makeFakeRoomManager({ 23: { roomId: 'room-23', hostToken: 'tok', isHost: true } });
  const tabs = makeFakeTabs();
  const storage = makeFakeSessionStorage();
  const linkMinter = makeFakeLinkMinter(async () => {
    throw new Error('mintFreshLink failed (401)');
  });
  const handle = createMessageRouter(roomManager as never, tabs, storage, linkMinter);

  await handle({ kind: 'requestFreshLink' }, { tab: { id: 23 } });

  assert.deepEqual(tabs.sent, [
    { tabId: 23, message: { kind: 'freshLinkError', message: 'mintFreshLink failed (401)' } },
  ]);
});
