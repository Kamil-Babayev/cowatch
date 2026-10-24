import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OverlayController,
  type CallState,
  type OverlayActions,
  type OverlayDeps,
  type OverlayView,
} from './overlay-controller.ts';
import type { JitsiEvent, JitsiHandle } from './jitsi.ts';
import type { ToBackgroundMessage } from '../shared/runtime-messages.ts';
import type { VideoTabStatus } from '../shared/video-frames.ts';

class FakeView implements OverlayView {
  readonly callSlot = {} as HTMLElement;
  participants = '';
  control = '';
  isHost: boolean | null = null;
  call: Array<{ state: CallState; message?: string }> = [];
  muted: Record<string, boolean> = {};
  toasts: string[] = [];
  picker: VideoTabStatus | null = null;
  ended: string | null = null;
  destroyed = false;

  setParticipants(text: string) {
    this.participants = text;
  }
  setControl(text: string, isHost: boolean | null) {
    this.control = text;
    this.isHost = isHost;
  }
  setCall(state: CallState, message?: string) {
    this.call.push({ state, message });
  }
  setMuted(kind: 'audio' | 'video', muted: boolean) {
    this.muted[kind] = muted;
  }
  showToast(message: string) {
    this.toasts.push(message);
  }
  showPicker(status: VideoTabStatus) {
    this.picker = status;
  }
  hidePicker() {
    this.picker = null;
  }
  showEnded(message: string) {
    this.ended = message;
  }
  destroy() {
    this.destroyed = true;
  }
}

interface PendingCall {
  roomId: string;
  onEvent: (event: JitsiEvent) => void;
  resolve: (handle: JitsiHandle) => void;
  reject: (error: Error) => void;
  handle: JitsiHandle & { disposed: boolean; commands: string[] };
}

function setup(timing = { joinTimeoutMs: 1000, keepaliveMs: 1000 }) {
  const views: FakeView[] = [];
  const actions: OverlayActions[] = [];
  const sent: ToBackgroundMessage[] = [];
  const calls: PendingCall[] = [];
  const opened: string[] = [];
  const clipboard: string[] = [];
  let clipboardFails = false;
  const candidates: VideoTabStatus = { hasVideo: true, candidates: [], selected: null };
  const deps: OverlayDeps = {
    createView: (next) => {
      actions.push(next);
      const view = new FakeView();
      views.push(view);
      return view;
    },
    sendMessage: async (message) => {
      sent.push(message);
      if (message.kind === 'queryVideoCandidates') return candidates;
      if (message.kind === 'selectVideoCandidate' && message.selection.candidateId === 'gone') {
        throw new Error('The selected video is no longer available');
      }
      return undefined;
    },
    injectJitsi: (roomId, _slot, onEvent) => new Promise((resolve, reject) => {
      const handle = {
        disposed: false,
        commands: [] as string[],
        toggleAudio: () => handle.commands.push('audio'),
        toggleVideo: () => handle.commands.push('video'),
        dispose: () => {
          handle.disposed = true;
        },
      };
      calls.push({ roomId, onEvent, resolve, reject, handle });
    }),
    openCallWindow: (roomId) => opened.push(roomId),
    writeClipboard: async (text) => {
      if (clipboardFails) throw new Error('denied');
      clipboard.push(text);
    },
  };
  const controller = new OverlayController(deps, timing);
  return {
    controller,
    views,
    actions,
    sent,
    calls,
    opened,
    clipboard,
    candidates,
    failClipboard: () => {
      clipboardFails = true;
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function join(call: PendingCall): void {
  call.resolve(call.handle);
}

test('start asks the background whether the page is in a room', () => {
  const { controller, sent } = setup();
  controller.start();
  assert.deepEqual(sent, [{ kind: 'checkPendingJoin' }]);
});

test('a room opens one overlay and one call, and the call reports joining', async () => {
  const { controller, views, calls } = setup();
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  assert.equal(views.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(views[0].participants, '0 people');
  assert.equal(views[0].control, 'Connecting…');
  assert.deepEqual(views[0].muted, { audio: true, video: true });
  join(calls[0]);
  await flush();
  calls[0].onEvent({ type: 'joined' });
  calls[0].onEvent({ type: 'audioMuted', muted: false });
  assert.deepEqual(views[0].call.map((item) => item.state), ['connecting', 'joined']);
  assert.equal(views[0].muted.audio, false);
  assert.equal(controller.currentCallState, 'joined');
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
});

test('leaving while the call is still starting disposes it when it arrives', async () => {
  const { controller, views, actions, calls, sent } = setup();
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  actions[0].leave();
  assert.deepEqual(sent.at(-1), { kind: 'leaveRoom' });
  assert.equal(views[0].destroyed, true);
  join(calls[0]);
  await flush();
  assert.equal(calls[0].handle.disposed, true);
  // A later room on the same page still gets its overlay.
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r2' });
  assert.equal(views.length, 2);
  assert.equal(controller.currentRoomId, 'r2');
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
});

test('switching rooms replaces the overlay and the call', async () => {
  const { controller, views, calls } = setup();
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  join(calls[0]);
  await flush();
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r2' });
  assert.equal(views[0].destroyed, true);
  assert.equal(calls[0].handle.disposed, true);
  assert.equal(calls[1].roomId, 'r2');
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
});

test('a room ended elsewhere tears down the call and explains why', async () => {
  const { controller, views, calls } = setup();
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  join(calls[0]);
  await flush();
  controller.handleMessage({ kind: 'roomEnded', reason: 'host-left' });
  assert.equal(calls[0].handle.disposed, true);
  assert.equal(views[0].ended, 'The host ended this room');
  assert.equal(views[0].destroyed, false, 'the view removes itself after the notice');
  assert.equal(controller.currentRoomId, null);
  controller.handleMessage({ kind: 'roomEnded', reason: 'host-left' }); // already ended: no-op
});

test('call failures, timeouts and retries', async () => {
  const { controller, views, actions, calls, opened } = setup({ joinTimeoutMs: 20, keepaliveMs: 1000 });
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  calls[0].reject(new Error('JitsiMeetExternalAPI failed to load'));
  await flush();
  assert.deepEqual(views[0].call.at(-1), { state: 'failed', message: 'JitsiMeetExternalAPI failed to load' });

  actions[0].retryCall();
  join(calls[1]);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(views[0].call.at(-1), { state: 'failed', message: 'Video chat did not connect' });
  assert.equal(calls[1].handle.disposed, true);

  actions[0].retryCall();
  join(calls[2]);
  await flush();
  calls[2].onEvent({ type: 'error', message: 'conference.connectionError' });
  assert.deepEqual(views[0].call.at(-1), { state: 'failed', message: 'conference.connectionError' });

  actions[0].retryCall();
  join(calls[3]);
  await flush();
  calls[3].onEvent({ type: 'joined' });
  calls[3].onEvent({ type: 'left' });
  assert.deepEqual(views[0].call.at(-1), { state: 'failed', message: 'Video chat ended' });
  calls[2].onEvent({ type: 'joined' }); // a stale call's events are ignored
  assert.equal(views[0].call.at(-1)?.state, 'failed');

  actions[0].openCallWindow();
  assert.deepEqual(opened, ['r1']);
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
});

test('mic and camera go to the current call', async () => {
  const { controller, actions, calls } = setup();
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  actions[0].toggleMic(); // no call yet: ignored
  join(calls[0]);
  await flush();
  actions[0].toggleMic();
  actions[0].toggleCamera();
  calls[0].onEvent({ type: 'videoMuted', muted: false });
  assert.deepEqual(calls[0].handle.commands, ['audio', 'video']);
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
});

test('session and presence drive the status line and the hint for several videos', async () => {
  const { controller, views, candidates } = setup();
  controller.handleMessage({ kind: 'sessionInfo', payload: { connectionId: 'c', isHost: true, controlMode: 'open' } });
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  candidates.candidates = [{} as never, {} as never];
  controller.handleMessage({ kind: 'sessionInfo', payload: { connectionId: 'c', isHost: false, controlMode: 'host-only' } });
  controller.handleMessage({ kind: 'presenceUpdate', payload: { connections: [{ connId: 'a', isHost: true }, { connId: 'b', isHost: false }] } });
  await flush();
  assert.equal(views[0].participants, '2 people');
  assert.equal(views[0].control, 'Host controls playback');
  assert.equal(views[0].isHost, false);
  assert.match(views[0].toasts.at(-1) ?? '', /Several videos/);
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
});

test('status messages become toasts', async () => {
  const { controller, views, actions, clipboard, sent, failClipboard } = setup();
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  const view = views[0];
  controller.handleMessage({ kind: 'connectionState', state: 'connected' });
  controller.handleMessage({ kind: 'connectionState', state: 'reconnecting' });
  controller.handleMessage({ kind: 'connectionState', state: 'connecting' });
  controller.handleMessage({ kind: 'connectionState', state: 'connected' });
  controller.handleMessage({ kind: 'connectionState', state: 'error' });
  controller.handleMessage({ kind: 'controlDenied', reason: 'host-only' });
  controller.handleMessage({ kind: 'resynced' });
  controller.handleMessage({ kind: 'playbackApplyFailed' });
  controller.handleMessage({ kind: 'playerAdapterStatus', status: 'unsupported' });
  controller.handleMessage({ kind: 'playerAdapterStatus', status: 'error', message: 'Player broke' });
  controller.handleMessage({ kind: 'freshLinkError', message: 'Only the host can generate a new link' });
  actions[0].copyLink();
  assert.deepEqual(sent.at(-1), { kind: 'requestFreshLink' });
  controller.handleMessage({ kind: 'freshLinkResult', joinUrl: 'http://x/join' });
  await flush();
  failClipboard();
  controller.handleMessage({ kind: 'freshLinkResult', joinUrl: 'http://x/join2' });
  await flush();
  assert.deepEqual(clipboard, ['http://x/join']);
  assert.deepEqual(view.toasts, [
    'Connection lost — reconnecting…',
    'Connection restored',
    'Room connection failed',
    'The host controls playback — resyncing…',
    'Back in sync with the host',
    'Playback was blocked — press play once on this page',
    'Player status: unsupported',
    'Player broke',
    'Only the host can generate a new link',
    'Invite link copied',
    'Link created, but the clipboard was not available',
  ]);
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
});

test('the video picker lists candidates and forwards the choice', async () => {
  const { controller, views, actions, sent } = setup();
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  actions[0].openPicker();
  await flush();
  assert.notEqual(views[0].picker, null);
  actions[0].selectVideo({ frameId: 0, candidateId: 'v1' });
  await flush();
  assert.equal(views[0].picker, null);
  assert.deepEqual(sent.at(-1), { kind: 'selectVideoCandidate', selection: { frameId: 0, candidateId: 'v1' } });
  actions[0].selectVideo({ frameId: 0, candidateId: 'gone' });
  await flush();
  assert.equal(views[0].toasts.at(-1), 'The selected video is no longer available');
  actions[0].autoSelectVideo();
  await flush();
  assert.deepEqual(sent.at(-1), { kind: 'clearVideoSelection' });
  assert.equal(views[0].toasts.at(-1), 'Choosing the video automatically');
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
});

test('keepalives run only while in a room', async () => {
  const { controller, sent } = setup({ joinTimeoutMs: 1000, keepaliveMs: 10 });
  controller.handleMessage({ kind: 'roomConnected', roomId: 'r1' });
  await new Promise((resolve) => setTimeout(resolve, 35));
  const during = sent.filter((message) => message.kind === 'keepalive').length;
  assert.ok(during >= 2);
  controller.handleMessage({ kind: 'roomEnded', reason: 'left' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sent.filter((message) => message.kind === 'keepalive').length, during);
});
