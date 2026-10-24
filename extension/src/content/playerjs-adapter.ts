import type {
  AuthoritativePlayerState,
  MediaSource,
  PlayerAdapter,
  PlayerCapabilities,
  PlayerEvent,
  PlayerSnapshot,
  PlayerStatus,
} from '../shared/player.ts';
import { projectPosition, SMOOTH_DRIFT_MIN } from '../shared/sync-math.ts';
import { EchoFilter } from './echo-filter.ts';

interface PlayerJSMessage {
  event?: string;
  answer?: unknown;
  data?: unknown;
}

export interface PlayerJSTiming {
  /** How long one postMessage query may go unanswered. */
  queryTimeoutMs: number;
  /** Handshake attempts before the player is declared unsupported. */
  probeAttempts: number;
  /** Pause between handshake attempts (cut short by the player's init). */
  probeRetryMs: number;
}

const DEFAULT_TIMING: PlayerJSTiming = { queryTimeoutMs: 1500, probeAttempts: 6, probeRetryMs: 1500 };

function parseMessage(data: unknown): PlayerJSMessage | null {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data) as PlayerJSMessage;
    } catch {
      return null;
    }
  }
  return typeof data === 'object' && data !== null ? data as PlayerJSMessage : null;
}

function isObrutOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname;
    return hostname === 'obrut.show' || hostname.endsWith('.obrut.show');
  } catch {
    return false;
  }
}

export function isObrutPlayerFrame(iframe: HTMLIFrameElement): boolean {
  try {
    return isObrutOrigin(new URL(iframe.src, window.location.href).origin);
  } catch {
    return false;
  }
}

function abortError(): DOMException {
  return new DOMException('Player probe aborted', 'AbortError');
}

/**
 * Controls a PlayerJS player in a cross-origin obrut.show iframe through its
 * documented postMessage API — the iframe's DOM is never readable.
 */
export class PlayerJSAdapter implements PlayerAdapter {
  readonly provider = 'obrut' as const;
  readonly id: string;
  private iframe: HTMLIFrameElement;
  private origin: string;
  private timing: PlayerJSTiming;
  private now: () => number;
  private echoes: EchoFilter;
  private listeners = new Set<(event: PlayerEvent) => void>();
  private pendingQueries = new Map<string, Array<(answer: unknown) => void>>();
  private status: PlayerStatus = 'loading';
  private statusBeforeBuffering: PlayerStatus = 'paused';
  private position = 0;
  private duration: number | undefined;
  private ready = false;
  private disposed = false;
  private queuedState: AuthoritativePlayerState | null = null;
  // The src this adapter itself navigated the iframe to, so the frame agent
  // does not mistake our own source change for a different player.
  private expectedSrc: string | null = null;
  private wakeProbe: (() => void) | null = null;
  private reloading: Promise<void> | null = null;

  constructor(id: string, iframe: HTMLIFrameElement, timing: Partial<PlayerJSTiming> = {}, now: () => number = Date.now) {
    this.id = id;
    this.iframe = iframe;
    this.origin = new URL(iframe.src, window.location.href).origin;
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.now = now;
    this.echoes = new EchoFilter(now);
    window.addEventListener('message', this.onMessage);
    iframe.addEventListener('load', this.onLoad);
  }

  /**
   * The iframe is often still about:blank, or the player still booting,
   * when it is first seen; keep trying until it answers. The player's own
   * init event or the iframe's load event cut the wait short.
   */
  async probe(signal: AbortSignal): Promise<PlayerCapabilities> {
    if (!isObrutOrigin(this.origin)) throw abortError();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.timing.probeAttempts; attempt += 1) {
      if (signal.aborted || this.disposed) throw abortError();
      try {
        await this.handshake(signal);
        return { canPlay: true, canPause: true, canSeek: true, canLoadSource: true, canSetRate: false };
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        lastError = error;
      }
      await this.waitForRetry(signal);
    }
    throw lastError instanceof Error ? lastError : new Error('PlayerJS postMessage API did not respond');
  }

  async getState(): Promise<PlayerSnapshot> {
    if (this.ready) {
      const [time, playing] = await Promise.all([this.query('time'), this.query('playing')]);
      if (Number.isFinite(Number(time))) this.position = Number(time);
      if (typeof playing === 'boolean' && this.status !== 'buffering' && this.status !== 'ended') {
        this.status = playing ? 'playing' : 'paused';
      }
    }
    return { source: this.source(), position: this.position, status: this.status, duration: this.duration };
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  expectsSource(src: string): boolean {
    return this.expectedSrc !== null && new URL(src, window.location.href).href === this.expectedSrc;
  }

  async apply(state: AuthoritativePlayerState): Promise<void> {
    if (this.disposed) return;
    if (!this.ready) {
      this.queuedState = state;
      return;
    }
    if (state.source.mediaKey !== this.source().mediaKey) {
      this.queuedState = state;
      this.loadSource(state.source);
      return;
    }
    if (state.status === 'buffering') return;
    const playing = state.status === 'playing';
    const target = projectPosition(state, this.now());
    const current = Number(await this.query('time'));
    const seek = !Number.isFinite(current) || Math.abs(current - target) >= SMOOTH_DRIFT_MIN;
    this.echoes.expect(seek ? target : current, playing);
    if (seek) {
      this.command('seek', target);
      this.position = target;
    }
    this.command(playing ? 'play' : 'pause');
    this.status = state.status;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.queuedState = null;
    this.listeners.clear();
    this.pendingQueries.clear();
    this.wakeProbe?.();
    window.removeEventListener('message', this.onMessage);
    this.iframe.removeEventListener('load', this.onLoad);
  }

  private async handshake(signal?: AbortSignal): Promise<void> {
    const [id, time, playing] = await Promise.all([
      this.query('id', signal),
      this.query('time', signal),
      this.query('playing', signal),
    ]);
    if ((typeof id !== 'string' && typeof id !== 'number') ||
        !Number.isFinite(Number(time)) || typeof playing !== 'boolean') {
      throw new Error('PlayerJS postMessage API returned an invalid handshake');
    }
    this.position = Number(time);
    this.status = playing ? 'playing' : 'paused';
    this.ready = true;
    const queued = this.queuedState;
    this.queuedState = null;
    if (queued) await this.apply(queued);
  }

  private waitForRetry(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        if (this.wakeProbe === done) this.wakeProbe = null;
        resolve();
      };
      const timer = setTimeout(done, this.timing.probeRetryMs);
      signal.addEventListener('abort', done, { once: true });
      this.wakeProbe = done;
    });
  }

  private loadSource(source: MediaSource): void {
    if (source.provider !== 'obrut') return;
    const next = new URL(source.mediaKey, window.location.href);
    if (!isObrutOrigin(next.origin)) return;
    this.ready = false;
    this.status = 'reloading';
    this.origin = next.origin;
    this.expectedSrc = next.href;
    this.iframe.src = next.href;
  }

  /** After our own source change, handshake again and apply what queued. */
  private onLoad = (): void => {
    this.wakeProbe?.();
    if (this.ready || this.disposed || this.expectedSrc === null || this.reloading) return;
    const controller = new AbortController();
    this.reloading = this.probe(controller.signal)
      .then(() => this.emit('status'))
      .catch(() => undefined)
      .finally(() => {
        this.reloading = null;
      });
  };

  private source(): MediaSource {
    return {
      pageUrl: window.location.href,
      provider: 'obrut',
      mediaKey: new URL(this.iframe.src, window.location.href).href,
    };
  }

  private command(api: string, set?: unknown): void {
    const contentWindow = this.iframe.contentWindow;
    if (!contentWindow || this.disposed) return;
    const message: { api: string; set?: unknown } = { api };
    if (set !== undefined) message.set = set;
    contentWindow.postMessage(message, this.origin);
  }

  private query(api: string, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('Player adapter disposed'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const removeWaiter = () => {
        const queue = this.pendingQueries.get(api);
        if (!queue) return;
        const remaining = queue.filter((item) => item !== finish);
        if (remaining.length === 0) this.pendingQueries.delete(api);
        else this.pendingQueries.set(api, remaining);
      };
      const settle = () => {
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (answer: unknown) => {
        if (settled) return;
        settle();
        resolve(answer);
      };
      const abort = () => {
        if (settled) return;
        settle();
        removeWaiter();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settle();
        removeWaiter();
        reject(new Error('PlayerJS postMessage API did not respond'));
      }, this.timing.queryTimeoutMs);
      this.pendingQueries.set(api, [...(this.pendingQueries.get(api) ?? []), finish]);
      signal?.addEventListener('abort', abort, { once: true });
      this.command(api);
    });
  }

  private emit(action: PlayerEvent['action']): void {
    const event: PlayerEvent = {
      source: this.source(),
      position: this.position,
      status: this.status,
      duration: this.duration,
      action,
    };
    if (this.echoes.isEcho(event)) return;
    for (const listener of this.listeners) listener(event);
  }

  private onMessage = (event: MessageEvent): void => {
    if (this.disposed || event.source !== this.iframe.contentWindow || !isObrutOrigin(event.origin)) return;
    const message = parseMessage(event.data);
    if (!message?.event) return;
    // The player may have redirected to another obrut host; talk to the
    // origin it actually answers from.
    this.origin = event.origin;

    if (Object.prototype.hasOwnProperty.call(message, 'answer')) {
      const queue = this.pendingQueries.get(message.event);
      const resolve = queue?.shift();
      if (queue?.length === 0) this.pendingQueries.delete(message.event);
      resolve?.(message.answer);
      return;
    }

    const data = message.data;
    switch (message.event) {
      case 'init':
        this.wakeProbe?.();
        return;
      case 'play':
      case 'userplay':
        this.status = 'playing';
        this.emit('play');
        return;
      case 'pause':
      case 'userpause':
        this.status = 'paused';
        this.emit('pause');
        return;
      case 'seek':
      case 'userseek':
        if (Number.isFinite(Number(data))) this.position = Number(data);
        this.emit('seek');
        return;
      case 'time':
        if (Number.isFinite(Number(data))) this.position = Number(data);
        return;
      case 'duration':
        if (Number.isFinite(Number(data))) this.duration = Number(data);
        return;
      case 'buffering':
        if (this.status !== 'buffering') this.statusBeforeBuffering = this.status;
        this.status = 'buffering';
        this.emit('buffering');
        return;
      case 'buffered':
        // Buffering ended; the player resumes whatever it was doing, which
        // is not necessarily playing (a paused seek also buffers).
        this.status = this.statusBeforeBuffering === 'playing' ? 'playing' : 'paused';
        this.emit('status');
        return;
      case 'new':
        this.status = 'loading';
        this.emit('replace');
        return;
      case 'end':
      case 'finish':
        this.status = 'ended';
        this.emit('ended');
        return;
    }
  };
}
