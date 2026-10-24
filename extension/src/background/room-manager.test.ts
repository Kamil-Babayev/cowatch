import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as WSConnection } from 'ws';
import type {
  RoomManager as RoomManagerClass,
  RoomManagerCallbacks,
  RoomManagerOptions,
  PlayerStateCause,
} from './room-manager.ts';
import type { AuthoritativePlayerState } from '../shared/player.ts';

let wss: WebSocketServer;
let RoomManager: typeof RoomManagerClass;
let serverSockets: WSConnection[] = [];
let serverReceived: Array<{ type: string; payload?: Record<string, unknown> }> = [];
const managers: RoomManagerClass[] = [];

const source = { pageUrl: 'https://watch.example/movie', provider: 'native' as const, mediaKey: 'https://watch.example/movie' };

function makeCallbacks() {
  const states: Array<{ state: AuthoritativePlayerState; cause: PlayerStateCause }> = [];
  const denials: string[] = [];
  const closed: string[] = [];
  const connectionStates: string[] = [];
  const callbacks: RoomManagerCallbacks = {
    onPlayerState: (state, cause) => states.push({ state, cause }),
    onControlDenied: (reason) => denials.push(reason),
    onPresence: () => undefined,
    onSession: () => undefined,
    onRoomClosed: (reason) => closed.push(reason),
    onConnectionState: (state) => connectionStates.push(state),
  };
  return { callbacks, states, denials, closed, connectionStates };
}

function manager(options: RoomManagerOptions = {}): RoomManagerClass {
  const created = new RoomManager({ reconnectDelays: [10], random: () => 0.5, ...options });
  managers.push(created);
  return created;
}

before(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  wss.on('connection', (socket: WSConnection) => {
    serverSockets.push(socket);
    socket.on('message', (data) => serverReceived.push(JSON.parse(data.toString())));
  });
  (globalThis as unknown as { __SERVER_BASE_URL__: string }).__SERVER_BASE_URL__ = `http://localhost:${port}`;
  RoomManager = (await import('./room-manager.ts')).RoomManager;
});

after(async () => {
  for (const socket of wss.clients) socket.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

beforeEach(() => {
  serverSockets = [];
  serverReceived = [];
});

afterEach(() => {
  for (const created of managers.splice(0)) created.disconnectAll();
});

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function connected(
  roomManager: RoomManagerClass,
  tabId: number,
  hostToken?: string,
  session = { connectionId: 'me', isHost: Boolean(hostToken), controlMode: 'open' },
) {
  const cb = makeCallbacks();
  roomManager.connect(tabId, `room-${tabId}`, hostToken, cb.callbacks);
  await waitFor(() => serverSockets.length > 0, 'no server socket');
  await waitFor(() => cb.connectionStates.includes('connected'), 'client socket did not open');
  const socket = serverSockets[serverSockets.length - 1];
  socket.send(JSON.stringify({ type: 'session', payload: session, timestamp: Date.now() }));
  await waitFor(() => roomManager.getSession(tabId)?.isHost === session.isHost, 'session not applied');
  return { cb, socket };
}

function sent(type: string) {
  return serverReceived.filter((message) => message.type === type);
}

test('player intents become playerCommands on the page URL', async () => {
  const roomManager = manager();
  await connected(roomManager, 1);
  roomManager.reportPlayerEvent(1, {
    action: 'pause',
    source: { ...source, pageUrl: 'https://frame.example/embed' },
    position: 21,
    status: 'paused',
  }, source.pageUrl);
  await waitFor(() => sent('playerCommand').length === 1, 'playerCommand not sent');
  const payload = sent('playerCommand')[0].payload!;
  assert.equal(payload.action, 'pause');
  assert.equal(payload.position, 21);
  assert.equal((payload.source as { pageUrl: string }).pageUrl, source.pageUrl);
  assert.equal(typeof payload.commandId, 'string');
});

test('joiners never send heartbeats or source replacements', async () => {
  const roomManager = manager();
  await connected(roomManager, 2);
  roomManager.reportPlayerEvent(2, { action: 'replace', source, position: 0, status: 'loading' });
  roomManager.reportPlayerEvent(2, { action: 'buffering', source, position: 3, status: 'buffering' });
  roomManager.reportPlayerHeartbeat(2, { source, position: 3, status: 'playing' });
  roomManager.requestState(2);
  await waitFor(() => sent('stateRequest').length >= 2, 'marker request not sent');
  assert.equal(sent('playerCommand').length, 0);
  assert.equal(sent('playerHeartbeat').length, 0);
});

test('host status events become heartbeats on the last seen revision', async () => {
  const roomManager = manager();
  const { cb, socket } = await connected(roomManager, 3, 'host-token');
  socket.send(JSON.stringify({
    type: 'playerState',
    payload: { revision: 4, source, position: 10, status: 'paused', originConnectionId: 'guest' },
    timestamp: Date.now(),
  }));
  await waitFor(() => cb.states.length === 1, 'state not delivered');
  roomManager.reportPlayerEvent(3, { action: 'status', source, position: 11, status: 'playing' });
  await waitFor(() => sent('playerHeartbeat').length === 1, 'heartbeat not sent');
  assert.equal(sent('playerHeartbeat')[0].payload!.baseRevision, 4);
  assert.equal(sent('playerHeartbeat')[0].payload!.status, 'playing');
});

test('own commands update the revision without being applied again', async () => {
  const roomManager = manager();
  const { cb, socket } = await connected(roomManager, 4, 'host-token');
  socket.send(JSON.stringify({
    type: 'playerState',
    payload: { revision: 2, source, position: 5, status: 'playing', originConnectionId: 'me' },
    timestamp: Date.now(),
  }));
  roomManager.requestState(4); // round trip marker
  await waitFor(() => sent('stateRequest').length >= 2, 'marker not sent');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(cb.states.length, 0);
  roomManager.reportPlayerHeartbeat(4, { source, position: 6, status: 'playing' });
  await waitFor(() => sent('playerHeartbeat').length === 1, 'heartbeat not sent');
  assert.equal(sent('playerHeartbeat')[0].payload!.baseRevision, 2);
});

test('heartbeat refreshes at the same revision apply in timestamp order', async () => {
  const roomManager = manager();
  const { cb, socket } = await connected(roomManager, 5);
  const state = (position: number, timestamp: number, revision = 1) => socket.send(JSON.stringify({
    type: 'playerState',
    payload: { revision, source, position, status: 'playing', originConnectionId: 'host' },
    timestamp,
  }));
  state(10, 1000);
  state(15, 6000);
  state(12, 3000); // older refresh arriving late
  state(1, 9000, 0); // older revision
  state(20, 11000);
  await waitFor(() => cb.states.length === 3, 'refreshes not delivered');
  assert.deepEqual(cb.states.map((item) => item.state.position), [10, 15, 20]);
  assert.ok(cb.states.every((item) => item.cause === 'update'));
});

test('state timestamps are converted to the local clock', async () => {
  const roomManager = manager();
  const { cb, socket } = await connected(roomManager, 6);
  await waitFor(() => sent('clockPing').length >= 1, 'no clock ping on connect');
  const t0 = sent('clockPing')[0].payload!.t0 as number;
  // The server's clock runs a minute ahead of ours.
  socket.send(JSON.stringify({ type: 'clockPong', payload: { t0, serverTime: Date.now() + 60_000 }, timestamp: 0 }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  const serverStamp = Date.now() + 60_000;
  socket.send(JSON.stringify({
    type: 'stateResponse',
    payload: { revision: 3, source, position: 100, status: 'playing' },
    timestamp: serverStamp,
  }));
  await waitFor(() => cb.states.length === 1, 'stateResponse not delivered');
  const local = cb.states[0].state.timestamp;
  assert.equal(cb.states[0].cause, 'sync');
  assert.ok(Math.abs(local - (serverStamp - 60_000)) < 100, `converted ${local}`);
});

test('a controlDenied asks for state and marks the reply as a resync', async () => {
  const roomManager = manager();
  const { cb, socket } = await connected(roomManager, 7);
  const before = sent('stateRequest').length;
  socket.send(JSON.stringify({ type: 'controlDenied', payload: { reason: 'host-only room' }, timestamp: Date.now() }));
  await waitFor(() => sent('stateRequest').length > before, 'no stateRequest after denial');
  assert.deepEqual(cb.denials, ['host-only room']);
  socket.send(JSON.stringify({
    type: 'stateResponse',
    payload: { revision: 1, source, position: 4, status: 'paused' },
    timestamp: Date.now(),
  }));
  await waitFor(() => cb.states.length === 1, 'resync state not delivered');
  assert.equal(cb.states[0].cause, 'resync');
});

test('an unanswered clock ping closes the dead socket and reconnects', async () => {
  const roomManager = manager({ pongTimeoutMs: 30, clockIntervalMs: 10_000 });
  const { cb } = await connected(roomManager, 8);
  await waitFor(() => cb.connectionStates.includes('reconnecting'), 'dead socket not detected');
  await waitFor(() => serverSockets.length >= 2, 'did not reconnect');
  await waitFor(() => sent('stateRequest').length >= 2, 'replacement did not request state');
});

test('reconnecting to a room that no longer exists ends the session', async () => {
  const checked: string[] = [];
  const roomManager = manager({
    roomCheckAfterAttempts: 0,
    roomExists: async (roomId) => {
      checked.push(roomId);
      return false;
    },
  });
  const { cb, socket } = await connected(roomManager, 9);
  socket.terminate();
  await waitFor(() => cb.closed.length === 1, 'room-gone not reported');
  assert.deepEqual(cb.closed, ['room-gone']);
  assert.deepEqual(checked, ['room-9']);
  assert.equal(roomManager.getSession(9), undefined);
});

test('a room check that fails on the network keeps reconnecting', async () => {
  const roomManager = manager({
    roomCheckAfterAttempts: 0,
    roomExists: async () => {
      throw new Error('offline');
    },
  });
  const { cb, socket } = await connected(roomManager, 10);
  socket.terminate();
  await waitFor(() => serverSockets.length >= 2, 'did not reconnect');
  assert.deepEqual(cb.closed, []);
});

test('roomClosed is reported and ends the session', async () => {
  const roomManager = manager();
  const { cb, socket } = await connected(roomManager, 11);
  socket.send(JSON.stringify({ type: 'roomClosed', payload: { reason: 'host-left' }, timestamp: Date.now() }));
  await waitFor(() => cb.closed.length === 1, 'roomClosed not reported');
  assert.deepEqual(cb.closed, ['host-left']);
  assert.equal(roomManager.getSession(11), undefined);
});

test('explicit disconnect tells the server this is not a recoverable drop', async () => {
  const roomManager = manager();
  await connected(roomManager, 12, 'host-token');
  roomManager.disconnect(12, true);
  roomManager.disconnect(12); // idempotent
  await waitFor(() => sent('leaveRoom').length === 1, 'leaveRoom was not sent');
});
