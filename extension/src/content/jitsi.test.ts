import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { injectJitsi, jitsiRoomName, jitsiRoomUrl, type JitsiEvent } from './jitsi.ts';

const originalWindow = globalThis.window;
const originalCrypto = globalThis.crypto;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: originalCrypto });
});

function installFakeAPI() {
  const record = {
    commands: [] as string[],
    listeners: new Map<string, (payload: unknown) => void>(),
    disposed: false,
    domain: '',
    options: {} as Record<string, unknown>,
  };
  class FakeExternalAPI {
    constructor(domain: string, options: Record<string, unknown>) {
      record.domain = domain;
      record.options = options;
    }

    executeCommand(command: string): void {
      record.commands.push(command);
    }

    addListener(event: string, listener: (payload: unknown) => void): void {
      record.listeners.set(event, listener);
    }

    dispose(): void {
      record.disposed = true;
    }
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { JitsiMeetExternalAPI: FakeExternalAPI },
  });
  return record;
}

test('injectJitsi starts a muted call without the pre-join screen', async () => {
  const api = installFakeAPI();
  const parent = {} as HTMLElement;
  const handle = await injectJitsi('room-1', parent, () => undefined, 'Host');
  handle.toggleAudio();
  handle.toggleVideo();
  handle.dispose();

  assert.equal(api.domain, 'meet.jit.si');
  assert.equal(api.options.parentNode, parent);
  assert.match(api.options.roomName as string, /^[a-f0-9]{32}$/);
  assert.deepEqual(api.options.userInfo, { displayName: 'Host' });
  const config = api.options.configOverwrite as Record<string, unknown>;
  assert.deepEqual(config.prejoinConfig, { enabled: false });
  assert.equal(config.startWithAudioMuted, true);
  assert.deepEqual(api.commands, ['toggleAudio', 'toggleVideo']);
  assert.equal(api.disposed, true);
});

test('injectJitsi translates Jitsi events', async () => {
  const api = installFakeAPI();
  const events: JitsiEvent[] = [];
  await injectJitsi('room-1', {} as HTMLElement, (event) => events.push(event));
  api.listeners.get('videoConferenceJoined')!({});
  api.listeners.get('audioMuteStatusChanged')!({ muted: false });
  api.listeners.get('videoMuteStatusChanged')!({ muted: true });
  api.listeners.get('errorOccurred')!({ error: { name: 'conference.connectionError' } });
  api.listeners.get('errorOccurred')!(undefined);
  api.listeners.get('readyToClose')!({});
  api.listeners.get('videoConferenceLeft')!({});
  assert.deepEqual(events, [
    { type: 'joined' },
    { type: 'audioMuted', muted: false },
    { type: 'videoMuted', muted: true },
    { type: 'error', message: 'conference.connectionError' },
    { type: 'error', message: 'Video chat error' },
    { type: 'left' },
    { type: 'left' },
  ]);
});

test('injectJitsi reports a missing packaged API', async () => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  await assert.rejects(injectJitsi('room-2', {} as HTMLElement, () => undefined), /JitsiMeetExternalAPI failed to load/);
});

test('room names are stable, unlinkable, and work without crypto.subtle', async () => {
  const hashed = await jitsiRoomName('room-3');
  assert.equal(await jitsiRoomName('room-3'), hashed);
  assert.notEqual(await jitsiRoomName('room-4'), hashed);
  assert.equal(await jitsiRoomUrl('room-3'), `https://meet.jit.si/${hashed}`);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  const fallback = await jitsiRoomName('room-3');
  assert.match(fallback, /^[a-f0-9]{32}$/);
  assert.equal(await jitsiRoomName('room-3'), fallback);
});
