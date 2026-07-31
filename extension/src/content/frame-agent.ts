import { elementVisibleArea } from './video-detector.ts';
import { NativePlayerAdapter } from './native-player-adapter.ts';
import { isObrutPlayerFrame, PlayerJSAdapter } from './playerjs-adapter.ts';
import type { SessionPayload } from '../shared/messages.ts';
import type { ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';
import type { FrameVideoStatus, LocalVideoCandidate } from '../shared/video-frames.ts';
import { debugLog } from '../shared/config.ts';
import type {
  AuthoritativePlayerState,
  PlayerAdapter,
  PlayerEvent,
  PlayerSnapshot,
} from '../shared/player.ts';
import { playableStatus } from '../shared/player.ts';

interface AdapterRecord {
  adapter: PlayerAdapter;
  element: HTMLVideoElement | HTMLIFrameElement;
  abort: AbortController;
  probe: Promise<boolean>;
  probeError?: string;
}

const elementIds = new WeakMap<Element, string>();
const adapters = new Map<string, AdapterRecord>();
let nextCandidateId = 1;
let activeCandidateId: string | null = null;
let detachPlaybackListener: (() => void) | null = null;
let applyingRemote = false;
let applyGeneration = 0;
let sessionInfo: SessionPayload | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;

debugLog('frame agent loaded', { pageUrl: location.href, topFrame: window === window.top });

function idFor(element: Element, prefix: string): string {
  let id = elementIds.get(element);
  if (!id) {
    id = `${prefix}-${nextCandidateId++}`;
    elementIds.set(element, id);
  }
  return id;
}

function pageIsObrut(): boolean {
  return location.hostname === 'obrut.show' || location.hostname.endsWith('.obrut.show');
}

function createProbe(record: Omit<AdapterRecord, 'probe'>): Promise<boolean> {
  debugLog('probing player adapter', {
    candidateId: record.adapter.id,
    provider: record.adapter.provider,
    pageUrl: location.href,
  });
  return record.adapter.probe(record.abort.signal)
    .then(() => {
      debugLog('player adapter ready', {
        candidateId: record.adapter.id,
        provider: record.adapter.provider,
      });
      return true;
    })
    .catch((error) => {
      if ((error as Error).name !== 'AbortError') {
        record.probeError = record.adapter.provider === 'obrut'
          ? 'This embedded player does not expose synchronization controls.'
          : 'The video player is not ready for synchronization.';
        void browser.runtime.sendMessage({
          kind: 'playerAdapterStatus',
          status: 'unsupported',
          message: record.probeError,
        } satisfies ToBackgroundMessage);
        debugLog('player adapter probe failed', {
          candidateId: record.adapter.id,
          provider: record.adapter.provider,
          error: (error as Error).message,
        });
      }
      return false;
    });
}

function reconcileAdapters(): void {
  const liveIds = new Set<string>();
  if (!pageIsObrut()) {
    for (const video of document.querySelectorAll('video')) {
      const id = idFor(video, 'video');
      liveIds.add(id);
      if (!adapters.has(id)) {
        const abort = new AbortController();
        const base = { adapter: new NativePlayerAdapter(id, video), element: video, abort };
        adapters.set(id, { ...base, probe: createProbe(base) });
      }
    }
  }
  for (const iframe of document.querySelectorAll('iframe')) {
    if (!isObrutPlayerFrame(iframe)) continue;
    const id = idFor(iframe, 'obrut');
    liveIds.add(id);
    if (!adapters.has(id)) {
      const abort = new AbortController();
      const base = { adapter: new PlayerJSAdapter(id, iframe), element: iframe, abort };
      adapters.set(id, { ...base, probe: createProbe(base) });
    }
  }
  for (const [id, record] of adapters) {
    if (liveIds.has(id) && record.element.isConnected) continue;
    record.abort.abort();
    record.adapter.dispose();
    adapters.delete(id);
    if (activeCandidateId === id) deactivate();
  }
}

async function localCandidates(): Promise<LocalVideoCandidate[]> {
  reconcileAdapters();
  const result: LocalVideoCandidate[] = [];
  await Promise.all(Array.from(adapters.entries()).map(async ([candidateId, record]) => {
    if (!await record.probe) return;
    const rect = record.element.getBoundingClientRect();
    const state = await record.adapter.getState();
    result.push({
      candidateId,
      width: rect.width,
      height: rect.height,
      visibleArea: elementVisibleArea(record.element),
      currentTime: state.position,
      isPlaying: state.status === 'playing',
      provider: record.adapter.provider,
      playerStatus: state.status,
    });
  }));
  return result;
}

async function frameStatus(): Promise<FrameVideoStatus> {
  const childFrames = Array.from(document.querySelectorAll('iframe')).flatMap((iframe) => {
    try {
      if (!iframe.contentWindow) return [];
      return [{
        frameId: browser.runtime.getFrameId(iframe.contentWindow),
        visibleArea: elementVisibleArea(iframe),
      }];
    } catch {
      return [];
    }
  });
  const candidates = await localCandidates();
  const unsupportedReason = Array.from(adapters.values()).find((record) => record.probeError)?.probeError;
  return { candidates, childFrames, unsupportedReason };
}

function currentAdapter(): PlayerAdapter | null {
  if (!activeCandidateId) return null;
  return adapters.get(activeCandidateId)?.adapter ?? null;
}

function equivalentToRemote(event: PlayerEvent): boolean {
  return applyingRemote && (
    event.action === 'seek'
    || event.action === 'play'
    || event.action === 'pause'
    || event.action === 'buffering'
  );
}

function reportLocalPlayer(event: PlayerEvent): void {
  if (equivalentToRemote(event)) return;
  void browser.runtime.sendMessage({ kind: 'localPlayerEvent', event } satisfies ToBackgroundMessage);
}

function activate(candidateId: string): void {
  const record = adapters.get(candidateId);
  detachPlaybackListener?.();
  detachPlaybackListener = null;
  activeCandidateId = record ? candidateId : null;
  if (!record) return;
  detachPlaybackListener = record.adapter.subscribe(reportLocalPlayer);
  restartHeartbeat();
}

function deactivate(): void {
  detachPlaybackListener?.();
  detachPlaybackListener = null;
  activeCandidateId = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function applyRemoteState(state: AuthoritativePlayerState): Promise<void> {
  const adapter = currentAdapter();
  if (!adapter) return;
  const generation = ++applyGeneration;
  applyingRemote = true;
  try {
    await adapter.apply(state);
  } catch (error) {
    void browser.runtime.sendMessage({ kind: 'playbackApplyFailed' } satisfies ToBackgroundMessage);
    void browser.runtime.sendMessage({
      kind: 'playerAdapterStatus',
      status: 'error',
      message: (error as Error).message,
    } satisfies ToBackgroundMessage);
  } finally {
    setTimeout(() => {
      if (generation === applyGeneration) applyingRemote = false;
    }, 500);
  }
}

async function sendHeartbeat(): Promise<void> {
  if (!sessionInfo?.isHost) return;
  const adapter = currentAdapter();
  if (!adapter) return;
  const state = await adapter.getState();
  if (!playableStatus(state.status)) return;
  void browser.runtime.sendMessage({ kind: 'playerHeartbeat', state } satisfies ToBackgroundMessage);
}

function restartHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (!sessionInfo?.isHost || !currentAdapter()) return;
  void sendHeartbeat();
  heartbeatTimer = setInterval(() => void sendHeartbeat(), 5000);
}

function notifyCandidatesChanged(): void {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    reconcileAdapters();
    void browser.runtime.sendMessage({ kind: 'frameVideoCandidatesChanged' } satisfies ToBackgroundMessage);
  }, 150);
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type !== 'attributes' || !(mutation.target instanceof HTMLIFrameElement)) continue;
    const previousId = elementIds.get(mutation.target);
    if (!previousId) continue;
    const record = adapters.get(previousId);
    record?.abort.abort();
    record?.adapter.dispose();
    adapters.delete(previousId);
    elementIds.set(mutation.target, `obrut-${nextCandidateId++}`);
    if (activeCandidateId === previousId) deactivate();
  }
  notifyCandidatesChanged();
});
observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
window.addEventListener('pagehide', () => {
  observer.disconnect();
  deactivate();
  for (const record of adapters.values()) {
    record.abort.abort();
    record.adapter.dispose();
  }
  adapters.clear();
}, { once: true });
notifyCandidatesChanged();

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as ToContentMessage;
  switch (msg.kind) {
    case 'frameVideoStatusRequest':
      return frameStatus();
    case 'activateVideoCandidate':
      reconcileAdapters();
      activate(msg.candidateId);
      return;
    case 'deactivateVideoCandidate':
      deactivate();
      return;
    case 'applyPlayerState':
      void applyRemoteState(msg.state);
      return;
    case 'remotePlaybackEvent':
    case 'authoritativeState':
    case 'timeSync': {
      const adapter = currentAdapter();
      if (!adapter) return;
      void adapter.getState().then((local) => applyRemoteState({
        revision: 0,
        source: local.source,
        position: msg.kind === 'remotePlaybackEvent' ? msg.event.currentTime
          : msg.kind === 'authoritativeState' ? msg.currentTime : msg.state.currentTime,
        status: (msg.kind === 'remotePlaybackEvent' ? msg.event.isPlaying
          : msg.kind === 'authoritativeState' ? msg.isPlaying : msg.state.isPlaying)
          ? 'playing' : 'paused',
        timestamp: msg.kind === 'timeSync' ? msg.timestamp : Date.now(),
      }));
      return;
    }
    case 'sessionInfo':
      sessionInfo = msg.payload;
      restartHeartbeat();
      return;
  }
});
