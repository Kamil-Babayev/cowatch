/**
 * Pure functions only — no DOM, no messaging, no WebSocket. Both US-2.7
 * (drift correction) and US-2.8 (new-joiner state sync) reduce to small
 * bits of arithmetic once the I/O is stripped away, and keeping them pure
 * means they're testable without jsdom or any browser API mocking at all.
 */

/**
 * US-2.7: should a client correct its local playback position given a
 * `timeSync` heartbeat from whoever holds control? Only past a threshold —
 * correcting on every tiny network blip would be more jarring than the
 * drift itself.
 */
export function shouldCorrectDrift(
  localCurrentTime: number,
  remoteCurrentTime: number,
  thresholdSeconds = 1.5,
): boolean {
  return Math.abs(localCurrentTime - remoteCurrentTime) > thresholdSeconds;
}

/**
 * US-2.8: given the room's last-known state (as returned by the server's
 * `stateResponse`, which carries the *server-stamped* timestamp of when
 * that state was true — see epic-1-report.md's note on this), compute
 * where a newly-joining client should actually seek to.
 *
 * If playback was running when the state was captured, time has kept
 * moving since then — add the elapsed wall-clock time. If it was paused,
 * nothing has moved regardless of how long the state has been sitting in
 * the cache.
 */
export function computeJoinSeekTarget(
  stateCurrentTime: number,
  stateIsPlaying: boolean,
  stateTimestampMs: number,
  nowMs: number = Date.now(),
): number {
  if (!stateIsPlaying) return stateCurrentTime;
  const elapsedSeconds = Math.max(0, (nowMs - stateTimestampMs) / 1000);
  return stateCurrentTime + elapsedSeconds;
}
