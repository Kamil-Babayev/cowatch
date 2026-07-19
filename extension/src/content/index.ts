import { VideoDetector } from './video-detector.ts';
import { attachPlaybackListeners, type PlaybackEvent } from './playback-events.ts';
import { injectJitsi, type JitsiHandle } from './jitsi.ts';
import type { ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';

console.log('[CoWatch] content script loaded on', window.location.href);

let detachPlaybackListeners: (() => void) | null = null;
let jitsiHandle: JitsiHandle | null = null;
let jitsiInjecting = false; // guards against double-injection if roomConnected somehow fires twice
let applyingRemoteEvent = false; // feedback-loop guard — see onLocalPlaybackEvent

const detector = new VideoDetector(document);

function onLocalPlaybackEvent(event: PlaybackEvent): void {
  // An event applied *from* the network (see handleRemoteEvent) must not
  // be re-broadcast as if the user caused it locally — without this guard
  // every remote update would immediately echo back out again.
  if (applyingRemoteEvent) return;
  const msg: ToBackgroundMessage = { kind: 'localPlaybackEvent', event };
  browser.runtime.sendMessage(msg);
}

function attachToVideo(video: HTMLVideoElement | null): void {
  detachPlaybackListeners?.();
  detachPlaybackListeners = null;
  if (!video) return;
  detachPlaybackListeners = attachPlaybackListeners(video, onLocalPlaybackEvent);
}

detector.onChange(attachToVideo);
attachToVideo(detector.getCurrent());

function handleRemoteEvent(event: PlaybackEvent): void {
  const video = detector.getCurrent();
  if (!video) return;

  applyingRemoteEvent = true;
  try {
    video.currentTime = event.currentTime;
    if (event.isPlaying && video.paused) {
      void video.play();
    } else if (!event.isPlaying && !video.paused) {
      video.pause();
    }
  } finally {
    // Cleared on a delay, not synchronously: setting currentTime and
    // calling play()/pause() fires this tab's own play/pause/seeked
    // listeners asynchronously, not before this function returns —
    // clearing the flag too early would let those synthetic events slip
    // past the guard in onLocalPlaybackEvent.
    setTimeout(() => {
      applyingRemoteEvent = false;
    }, 0);
  }
}

function renderBareJitsiControls(handle: JitsiHandle): void {
  const container = document.createElement('div');
  container.id = 'cowatch-jitsi-controls';

  const muteBtn = document.createElement('button');
  muteBtn.textContent = 'Toggle Mic';
  muteBtn.addEventListener('click', () => handle.toggleAudio());

  const cameraBtn = document.createElement('button');
  cameraBtn.textContent = 'Toggle Camera';
  cameraBtn.addEventListener('click', () => handle.toggleVideo());

  container.append(muteBtn, cameraBtn);
  document.body.appendChild(container);
  // Deliberately unstyled per US-2.14's own scope — Epic 3's US-3.2
  // replaces this whole element with the real shadow-DOM overlay bar.
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as ToContentMessage;
  switch (msg.kind) {
    case 'remotePlaybackEvent':
      handleRemoteEvent(msg.event);
      return;

    case 'joinSeek': {
      // US-2.8: a one-time correction right after joining, distinct from
      // the ongoing remotePlaybackEvent stream.
      const video = detector.getCurrent();
      if (video) video.currentTime = msg.targetSeconds;
      return;
    }

    case 'controlDenied':
      // Epic 3 (US-3.4) renders this properly; for now, at least visible
      // in the console rather than silently swallowed.
      console.log('[CoWatch] control denied:', msg.reason);
      return;

    case 'presenceUpdate':
      console.log('[CoWatch] presence:', msg.payload.connections);
      return;

    case 'roomConnected':
      // Fires once per connection, on both the host path and the joiner
      // path — see runtime-messages.ts for why content/index.ts can't
      // determine its own roomId any other way.
      if (!jitsiHandle && !jitsiInjecting) {
        jitsiInjecting = true;
        injectJitsi(msg.roomId)
          .then((handle) => {
            jitsiHandle = handle;
            renderBareJitsiControls(handle);
          })
          .catch((err) => {
            console.error('[CoWatch] Jitsi injection failed:', err);
          })
          .finally(() => {
            jitsiInjecting = false;
          });
      }
      return;
  }
});

// US-2.11: on every page load, ask background whether this tab was just
// navigated here as part of a join handoff (see message-router.ts for why
// this has to be a round-trip rather than something this script can
// determine on its own).
browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as ToContentMessage;
  if (msg.kind === 'pendingJoinResult' && msg.roomId) {
    const connectMsg: ToBackgroundMessage = { kind: 'connectRoom', roomId: msg.roomId };
    browser.runtime.sendMessage(connectMsg);
  }
});
browser.runtime.sendMessage({ kind: 'checkPendingJoin' } satisfies ToBackgroundMessage);
