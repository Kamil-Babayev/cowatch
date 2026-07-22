import { VideoDetector } from './video-detector.ts';
import { attachPlaybackListeners, type PlaybackEvent } from './playback-events.ts';
import { injectJitsi, type JitsiHandle } from './jitsi.ts';
import { setupFullscreenReparenting } from './overlay-fullscreen.ts';
import overlayStyles from './overlay.css';
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

// --- US-3.2: in-page overlay -----------------------------------------
//
// Shadow DOM (so the host site's CSS can't clobber it, and so ours can't
// leak out either). Replaces US-2.14's bare #cowatch-jitsi-controls div
// entirely — that element never existed independently of this one.

interface Overlay {
  hostEl: HTMLElement;
  jitsiSlot: HTMLElement;
  micBtn: HTMLButtonElement;
  cameraBtn: HTMLButtonElement;
  copyLinkBtn: HTMLButtonElement;
  leaveBtn: HTMLButtonElement;
  statusEl: HTMLElement;
  stopFullscreenReparenting: () => void;
}

let overlay: Overlay | null = null;

function createOverlay(): Overlay {
  const host = document.createElement('div');
  host.id = 'cowatch-overlay-host';
  document.body.appendChild(host);

  const shadowRoot = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = overlayStyles;
  shadowRoot.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'cowatch-bar';

  const jitsiSlot = document.createElement('div');
  jitsiSlot.className = 'cowatch-jitsi-slot';

  const controls = document.createElement('div');
  controls.className = 'cowatch-controls';

  const micBtn = document.createElement('button');
  micBtn.className = 'cowatch-btn';
  micBtn.textContent = 'Mic';
  micBtn.disabled = true; // enabled once Jitsi actually injects — see roomConnected handler

  const cameraBtn = document.createElement('button');
  cameraBtn.className = 'cowatch-btn';
  cameraBtn.textContent = 'Camera';
  cameraBtn.disabled = true;

  const copyLinkBtn = document.createElement('button');
  copyLinkBtn.className = 'cowatch-btn';
  copyLinkBtn.textContent = 'Copy Link';
  copyLinkBtn.addEventListener('click', () => {
    const msg: ToBackgroundMessage = { kind: 'requestFreshLink' };
    browser.runtime.sendMessage(msg);
  });

  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'cowatch-btn cowatch-btn-danger';
  leaveBtn.textContent = 'Leave';
  leaveBtn.addEventListener('click', () => {
    const msg: ToBackgroundMessage = { kind: 'leaveRoom' };
    browser.runtime.sendMessage(msg);
    teardownOverlay();
  });

  const statusEl = document.createElement('div');
  statusEl.className = 'cowatch-status'; // US-3.4 renders "who has control" / controlDenied here

  controls.append(micBtn, cameraBtn, copyLinkBtn, leaveBtn);
  bar.append(jitsiSlot, controls, statusEl);
  shadowRoot.appendChild(bar);

  // US-3.3: keeps the bar visible when the page (or the video itself)
  // goes fullscreen — anything not inside the fullscreen element stops
  // rendering entirely otherwise, since real Firefox fullscreen behaves
  // this way regardless of z-index.
  const stopFullscreenReparenting = setupFullscreenReparenting(host, document.body);

  return { hostEl: host, jitsiSlot, micBtn, cameraBtn, copyLinkBtn, leaveBtn, statusEl, stopFullscreenReparenting };
}

function teardownOverlay(): void {
  jitsiHandle?.dispose();
  jitsiHandle = null;
  overlay?.stopFullscreenReparenting();
  overlay?.hostEl.remove();
  overlay = null;
}

function setStatusMessage(message: string, durationMs = 3000): void {
  if (!overlay) return;
  overlay.statusEl.textContent = message;
  setTimeout(() => {
    // Only clear if nothing newer has overwritten it in the meantime.
    if (overlay?.statusEl.textContent === message) overlay.statusEl.textContent = '';
  }, durationMs);
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
      // US-3.4 adds the local re-sync fix + a proper persistent
      // indicator; for now, at least visible in the overlay rather than
      // console-only.
      setStatusMessage(`Denied: ${msg.reason}`);
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
        overlay = createOverlay();
        injectJitsi(msg.roomId, overlay.jitsiSlot)
          .then((handle) => {
            jitsiHandle = handle;
            if (overlay) {
              overlay.micBtn.disabled = false;
              overlay.cameraBtn.disabled = false;
              overlay.micBtn.addEventListener('click', () => handle.toggleAudio());
              overlay.cameraBtn.addEventListener('click', () => handle.toggleVideo());
            }
          })
          .catch((err) => {
            console.error('[CoWatch] Jitsi injection failed:', err);
            setStatusMessage('Video chat unavailable', 10_000);
          })
          .finally(() => {
            jitsiInjecting = false;
          });
      }
      return;

    case 'freshLinkResult':
      navigator.clipboard
        .writeText(msg.joinUrl)
        .then(() => setStatusMessage('Link copied'))
        .catch(() => setStatusMessage('Copied, but clipboard write failed'));
      return;

    case 'freshLinkError':
      setStatusMessage(msg.message);
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
