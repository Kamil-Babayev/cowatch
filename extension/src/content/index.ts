import { injectJitsi, type JitsiHandle } from './jitsi.ts';
import { setupFullscreenReparenting } from './overlay-fullscreen.ts';
import { formatRoomStatus } from './overlay-state.ts';
import overlayStyles from './overlay.css';
import type { ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';
import type { SessionPayload } from '../shared/messages.ts';
import type { VideoTabStatus } from '../shared/video-frames.ts';
import { debugLog } from '../shared/config.ts';

debugLog('top-frame coordinator loaded', { pageUrl: window.location.href });

interface Overlay {
  hostEl: HTMLElement;
  jitsiSlot: HTMLElement;
  micBtn: HTMLButtonElement;
  cameraBtn: HTMLButtonElement;
  copyLinkBtn: HTMLButtonElement;
  persistentStatusEl: HTMLElement;
  transientStatusEl: HTMLElement;
  selectorEl: HTMLElement;
  stopFullscreenReparenting: () => void;
}

let overlay: Overlay | null = null;
let jitsiHandle: JitsiHandle | null = null;
let jitsiInjecting = false;
let sessionInfo: SessionPayload | null = null;
let participantCount = 0;
let currentRoomId: string | null = null;

function setTransientMessage(message: string, durationMs = 3000): void {
  if (!overlay) return;
  overlay.transientStatusEl.textContent = message;
  setTimeout(() => {
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

function teardownOverlay(): void {
  jitsiHandle?.dispose();
  jitsiHandle = null;
  overlay?.stopFullscreenReparenting();
  overlay?.hostEl.remove();
  overlay = null;
  sessionInfo = null;
  currentRoomId = null;
}

async function showVideoSelector(): Promise<void> {
  if (!overlay) return;
  const status = await browser.runtime.sendMessage({
    kind: 'queryVideoCandidates',
  } satisfies ToBackgroundMessage) as VideoTabStatus;

  overlay.selectorEl.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = status.candidates.length
    ? 'Choose the video to synchronize'
    : 'No videos found';
  overlay.selectorEl.appendChild(title);

  status.candidates.forEach((candidate, index) => {
    const button = document.createElement('button');
    button.className = 'cowatch-btn';
    const location = candidate.frameId === 0 ? 'page' : 'embedded player';
    button.textContent =
      `${index + 1} · ${Math.round(candidate.width)}×${Math.round(candidate.height)} · ${location}`;
    button.addEventListener('click', async () => {
      await browser.runtime.sendMessage({
        kind: 'selectVideoCandidate',
        selection: {
          frameId: candidate.frameId,
          candidateId: candidate.candidateId,
          documentId: candidate.documentId,
        },
      } satisfies ToBackgroundMessage);
      if (overlay) overlay.selectorEl.hidden = true;
      setTransientMessage(`Video ${index + 1} selected`);
    });
    overlay!.selectorEl.appendChild(button);
  });

  const auto = document.createElement('button');
  auto.className = 'cowatch-btn';
  auto.textContent = 'Use automatic selection';
  auto.addEventListener('click', async () => {
    await browser.runtime.sendMessage({
      kind: 'clearVideoSelection',
    } satisfies ToBackgroundMessage);
    if (overlay) overlay.selectorEl.hidden = true;
    setTransientMessage('Automatic video selection restored');
  });
  overlay.selectorEl.appendChild(auto);
  overlay.selectorEl.hidden = false;
}

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
  micBtn.disabled = true;

  const cameraBtn = document.createElement('button');
  cameraBtn.className = 'cowatch-btn';
  cameraBtn.textContent = 'Camera';
  cameraBtn.disabled = true;

  const selectVideoBtn = document.createElement('button');
  selectVideoBtn.className = 'cowatch-btn';
  selectVideoBtn.textContent = 'Select Video';
  selectVideoBtn.addEventListener('click', () => {
    void showVideoSelector().catch((err) => {
      setTransientMessage(`Could not inspect videos: ${(err as Error).message}`);
    });
  });

  const copyLinkBtn = document.createElement('button');
  copyLinkBtn.className = 'cowatch-btn';
  copyLinkBtn.textContent = 'Copy Link';
  copyLinkBtn.addEventListener('click', () => {
    void browser.runtime.sendMessage({
      kind: 'requestFreshLink',
    } satisfies ToBackgroundMessage);
  });

  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'cowatch-btn cowatch-btn-danger';
  leaveBtn.textContent = 'Leave';
  leaveBtn.addEventListener('click', () => {
    void browser.runtime.sendMessage({ kind: 'leaveRoom' } satisfies ToBackgroundMessage);
    teardownOverlay();
  });

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

  return {
    hostEl: host,
    jitsiSlot,
    micBtn,
    cameraBtn,
    copyLinkBtn,
    persistentStatusEl,
    transientStatusEl,
    selectorEl,
    stopFullscreenReparenting: setupFullscreenReparenting(host, document.body),
  };
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
  const msg = message as ToContentMessage;
  switch (msg.kind) {
    case 'playbackApplyFailed':
      setTransientMessage('Playback was blocked — press play once on this page');
      return;
    case 'authoritativeState':
      if (msg.source === 'control-denied' && overlay) {
        overlay.transientStatusEl.textContent = '';
      }
      return;
    case 'controlDenied':
      if (overlay) overlay.transientStatusEl.textContent = 'Host controls playback — resyncing…';
      return;
    case 'presenceUpdate':
      participantCount = msg.payload.connections.length;
      renderPersistentStatus();
      return;
    case 'sessionInfo':
      sessionInfo = msg.payload;
      renderPersistentStatus();
      void browser.runtime.sendMessage({
        kind: 'queryVideoCandidates',
      } satisfies ToBackgroundMessage).then((result) => {
        if ((result as VideoTabStatus).candidates.length > 1) {
          setTransientMessage('Multiple videos found — use Select Video if sync is wrong', 6000);
        }
      });
      return;
    case 'connectionState':
      if (msg.state === 'reconnecting') {
        setTransientMessage('Room connection lost — reconnecting…', 10_000);
      } else if (msg.state === 'connected') {
        if (overlay?.transientStatusEl.textContent.includes('reconnecting')) {
          setTransientMessage('Room connection restored');
        }
      } else if (msg.state === 'error' || msg.state === 'disconnected') {
        setTransientMessage(
          msg.state === 'error' ? 'Room connection failed' : 'Room disconnected',
          10_000,
        );
      }
      return;
    case 'playerAdapterStatus':
      setTransientMessage(msg.message ?? `Player status: ${msg.status}`, 10_000);
      return;
    case 'roomClosed':
      setTransientMessage(
        msg.reason === 'host-left' ? 'The host ended this room' : 'The server closed this room',
        10_000,
      );
      return;
    case 'roomConnected':
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

void browser.runtime.sendMessage({
  kind: 'checkPendingJoin',
} satisfies ToBackgroundMessage);
