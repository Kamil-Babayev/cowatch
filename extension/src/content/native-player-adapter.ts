import type {
  AuthoritativePlayerState,
  MediaSource,
  PlayerAdapter,
  PlayerCapabilities,
  PlayerEvent,
  PlayerSnapshot,
  PlayerStatus,
} from '../shared/player.ts';

const SMOOTH_DRIFT_MIN = 0.25;
const HARD_SEEK_DRIFT = 1.5;

function nativeSource(video: HTMLVideoElement): MediaSource {
  return {
    pageUrl: window.location.href,
    provider: 'native',
    mediaKey: video.currentSrc || video.src || window.location.href,
  };
}

function statusOf(video: HTMLVideoElement): PlayerStatus {
  if (video.ended) return 'ended';
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return 'loading';
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
  private rateResetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(id: string, video: HTMLVideoElement) {
    this.id = id;
    this.video = video;
    this.attachEvents();
  }

  async probe(signal: AbortSignal): Promise<PlayerCapabilities> {
    if (signal.aborted || this.disposed || !this.video.isConnected) {
      throw new DOMException('Player probe aborted', 'AbortError');
    }
    return {
      canPlay: true,
      canPause: true,
      canSeek: true,
      canLoadSource: true,
      canSetRate: true,
    };
  }

  async getState(): Promise<PlayerSnapshot> {
    return {
      source: nativeSource(this.video),
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
    if (state.source.mediaKey !== nativeSource(this.video).mediaKey) {
      await this.loadSource(state.source);
    }

    const target = Math.max(0, state.position + (
      state.status === 'playing' ? Math.max(0, Date.now() - state.timestamp) / 1000 : 0
    ));
    const drift = target - this.video.currentTime;
    if (!this.appliedOnce || Math.abs(drift) >= HARD_SEEK_DRIFT) {
      this.video.currentTime = target;
      this.resetPlaybackRate();
    } else if (state.status === 'playing' && Math.abs(drift) >= SMOOTH_DRIFT_MIN) {
      this.video.playbackRate = drift > 0 ? 1.05 : 0.95;
      if (this.rateResetTimer) clearTimeout(this.rateResetTimer);
      this.rateResetTimer = setTimeout(() => this.resetPlaybackRate(), 3000);
    } else if (Math.abs(drift) < SMOOTH_DRIFT_MIN) {
      this.resetPlaybackRate();
    }

    if (state.status === 'playing' && this.video.paused) {
      await this.video.play();
    } else if (state.status !== 'playing' && !this.video.paused) {
      this.video.pause();
    }
    this.appliedOnce = true;
  }

  async loadSource(source: MediaSource): Promise<void> {
    if (source.provider !== 'native' || !source.mediaKey || source.mediaKey === nativeSource(this.video).mediaKey) {
      return;
    }
    const parsed = new URL(source.mediaKey, window.location.href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Unsupported native media source');
    }
    this.video.src = parsed.href;
    this.video.load();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const remove of this.cleanup.splice(0)) remove();
    this.listeners.clear();
    this.resetPlaybackRate();
  }

  private attachEvents(): void {
    const events: Array<[keyof HTMLMediaElementEventMap, PlayerEvent['action']]> = [
      ['play', 'play'],
      ['pause', 'pause'],
      ['seeked', 'seek'],
      ['waiting', 'buffering'],
      ['ended', 'ended'],
      ['emptied', 'replace'],
    ];
    for (const [name, action] of events) {
      const handler = () => {
        void this.getState().then((snapshot) => {
          const status = action === 'buffering' ? 'buffering' : snapshot.status;
          for (const listener of this.listeners) listener({ ...snapshot, status, action });
        });
      };
      this.video.addEventListener(name, handler);
      this.cleanup.push(() => this.video.removeEventListener(name, handler));
    }
  }

  private resetPlaybackRate(): void {
    if (this.rateResetTimer) clearTimeout(this.rateResetTimer);
    this.rateResetTimer = null;
    if (!this.disposed || this.video.isConnected) this.video.playbackRate = 1;
  }
}
