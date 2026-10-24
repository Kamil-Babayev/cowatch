import type { PlayerEvent } from '../shared/player.ts';

/**
 * Tells the player events caused by applying the room's state apart from
 * the user's own actions. Applying "playing at 42 s" makes the player fire
 * play and seeked events a moment later; reporting those back would bounce
 * the same state around the room.
 *
 * Instead of muting everything for a fixed time, an event is only treated
 * as an echo when it matches what the applied state should produce, so a
 * user who seeks elsewhere right after a sync is still heard.
 */
export class EchoFilter {
  private expected: { position: number; playing: boolean; at: number } | null = null;
  private now: () => number;
  private windowMs: number;
  private toleranceSeconds: number;

  constructor(now: () => number = Date.now, windowMs = 2000, toleranceSeconds = 0.5) {
    this.now = now;
    this.windowMs = windowMs;
    this.toleranceSeconds = toleranceSeconds;
  }

  /** Records the state the player is being moved to. */
  expect(position: number, playing: boolean): void {
    this.expected = { position, playing, at: this.now() };
  }

  isEcho(event: PlayerEvent): boolean {
    const expected = this.expected;
    if (!expected) return false;
    const elapsed = this.now() - expected.at;
    if (elapsed > this.windowMs) {
      this.expected = null;
      return false;
    }
    switch (event.action) {
      case 'play':
        return expected.playing;
      case 'pause':
        return !expected.playing;
      case 'seek': {
        const projected = expected.position + (expected.playing ? elapsed / 1000 : 0);
        return Math.abs(event.position - projected) <= this.toleranceSeconds;
      }
      case 'buffering':
      case 'status':
        return true;
      default:
        return false;
    }
  }
}
