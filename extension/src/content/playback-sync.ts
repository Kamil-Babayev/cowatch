import type { PlaybackPayload } from '../shared/messages.ts';
import { computeJoinSeekTarget, shouldCorrectDrift } from '../shared/sync-math.ts';

export const DRIFT_THRESHOLD_SECONDS = 1.5;

export function correctedPlaybackState(
  state: PlaybackPayload,
  timestamp: number,
  now = Date.now(),
): PlaybackPayload {
  return {
    currentTime: computeJoinSeekTarget(
      state.currentTime,
      state.isPlaying,
      timestamp,
      now,
    ),
    isPlaying: state.isPlaying,
  };
}

export function correctionForHeartbeat(
  localTime: number,
  state: PlaybackPayload,
  timestamp: number,
  now = Date.now(),
): PlaybackPayload | null {
  const corrected = correctedPlaybackState(state, timestamp, now);
  return shouldCorrectDrift(
    localTime,
    corrected.currentTime,
    DRIFT_THRESHOLD_SECONDS,
  )
    ? corrected
    : null;
}

export async function applyPlaybackState(
  video: HTMLVideoElement,
  state: PlaybackPayload,
): Promise<void> {
  video.currentTime = Math.max(0, state.currentTime);
  if (state.isPlaying && video.paused) {
    await video.play();
  } else if (!state.isPlaying && !video.paused) {
    video.pause();
  }
}
