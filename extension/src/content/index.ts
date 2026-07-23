import { VideoDetector } from './video-detector.ts';
import { attachPlaybackListeners, type PlaybackEvent } from './playback-events.ts';
import { injectJitsi, type JitsiHandle } from './jitsi.ts';
import { setupFullscreenReparenting } from './overlay-fullscreen.ts';
import {
  applyPlaybackState,
  correctionForHeartbeat,
  correctedPlaybackState,
} from './playback-sync.ts';
import { formatRoomStatus } from './overlay-state.ts';
import overlayStyles from './overlay.css';
import type { ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';
import type { PlaybackPayload, SessionPayload } from '../shared/messages.ts';

console.log('[CoWatch] content script loaded on', window.location.href);

let detachPlaybackListeners: (() => void) | null = null;
let jitsiHandle: JitsiHandle | null = null;
let jitsiInjecting = false; // guards against double-injection if roomConnected somehow fires twice
let applyingRemoteEvent = false; // feedback-loop guard — see onLocalPlaybackEvent
let remoteApplyGeneration = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sessionInfo: SessionPayload | null = null;
let participantCount = 0;
let currentRoomId: string | null = null;
let selectorMarkers: HTMLElement[] = [];

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

async function handleRemoteState(state: PlaybackPayload): Promise<void> {
  const video = detector.getCurrent();
  if (!video) return;

  const generation = ++remoteApplyGeneration;
  applyingRemoteEvent = true;
  try {
    await applyPlaybackState(video, state);
  } catch {
    setTransientMessage('Playback was blocked — press play once on this page');
  } finally {
    // Cleared on a delay, not synchronously: setting currentTime and
    // calling play()/pause() fires this tab's own play/pause/seeked
    // listeners asynchronously, not before this function returns —
    // clearing the flag too early would let those synthetic events slip
    // past the guard in onLocalPlaybackEvent.
    setTimeout(() => {
      if (generation === remoteApplyGeneration) applyingRemoteEvent = false;
    }, 0);
  }
}

function handleRemoteEvent(event: PlaybackEvent): void {
  void handleRemoteState({
    currentTime: event.currentTime,
    isPlaying: event.isPlaying,
  });
}

function sendHeartbeat(): void {
  if (!sessionInfo?.isHost) return;
  const video = detector.getCurrent();
  if (!video) return;
  const msg: ToBackgroundMessage = {
    kind: 'playbackHeartbeat',
    state: { currentTime: video.currentTime, isPlaying: !video.paused },
  };
  void browser.runtime.sendMessage(msg);
}

function restartHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (!sessionInfo?.isHost) return;
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 5000);
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
  selectVideoBtn: HTMLButtonElement;
  persistentStatusEl: HTMLElement;
  transientStatusEl: HTMLElement;
  selectorEl: HTMLElement;
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

  const selectVideoBtn = document.createElement('button');
  selectVideoBtn.className = 'cowatch-btn';
  selectVideoBtn.textContent = 'Select Video';
  selectVideoBtn.addEventListener('click', showVideoSelector);

  const persistentStatusEl = document.createElement('div');
  persistentStatusEl.className = 'cowatch-status cowatch-status-persistent';

  const transientStatusEl = document.createElement('div');
  transientStatusEl.className = 'cowatch-status cowatch-status-transient';
  transientStatusEl.setAttribute('role', 'status');
  transientStatusEl.setAttribute('aria-live', 'polite');

  const selectorEl = document.createElement('div');
  selectorEl.className = 'cowatch-selector';
  selectorEl.hidden = true;

  controls.append(micBtn, cameraBtn, selectVideoBtn, copyLinkBtn, leaveBtn);
  bar.append(jitsiSlot, controls, persistentStatusEl, transientStatusEl);
  shadowRoot.append(bar, selectorEl);

  // US-3.3: keeps the bar visible when the page (or the video itself)
  // goes fullscreen — anything not inside the fullscreen element stops
  // rendering entirely otherwise, since real Firefox fullscreen behaves
  // this way regardless of z-index.
  const stopFullscreenReparenting = setupFullscreenReparenting(host, document.body);

  return {
    hostEl: host,
    jitsiSlot,
    micBtn,
    cameraBtn,
    copyLinkBtn,
    leaveBtn,
    selectVideoBtn,
    persistentStatusEl,
    transientStatusEl,
    selectorEl,
    stopFullscreenReparenting,
  };
}

function teardownOverlay(): void {
  clearSelectorMarkers();
  jitsiHandle?.dispose();
  jitsiHandle = null;
  overlay?.stopFullscreenReparenting();
  overlay?.hostEl.remove();
  overlay = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  sessionInfo = null;
  currentRoomId = null;
}

function clearSelectorMarkers(): void {
  selectorMarkers.forEach((marker) => marker.remove());
  selectorMarkers = [];
}

function addSelectorMarker(video: HTMLVideoElement, index: number): void {
  const rect = video.getBoundingClientRect();
  const marker = document.createElement('div');
  marker.textContent = String(index + 1);
  marker.setAttribute('aria-hidden', 'true');
  Object.assign(marker.style, {
    position: 'fixed',
    left: `${Math.max(0, rect.left)}px`,
    top: `${Math.max(0, rect.top)}px`,
    width: `${Math.max(0, rect.width)}px`,
    height: `${Math.max(0, rect.height)}px`,
    boxSizing: 'border-box',
    border: '3px solid #f2a93b',
    color: '#171717',
    background: 'rgba(242, 169, 59, 0.9)',
    font: '700 16px/28px monospace',
    padding: '0 8px',
    pointerEvents: 'none',
    zIndex: '2147483646',
  });
  document.documentElement.appendChild(marker);
  selectorMarkers.push(marker);
}

function setTransientMessage(message: string, durationMs = 3000): void {
  if (!overlay) return;
  overlay.transientStatusEl.textContent = message;
  setTimeout(() => {
    // Only clear if nothing newer has overwritten it in the meantime.
    if (overlay?.transientStatusEl.textContent === message) {
      overlay.transientStatusEl.textContent = '';
    }
  }, durationMs);
}

function renderPersistentStatus(): void {
  if (!overlay) return;
  overlay.persistentStatusEl.textContent = formatRoomStatus(participantCount, sessionInfo);
  overlay.copyLinkBtn.hidden = sessionInfo?.isHost === false;
}

function showVideoSelector(): void {
  if (!overlay) return;
  const candidates = detector.listCandidates();
  clearSelectorMarkers();
  overlay.selectorEl.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = candidates.length ? 'Choose the video to synchronize' : 'No videos found';
  overlay.selectorEl.appendChild(title);
  candidates.forEach((video, index) => {
    addSelectorMarker(video, index);
    const rect = video.getBoundingClientRect();
    const button = document.createElement('button');
    button.className = 'cowatch-btn';
    button.textContent = `${index + 1} · ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    button.addEventListener('click', () => {
      detector.selectOverride(video);
      clearSelectorMarkers();
      overlay!.selectorEl.hidden = true;
      setTransientMessage(`Video ${index + 1} selected`);
    });
    overlay!.selectorEl.appendChild(button);
  });
  const auto = document.createElement('button');
  auto.className = 'cowatch-btn';
  auto.textContent = 'Use automatic selection';
  auto.addEventListener('click', () => {
    detector.clearOverride();
    clearSelectorMarkers();
    overlay!.selectorEl.hidden = true;
    setTransientMessage('Automatic video selection restored');
  });
  overlay.selectorEl.appendChild(auto);
  overlay.selectorEl.hidden = false;
}

function startJitsi(roomId: string): void {
  if (!overlay || jitsiInjecting || jitsiHandle) return;
  jitsiInjecting = true;
  overlay.jitsiSlot.textContent = 'Connecting video chat…';
  injectJitsi(roomId, overlay.jitsiSlot)
    .then((handle) => {
      jitsiHandle = handle;
      if (!overlay) return;
      overlay.micBtn.disabled = false;
      overlay.cameraBtn.disabled = false;
      overlay.micBtn.addEventListener('click', () => handle.toggleAudio());
      overlay.cameraBtn.addEventListener('click', () => handle.toggleVideo());
    })
    .catch((err) => {
      console.error('[CoWatch] Jitsi injection failed:', err);
      if (!overlay) return;
      overlay.jitsiSlot.replaceChildren();
      const message = document.createElement('span');
      message.textContent = 'Video chat unavailable';
      const retry = document.createElement('button');
      retry.className = 'cowatch-btn';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => startJitsi(roomId));
      overlay.jitsiSlot.append(message, retry);
    })
    .finally(() => {
      jitsiInjecting = false;
    });
}

browser.runtime.onMessage.addListener((message: unknown) => {
  if ((message as { kind?: string }).kind === 'videoStatusRequest') {
    return Promise.resolve({
      hasVideo: detector.getCurrent() !== null,
      candidateCount: detector.listCandidates().length,
    });
  }
  const msg = message as ToContentMessage;
  switch (msg.kind) {
    case 'remotePlaybackEvent':
      handleRemoteEvent(msg.event);
      return;

    case 'authoritativeState': {
      void handleRemoteState({
        currentTime: msg.currentTime,
        isPlaying: msg.isPlaying,
      }).then(() => {
        if (msg.source === 'control-denied' && overlay) {
          overlay.transientStatusEl.textContent = '';
        }
      });
      return;
    }

    case 'timeSync': {
      const video = detector.getCurrent();
      if (!video) return;
      const correction = correctionForHeartbeat(
        video.currentTime,
        msg.state,
        msg.timestamp,
      );
      if (correction) void handleRemoteState(correction);
      return;
    }

    case 'controlDenied':
      // US-3.4 adds the local re-sync fix + a proper persistent
      // indicator; for now, at least visible in the overlay rather than
      // console-only.
      if (overlay) {
        overlay.transientStatusEl.textContent =
          'Host controls playback — resyncing…';
      }
      return;

    case 'presenceUpdate':
      participantCount = msg.payload.connections.length;
      renderPersistentStatus();
      return;

    case 'sessionInfo':
      sessionInfo = msg.payload;
      restartHeartbeat();
      renderPersistentStatus();
      if (detector.listCandidates().length > 1) {
        setTransientMessage('Multiple videos found — use Select Video if sync is wrong', 6000);
      }
      return;

    case 'connectionState':
      if (msg.state === 'error' || msg.state === 'disconnected') {
        setTransientMessage(
          msg.state === 'error' ? 'Room connection failed' : 'Room disconnected',
          10_000,
        );
      }
      return;

    case 'roomClosed':
      setTransientMessage(
        msg.reason === 'host-left' ? 'The host ended this room' : 'The server closed this room',
        10_000,
      );
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      return;

    case 'roomConnected':
      // Fires once per connection, on both the host path and the joiner
      // path — see runtime-messages.ts for why content/index.ts can't
      // determine its own roomId any other way.
      if (!jitsiHandle && !jitsiInjecting) {
        currentRoomId = msg.roomId;
        overlay = createOverlay();
        renderPersistentStatus();
        startJitsi(msg.roomId);
      }
      return;

    case 'freshLinkResult':
      navigator.clipboard
        .writeText(msg.joinUrl)
        .then(() => setTransientMessage('Link copied'))
        .catch(() => setTransientMessage('Link generated, but clipboard access failed'));
      return;

    case 'freshLinkError':
      setTransientMessage(msg.message);
      return;
  }
});

// US-2.11: on every page load, ask background whether this tab was just
// navigated here as part of a join handoff (see message-router.ts for why
// this has to be a round-trip rather than something this script can
// determine on its own).
browser.runtime.sendMessage({ kind: 'checkPendingJoin' } satisfies ToBackgroundMessage);
