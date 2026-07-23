import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { injectJitsi } from './jitsi.ts';

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

test('injectJitsi creates a configured call and delegates controls', async () => {
  const commands: string[] = [];
  let disposed = false;
  let receivedDomain = '';
  let receivedOptions: Record<string, unknown> = {};

  class FakeExternalAPI {
    constructor(domain: string, options: Record<string, unknown>) {
      receivedDomain = domain;
      receivedOptions = options;
    }

    executeCommand(command: string): void {
      commands.push(command);
    }

    dispose(): void {
      disposed = true;
    }
  }

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { JitsiMeetExternalAPI: FakeExternalAPI },
  });
  const parent = {} as HTMLElement;
  const handle = await injectJitsi('room-1', parent);

  handle.toggleAudio();
  handle.toggleVideo();
  handle.dispose();

  assert.equal(receivedDomain, 'meet.jit.si');
  assert.equal(receivedOptions.parentNode, parent);
  assert.match(receivedOptions.roomName as string, /^[a-f0-9]{32}$/);
  assert.deepEqual(commands, ['toggleAudio', 'toggleVideo']);
  assert.equal(disposed, true);
});

test('injectJitsi reports a missing packaged API', async () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  });

  await assert.rejects(
    injectJitsi('room-2', {} as HTMLElement),
    /JitsiMeetExternalAPI failed to load/,
  );
});
