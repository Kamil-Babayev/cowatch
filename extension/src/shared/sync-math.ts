/**
 * Pure functions only — no DOM, no messaging, no WebSocket. Both player
 * adapters share this drift policy, so it lives here where it is testable
 * without jsdom or any browser API mocking at all.
 */
import type { AuthoritativePlayerState } from './player.ts';

/** Below this, two players are considered in sync. */
export const SMOOTH_DRIFT_MIN = 0.25;
/** At or above this, nudging the playback rate would take too long. */
export const HARD_SEEK_DRIFT = 1.5;

/**
 * Where the room's video is "now": a playing state keeps moving after it
 * was stamped, a paused or buffering one does not.
 */
export function projectPosition(state: AuthoritativePlayerState, nowMs: number): number {
  const elapsed = state.status === 'playing' ? Math.max(0, nowMs - state.timestamp) / 1000 : 0;
  return Math.max(0, state.position + elapsed);
}

export type DriftAction = 'none' | 'nudge' | 'seek';

/**
 * Small drift is corrected by briefly changing the playback rate, large
 * drift by seeking. Until the first state has been applied, any noticeable
 * drift seeks — a joiner arriving minutes behind should jump, not crawl.
 */
export function driftAction(drift: number, playing: boolean, appliedOnce: boolean): DriftAction {
  const size = Math.abs(drift);
  if (size < SMOOTH_DRIFT_MIN) return 'none';
  if (size >= HARD_SEEK_DRIFT || !appliedOnce || !playing) return 'seek';
  return 'nudge';
}
