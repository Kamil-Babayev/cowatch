import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { createRoom as CreateRoomFn, mintFreshLink as MintFreshLinkFn } from './api-client.ts';

let createRoom: typeof CreateRoomFn;
let mintFreshLink: typeof MintFreshLinkFn;
let lastRequest: { url: string; init?: RequestInit } | null = null;
let mockResponse: { ok: boolean; status: number; body: unknown } = { ok: true, status: 200, body: {} };

before(async () => {
  (globalThis as unknown as { __SERVER_BASE_URL__: string }).__SERVER_BASE_URL__ = 'http://localhost:9000';
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (
    url: string,
    init?: RequestInit,
  ) => {
    lastRequest = { url, init };
    return {
      ok: mockResponse.ok,
      status: mockResponse.status,
      json: async () => mockResponse.body,
    } as Response;
  }) as typeof fetch;

  const mod = await import('./api-client.ts');
  createRoom = mod.createRoom;
  mintFreshLink = mod.mintFreshLink;
});

test('createRoom posts to /rooms with the right body', async () => {
  mockResponse = {
    ok: true,
    status: 201,
    body: { roomId: 'r1', joinToken: 't1', joinUrl: 'http://x/join-page/?token=t1', hostToken: 'h1' },
  };

  const result = await createRoom('https://example.com/watch', 'open');

  assert.equal(lastRequest?.url, 'http://localhost:9000/rooms');
  assert.equal(lastRequest?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(lastRequest?.init?.body as string), {
    videoUrl: 'https://example.com/watch',
    controlMode: 'open',
  });
  assert.deepEqual(result, {
    roomId: 'r1',
    joinToken: 't1',
    joinUrl: 'http://x/join-page/?token=t1',
    hostToken: 'h1',
  });
});

test('createRoom throws with the server-provided error message on failure', async () => {
  mockResponse = { ok: false, status: 400, body: { error: 'videoUrl must be a valid http(s) URL' } };

  await assert.rejects(
    () => createRoom('not-a-url', 'open'),
    /videoUrl must be a valid http\(s\) URL/,
  );
});

test('mintFreshLink sends the hostToken as a Bearer header', async () => {
  mockResponse = { ok: true, status: 201, body: { joinToken: 't2', joinUrl: 'http://x/join-page/?token=t2' } };

  const result = await mintFreshLink('room-1', 'secret-host-token');

  assert.equal(lastRequest?.url, 'http://localhost:9000/rooms/room-1/tokens');
  assert.equal((lastRequest?.init?.headers as Record<string, string>)?.Authorization, 'Bearer secret-host-token');
  assert.deepEqual(result, { joinToken: 't2', joinUrl: 'http://x/join-page/?token=t2' });
});

test('mintFreshLink throws on a non-ok response', async () => {
  mockResponse = { ok: false, status: 401, body: {} };
  await assert.rejects(() => mintFreshLink('room-1', 'wrong-token'), /401/);
});
