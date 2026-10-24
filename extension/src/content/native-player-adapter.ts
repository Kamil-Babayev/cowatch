import type {
  AuthoritativePlayerState,
  MediaSource,
  PlayerAdapter,
  PlayerCapabilities,
  PlayerEvent,
  PlayerSnapshot,
  PlayerStatus,
} from '../shared/player.ts';
import { pageKey } from '../shared/page-key.ts';
import { driftAction, projectPosition, SMOOTH_DRIFT_MIN } from '../shared/sync-math.ts';
import { EchoFilter } from './echo-filter.ts';

/** How much faster/slower than normal a drifting player runs to catch up. */
const NUDGE = 0.05;
const NUDGE_DURATION_MS = 3000;

/**
 * Native players are identified by the page, never by `currentSrc`:
 * streaming players (HLS/DASH, YouTube) play `blob:` URLs that differ in
 * every browser, and CDN links often carry per-viewer tokens.
 */
function nativeSource(): MediaSource {
  const href = window.location.href;
  return { pageUrl: href, provider: 'native', mediaKey: pageKey(href) };
}

function statusOf(video: HTMLVideoElement): PlayerStatus {
  if (video.ended) return 'ended';
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return video.paused ? 'loading' : 'buffering';
  return video.paused ? 'paused' : 'playing';
}

export class NativePlayerAdapter implements PlayerAdapter {
  readonly provider = 'native' as const;
  readonly id: string;
  private video: HTMLVideoElement;
  private listeners = new Set<(event: PlayerEvent) => void>();
  private cleanup: Array<() => void> = [];
  private disposed = false;
  private appliedOnce = false;
  private echoes: EchoFilter;
  private now: () => number;
  // The speed the user chose; drift nudges are relative to it.
  private baseRate: number;
  private nudging = false;
  private rateResetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, video: HTMLVideoElement, now: () => number = Date.now) {
    this.id = id;
    this.video = video;
    this.now = now;
    this.echoes = new EchoFilter(now);
    this.baseRate = video.playbackRate || 1;
    this.attachEvents();
  }

  async probe(signal: AbortSignal): Promise<PlayerCapabilities> {
    if (signal.aborted || this.disposed || !this.video.isConnected) {
      throw new DOMException('Player probe aborted', 'AbortError');
    }
    return { canPlay: true, canPause: true, canSeek: true, canLoadSource: false, canSetRate: true };
  }

  async getState(): Promise<PlayerSnapshot> {
    return {
      source: nativeSource(),
      position: Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0,
      status: statusOf(this.video),
      duration: Number.isFinite(this.video.duration) ? this.video.duration : undefined,
    };
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async apply(state: AuthoritativePlayerState): Promise<void> {
    if (this.disposed) return;
    // The host is waiting for data: hold whatever we are doing rather than
    // pausing everyone; the host's next heartbeat says how to continue.
    if (state.status === 'buffering') return;

    const playing = state.status === 'playing';
    const target = projectPosition(state, this.now());
    const drift = target - this.video.currentTime;
    const action = driftAction(drift, playing, this.appliedOnce);
    // Set before play(): a blocked autoplay must not make every later
    // heartbeat hard-seek again.
    this.appliedOnce = true;
    this.echoes.expect(action === 'seek' ? target : this.video.currentTime, playing);

    if (action === 'seek') {
      this.stopNudge();
      this.video.currentTime = target;
    } else if (action === 'nudge') {
      this.nudge(drift > 0 ? 1 + NUDGE : 1 - NUDGE);
    } else if (Math.abs(drift) < SMOOTH_DRIFT_MIN) {
      this.stopNudge();
    }

    if (playing && this.video.paused) {
      await this.video.play();
    } else if (!playing && !this.video.paused) {
      this.video.pause();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopNudge();
    this.disposed = true;
    for (const remove of this.cleanup.splice(0)) remove();
    this.listeners.clear();
  }

  private on(name: keyof HTMLMediaElementEventMap, handler: () => void): void {
    this.video.addEventListener(name, handler);
    this.cleanup.push(() => this.video.removeEventListener(name, handler));
  }

  private emit(action: PlayerEvent['action'], status?: PlayerStatus): void {
    void this.getState().then((snapshot) => {
      const event: PlayerEvent = { ...snapshot, status: status ?? snapshot.status, action };
      if (this.echoes.isEcho(event)) return;
      for (const listener of this.listeners) listener(event);
    });
  }

  private attachEvents(): void {
    this.on('play', () => this.emit('play'));
    this.on('pause', () => this.emit('pause'));
    this.on('seeked', () => this.emit('seek'));
    this.on('waiting', () => this.emit('buffering', 'buffering'));
    // Playback resumed after buffering: the host reports it right away
    // instead of leaving joiners holding until the next heartbeat.
    this.on('playing', () => this.emit('status'));
    this.on('ended', () => this.emit('ended'));
    this.on('ratechange', () => {
      if (!this.nudging) this.baseRate = this.video.playbackRate || 1;
    });
  }

  private nudge(factor: number): void {
    this.nudging = true;
    this.video.playbackRate = this.baseRate * factor;
    if (this.rateResetTimer) clearTimeout(this.rateResetTimer);
    this.rateResetTimer = setTimeout(() => this.stopNudge(), NUDGE_DURATION_MS);
  }

  private stopNudge(): void {
    if (this.rateResetTimer) clearTimeout(this.rateResetTimer);
    this.rateResetTimer = null;
    if (!this.nudging || this.disposed) return;
    this.video.playbackRate = this.baseRate;
    // ratechange fires asynchronously; keep ignoring it until it has.
    setTimeout(() => {
      if (!this.rateResetTimer) this.nudging = false;
    }, 0);
  }
}
