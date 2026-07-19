import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket as WSConnection } from 'ws';
import type { connectToRoom as ConnectToRoomFn } from './ws-client.ts';

let wss: WebSocketServer;
let serverURL: string;
let connectToRoom: typeof ConnectToRoomFn;
let lastServerReceived: unknown[] = [];
let lastServerConnectionURL: string | undefined;

before(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  serverURL = `http://localhost:${port}`;

  wss.on('connection', (socket: WSConnection, req) => {
    lastServerConnectionURL = req.url;
    socket.send(
      JSON.stringify({
        type: 'presence',
        payload: { connections: [{ connId: 'host-1', isHost: true }] },
        timestamp: Date.now(),
      }),
    );
    socket.on('message', (data) => {
      lastServerReceived.push(JSON.parse(data.toString()));
    });
  });

  // __SERVER_BASE_URL__ is normally injected by esbuild's `define` at
  // bundle time (see build.mjs) — running source directly via Node's
  // --experimental-strip-types skips that step entirely, so tests have to
  // set the global themselves before importing anything that reads it.
  // A dynamic import (not a static one) is required here: static imports
  // resolve before this file's own body runs, which would read the global
  // before it's set.
  (globalThis as unknown as { __SERVER_BASE_URL__: string }).__SERVER_BASE_URL__ = serverURL;
  const mod = await import('./ws-client.ts');
  connectToRoom = mod.connectToRoom;
});

after(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test('connectToRoom hits the correct path', async () => {
  lastServerConnectionURL = undefined;
  const conn = connectToRoom('room-abc');
  await new Promise((resolve) => conn.socket.addEventListener('open', resolve));
  conn.close();
  assert.equal(lastServerConnectionURL, '/rooms/room-abc/connect');
});

test('connectToRoom appends hostToken as a query param when provided', async () => {
  lastServerConnectionURL = undefined;
  const conn = connectToRoom('room-xyz', 'secret-token');
  await new Promise((resolve) => conn.socket.addEventListener('open', resolve));
  conn.close();
  assert.equal(lastServerConnectionURL, '/rooms/room-xyz/connect?hostToken=secret-token');
});

test('onMessage receives the parsed presence payload', async () => {
  const received: unknown[] = [];
  const conn = connectToRoom('room-presence', undefined, (msg) => received.push(msg));
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the server's send land
  conn.close();

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    type: 'presence',
    payload: { connections: [{ connId: 'host-1', isHost: true }] },
    // timestamp is real Date.now() from the mock server — not asserted exactly
    timestamp: (received[0] as { timestamp: number }).timestamp,
  });
});

test('sending a message from the client is received correctly by the server', async () => {
  lastServerReceived = [];
  const conn = connectToRoom('room-send');
  await new Promise((resolve) => conn.socket.addEventListener('open', resolve));

  conn.socket.send(
    JSON.stringify({ type: 'play', payload: { currentTime: 10, isPlaying: true }, timestamp: Date.now() }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  conn.close();

  assert.equal(lastServerReceived.length, 1);
  assert.equal((lastServerReceived[0] as { type: string }).type, 'play');
});
