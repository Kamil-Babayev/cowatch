import { VideoDetector, elementVisibleArea } from './video-detector.ts';
import { attachPlaybackListeners, type PlaybackEvent } from './playback-events.ts';
import {
  applyPlaybackState,
  correctionForHeartbeat,
} from './playback-sync.ts';
import type { PlaybackPayload, SessionPayload } from '../shared/messages.ts';
import type { ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';
import type { FrameVideoStatus, LocalVideoCandidate } from '../shared/video-frames.ts';

const detector = new VideoDetector(document);
const candidateIds = new WeakMap<HTMLVideoElement, string>();
let nextCandidateId = 1;
let activeCandidateId: string | null = null;
let detachPlaybackListeners: (() => void) | null = null;
let applyingRemoteEvent = false;
let remoteApplyGeneration = 0;
let sessionInfo: SessionPayload | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let changeTimer: ReturnType<typeof setTimeout> | null = null;

function candidateId(video: HTMLVideoElement): string {
  let id = candidateIds.get(video);
  if (!id) {
    id = `video-${nextCandidateId++}`;
    candidateIds.set(video, id);
  }
  return id;
}

function localCandidates(): LocalVideoCandidate[] {
  return detector.listCandidates().map((video) => {
    const rect = video.getBoundingClientRect();
    return {
      candidateId: candidateId(video),
      width: rect.width,
      height: rect.height,
      visibleArea: elementVisibleArea(video),
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      isPlaying: !video.paused,
    };
  });
}

function frameStatus(): FrameVideoStatus {
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
  return { candidates: localCandidates(), childFrames };
}

function currentVideo(): HTMLVideoElement | null {
  if (!activeCandidateId) return null;
  return detector.listCandidates().find(
    (video) => candidateId(video) === activeCandidateId,
  ) ?? null;
}

function reportLocalPlayback(event: PlaybackEvent): void {
  if (applyingRemoteEvent) return;
  void browser.runtime.sendMessage({
    kind: 'localPlaybackEvent',
    event,
  } satisfies ToBackgroundMessage);
}

function activate(candidate: string): void {
  const video = detector.listCandidates().find(
    (item) => candidateId(item) === candidate,
  );
  detachPlaybackListeners?.();
  detachPlaybackListeners = null;
  activeCandidateId = video ? candidate : null;
  if (!video) return;
  detector.selectOverride(video);
  detachPlaybackListeners = attachPlaybackListeners(video, reportLocalPlayback);
  restartHeartbeat();
}

function deactivate(): void {
  detachPlaybackListeners?.();
  detachPlaybackListeners = null;
  activeCandidateId = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

async function applyRemoteState(state: PlaybackPayload): Promise<void> {
  const video = currentVideo();
  if (!video) return;
  const generation = ++remoteApplyGeneration;
  applyingRemoteEvent = true;
  try {
    await applyPlaybackState(video, state);
  } catch {
    void browser.runtime.sendMessage({
      kind: 'playbackApplyFailed',
    } satisfies ToBackgroundMessage);
  } finally {
    setTimeout(() => {
      if (generation === remoteApplyGeneration) applyingRemoteEvent = false;
    }, 0);
  }
}

function sendHeartbeat(): void {
  if (!sessionInfo?.isHost) return;
  const video = currentVideo();
  if (!video) return;
  void browser.runtime.sendMessage({
    kind: 'playbackHeartbeat',
    state: { currentTime: video.currentTime, isPlaying: !video.paused },
  } satisfies ToBackgroundMessage);
}

function restartHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (!sessionInfo?.isHost || !currentVideo()) return;
  sendHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, 5000);
}

function notifyCandidatesChanged(): void {
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    changeTimer = null;
    void browser.runtime.sendMessage({
      kind: 'frameVideoCandidatesChanged',
    } satisfies ToBackgroundMessage);
  }, 100);
}

detector.onCandidatesChange(() => {
  if (activeCandidateId && !currentVideo()) deactivate();
  notifyCandidatesChanged();
});
notifyCandidatesChanged();

browser.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as ToContentMessage;
  switch (msg.kind) {
    case 'frameVideoStatusRequest':
      return Promise.resolve(frameStatus());
    case 'activateVideoCandidate':
      activate(msg.candidateId);
      return;
    case 'deactivateVideoCandidate':
      deactivate();
      return;
    case 'remotePlaybackEvent':
      void applyRemoteState({
        currentTime: msg.event.currentTime,
        isPlaying: msg.event.isPlaying,
      });
      return;
    case 'authoritativeState':
      void applyRemoteState({
        currentTime: msg.currentTime,
        isPlaying: msg.isPlaying,
      });
      return;
    case 'timeSync': {
      const video = currentVideo();
      if (!video) return;
      const correction = correctionForHeartbeat(video.currentTime, msg.state, msg.timestamp);
      if (correction) void applyRemoteState(correction);
      return;
    }
    case 'sessionInfo':
      sessionInfo = msg.payload;
      restartHeartbeat();
      return;
  }
});
