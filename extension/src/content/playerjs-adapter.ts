import type {
  AuthoritativePlayerState,
  MediaSource,
  PlayerAdapter,
  PlayerCapabilities,
  PlayerEvent,
  PlayerSnapshot,
  PlayerStatus,
} from '../shared/player.ts';

interface PlayerJSMessage {
  event?: string;
  answer?: unknown;
  data?: unknown;
}

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

function playerOrigin(iframe: HTMLIFrameElement): string {
  return new URL(iframe.src, window.location.href).origin;
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

export class PlayerJSAdapter implements PlayerAdapter {
  readonly provider = 'obrut' as const;
  readonly id: string;
  private iframe: HTMLIFrameElement;
  private origin: string;
  private listeners = new Set<(event: PlayerEvent) => void>();
  private pendingQueries = new Map<string, Array<(answer: unknown) => void>>();
  private status: PlayerStatus = 'loading';
  private position = 0;
  private duration: number | undefined;
  private ready = false;
  private disposed = false;
  private queuedState: AuthoritativePlayerState | null = null;

  constructor(id: string, iframe: HTMLIFrameElement) {
    this.id = id;
    this.iframe = iframe;
    this.origin = playerOrigin(iframe);
    window.addEventListener('message', this.onMessage);
  }

  async probe(signal: AbortSignal): Promise<PlayerCapabilities> {
    if (signal.aborted || this.disposed || !this.iframe.contentWindow || !isObrutOrigin(this.origin)) {
      throw new DOMException('Player probe aborted', 'AbortError');
    }
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
    return {
      canPlay: true,
      canPause: true,
      canSeek: true,
      canLoadSource: true,
      canSetRate: false,
    };
  }

  async getState(): Promise<PlayerSnapshot> {
    if (this.ready) {
      const [time, playing] = await Promise.all([
        this.query('time'),
        this.query('playing'),
      ]);
      if (Number.isFinite(Number(time))) this.position = Number(time);
      if (typeof playing === 'boolean' && this.status !== 'buffering' && this.status !== 'ended') {
        this.status = playing ? 'playing' : 'paused';
      }
    }
    return {
      source: this.source(),
      position: this.position,
      status: this.status,
      duration: this.duration,
    };
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async apply(state: AuthoritativePlayerState): Promise<void> {
    if (this.disposed) return;
    if (!this.ready) {
      this.queuedState = state;
      return;
    }
    if (state.source.mediaKey !== this.source().mediaKey) {
      await this.loadSource(state.source);
      this.queuedState = state;
      return;
    }
    const target = Math.max(0, state.position + (
      state.status === 'playing' ? Math.max(0, Date.now() - state.timestamp) / 1000 : 0
    ));
    const current = Number(await this.query('time'));
    if (!Number.isFinite(current) || Math.abs(current - target) >= 0.25) {
      this.command('seek', target);
      this.position = target;
    }
    if (state.status === 'playing') {
      this.command('play');
    } else {
      this.command('pause');
    }
    this.status = state.status;
  }

  async loadSource(source: MediaSource): Promise<void> {
    if (source.provider !== 'obrut' || source.mediaKey === this.source().mediaKey) return;
    const next = new URL(source.mediaKey, window.location.href);
    if (!isObrutOrigin(next.origin)) throw new Error('Unsupported PlayerJS source origin');
    this.ready = false;
    this.status = 'reloading';
    this.origin = next.origin;
    this.iframe.src = next.href;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.queuedState = null;
    this.listeners.clear();
    this.pendingQueries.clear();
    window.removeEventListener('message', this.onMessage);
  }

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
      const pending = this.pendingQueries.get(api) ?? [];
      let settled = false;
      const finish = (answer: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve(answer);
      };
      pending.push(finish);
      this.pendingQueries.set(api, pending);
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const queue = this.pendingQueries.get(api);
        if (queue) {
          const remaining = queue.filter((item) => item !== finish);
          if (remaining.length === 0) this.pendingQueries.delete(api);
          else this.pendingQueries.set(api, remaining);
        }
        reject(new DOMException('Player probe aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        const queue = this.pendingQueries.get(api);
        if (queue) this.pendingQueries.set(api, queue.filter((item) => item !== finish));
        reject(new Error('PlayerJS postMessage API did not respond'));
      }, 1500);
      signal?.addEventListener('abort', abort, { once: true });
      this.command(api);
    });
  }

  private onMessage = (event: MessageEvent): void => {
    if (this.disposed || event.source !== this.iframe.contentWindow || event.origin !== this.origin) return;
    const message = parseMessage(event.data);
    if (!message?.event) return;

    if (Object.prototype.hasOwnProperty.call(message, 'answer')) {
      const queue = this.pendingQueries.get(message.event);
      const resolve = queue?.shift();
      if (queue?.length === 0) this.pendingQueries.delete(message.event);
      resolve?.(message.answer);
      return;
    }

    const data = message.data;
    let action: PlayerEvent['action'] | null = null;
    switch (message.event) {
      case 'init':
        this.ready = true;
        this.status = 'ready';
        return;
      case 'play':
      case 'userplay':
        this.status = 'playing';
        action = 'play';
        break;
      case 'pause':
      case 'userpause':
        this.status = 'paused';
        action = 'pause';
        break;
      case 'seek':
      case 'userseek':
        if (Number.isFinite(Number(data))) this.position = Number(data);
        action = 'seek';
        break;
      case 'time':
        if (Number.isFinite(Number(data))) this.position = Number(data);
        return;
      case 'duration':
        if (Number.isFinite(Number(data))) this.duration = Number(data);
        return;
      case 'buffering':
        this.status = 'buffering';
        action = 'buffering';
        break;
      case 'buffered':
        this.status = 'playing';
        action = 'play';
        break;
      case 'new':
        this.status = 'loading';
        action = 'replace';
        break;
      case 'end':
      case 'finish':
        this.status = 'ended';
        action = 'ended';
        break;
      default:
        return;
    }
    const snapshot: PlayerSnapshot = {
      source: this.source(),
      position: this.position,
      status: this.status,
      duration: this.duration,
    };
    for (const listener of this.listeners) listener({ ...snapshot, action });
  };
}
