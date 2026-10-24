import { elementVisibleArea, scanMedia, touchesMedia } from './media-scan.ts';
import { NativePlayerAdapter } from './native-player-adapter.ts';
import { isObrutPlayerFrame, PlayerJSAdapter } from './playerjs-adapter.ts';
import type { SessionPayload } from '../shared/messages.ts';
import type { ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';
import type { ChildFrameVisibility, FrameVideoStatus, LocalVideoCandidate } from '../shared/video-frames.ts';
import { debugLog } from '../shared/config.ts';
import type { AuthoritativePlayerState, PlayerAdapter, PlayerSnapshot } from '../shared/player.ts';
import { playableStatus } from '../shared/player.ts';

/** The extension APIs a frame agent needs, injected so tests can fake them. */
export interface FrameRuntime {
  sendMessage(message: ToBackgroundMessage): Promise<unknown>;
  /** Firefox's runtime.getFrameId; throws for frames it cannot identify. */
  getFrameId(target: Window): number;
}

export interface AdapterFactory {
  native(id: string, video: HTMLVideoElement): PlayerAdapter;
  obrut(id: string, iframe: HTMLIFrameElement): PlayerAdapter;
  isObrutFrame(iframe: HTMLIFrameElement): boolean;
}

export const defaultAdapters: AdapterFactory = {
  native: (id, video) => new NativePlayerAdapter(id, video),
  obrut: (id, iframe) => new PlayerJSAdapter(id, iframe),
  isObrutFrame: isObrutPlayerFrame,
};

export interface FrameAgentOptions {
  heartbeatMs?: number;
  /** Quiet period before a burst of DOM changes is reported... */
  debounceMs?: number;
  /** ...but never later than this after the first change. */
  maxWaitMs?: number;
  /** A player slower than this to report its state uses its last one. */
  stateTimeoutMs?: number;
  /** How long a status request waits for players that are still probing. */
  probeGraceMs?: number;
  newDocumentPrefix?: () => string;
}

interface AdapterRecord {
  adapter: PlayerAdapter;
  element: HTMLVideoElement | HTMLIFrameElement;
  abort: AbortController;
  probe: 'pending' | 'ready' | 'failed';
  probing: Promise<unknown>;
  probeError?: string;
  lastSnapshot?: PlayerSnapshot;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Runs in every frame. Finds the players in its own document (shadow DOM
 * included), reports them to the background, and — when the background
 * selects one of them — forwards its events and applies the room's state.
 */
export class FrameAgent {
  private window: Window;
  private runtime: FrameRuntime;
  private adapters: AdapterFactory;
  private heartbeatMs: number;
  private debounceMs: number;
  private maxWaitMs: number;
  private stateTimeoutMs: number;
  private probeGraceMs: number;
  private newDocumentPrefix: () => string;

  private prefix = '';
  private nextId = 1;
  private elementIds = new WeakMap<Element, string>();
  private records = new Map<string, AdapterRecord>();
  private activeId: string | null = null;
  private detachListener: (() => void) | null = null;
  private session: SessionPayload | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private firstChangeAt: number | null = null;
  private pendingState: AuthoritativePlayerState | null = null;
  private applying = false;
  private mutations: MutationObserver | null = null;
  private visibility: IntersectionObserver | null = null;
  private resizes: ResizeObserver | null = null;
  private observedRoots = new WeakSet<Node>();
  private observedElements = new WeakSet<Element>();
  private running = false;

  constructor(win: Window, runtime: FrameRuntime, adapters: AdapterFactory = defaultAdapters, options: FrameAgentOptions = {}) {
    this.window = win;
    this.runtime = runtime;
    this.adapters = adapters;
    this.heartbeatMs = options.heartbeatMs ?? 5000;
    this.debounceMs = options.debounceMs ?? 200;
    this.maxWaitMs = options.maxWaitMs ?? 1000;
    this.stateTimeoutMs = options.stateTimeoutMs ?? 500;
    this.probeGraceMs = options.probeGraceMs ?? 100;
    this.newDocumentPrefix = options.newDocumentPrefix ?? (() => crypto.randomUUID().slice(0, 8));
  }

  private get document(): Document {
    return this.window.document;
  }

  init(): void {
    if (this.running) return;
    this.running = true;
    // A new prefix per document lifetime (including a back/forward cache
    // restore): the background must never confuse a new page's players
    // with the old page's, even when the frame id is the same.
    this.prefix = this.newDocumentPrefix();
    this.nextId = 1;
    this.elementIds = new WeakMap();
    this.observedRoots = new WeakSet();
    this.observedElements = new WeakSet();

    const Mutation = (this.window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
    this.mutations = new Mutation((mutations) => this.onMutations(mutations));
    this.observeRoot(this.document.documentElement);
    const Intersection = (this.window as unknown as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
    this.visibility = Intersection
      ? new Intersection(() => this.scheduleScan(), { threshold: [0, 0.25, 0.5, 0.75, 1] })
      : null;
    const Resize = (this.window as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    this.resizes = Resize ? new Resize(() => this.scheduleScan()) : null;
    this.document.addEventListener('fullscreenchange', this.onLayoutChange);
    this.window.addEventListener('resize', this.onLayoutChange);
    this.scheduleScan();
  }

  dispose(): void {
    if (!this.running) return;
    this.running = false;
    this.mutations?.disconnect();
    this.visibility?.disconnect();
    this.resizes?.disconnect();
    this.mutations = null;
    this.visibility = null;
    this.resizes = null;
    this.document.removeEventListener('fullscreenchange', this.onLayoutChange);
    this.window.removeEventListener('resize', this.onLayoutChange);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    this.firstChangeAt = null;
    this.deactivate();
    for (const record of this.records.values()) this.disposeRecord(record);
    this.records.clear();
    this.pendingState = null;
  }

  handleMessage(msg: ToContentMessage): Promise<unknown> | undefined {
    switch (msg.kind) {
      case 'frameVideoStatusRequest':
        return this.frameStatus();
      case 'activateVideoCandidate':
        this.reconcile();
        this.activate(msg.candidateId);
        return undefined;
      case 'deactivateVideoCandidate':
        this.deactivate();
        return undefined;
      case 'applyPlayerState':
        void this.applyState(msg.state);
        return undefined;
      case 'sessionInfo':
        this.session = msg.payload;
        this.restartHeartbeat();
        return undefined;
      default:
        return undefined;
    }
  }

  private onLayoutChange = (): void => this.scheduleScan();

  private send(message: ToBackgroundMessage): void {
    void this.runtime.sendMessage(message).catch(() => undefined);
  }

  private idFor(element: Element, kind: string): string {
    let id = this.elementIds.get(element);
    if (!id) {
      id = `${this.prefix}-${kind}-${this.nextId++}`;
      this.elementIds.set(element, id);
    }
    return id;
  }

  private pageIsObrut(): boolean {
    const host = this.window.location.hostname;
    return host === 'obrut.show' || host.endsWith('.obrut.show');
  }

  private observeRoot(root: Node): void {
    if (!this.mutations || this.observedRoots.has(root)) return;
    this.observedRoots.add(root);
    this.mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  }

  private observeElement(element: Element): void {
    if (this.observedElements.has(element)) return;
    this.observedElements.add(element);
    this.visibility?.observe(element);
    this.resizes?.observe(element);
  }

  private onMutations(mutations: MutationRecord[]): void {
    let relevant = false;
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        relevant = true;
        const target = mutation.target as Element;
        if (target.localName !== 'iframe') continue;
        const previousId = this.elementIds.get(target);
        const record = previousId ? this.records.get(previousId) : undefined;
        if (!record || record.adapter.expectsSource?.((target as HTMLIFrameElement).src)) continue;
        // The page loaded something else into this frame: a new player.
        this.removeRecord(previousId!, record);
        this.elementIds.delete(target);
        continue;
      }
      if (relevant) continue;
      for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        if (touchesMedia(node)) {
          relevant = true;
          break;
        }
      }
    }
    if (relevant) this.scheduleScan();
  }

  private scheduleScan(): void {
    if (!this.running) return;
    const now = Date.now();
    this.firstChangeAt ??= now;
    const remaining = this.maxWaitMs - (now - this.firstChangeAt);
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.firstChangeAt = null;
      this.reconcile();
      this.send({ kind: 'frameVideoCandidatesChanged' });
    }, Math.max(0, Math.min(this.debounceMs, remaining)));
  }

  private reconcile(): void {
    if (!this.running) return;
    const scan = scanMedia(this.document);
    for (const root of scan.shadowRoots) this.observeRoot(root);
    for (const iframe of scan.iframes) this.observeElement(iframe);

    const live = new Set<string>();
    const track = (element: HTMLVideoElement | HTMLIFrameElement, id: string, create: () => PlayerAdapter) => {
      live.add(id);
      this.observeElement(element);
      if (!this.records.has(id)) this.startRecord(id, element, create());
    };
    if (!this.pageIsObrut()) {
      // Inside an obrut frame its parent controls the player via PlayerJS;
      // listing the raw <video> too would offer the same player twice.
      for (const video of scan.videos) {
        const id = this.idFor(video, 'video');
        track(video, id, () => this.adapters.native(id, video));
      }
    }
    for (const iframe of scan.iframes) {
      if (!this.adapters.isObrutFrame(iframe)) continue;
      const id = this.idFor(iframe, 'obrut');
      track(iframe, id, () => this.adapters.obrut(id, iframe));
    }
    for (const [id, record] of this.records) {
      if (!live.has(id) || !record.element.isConnected) this.removeRecord(id, record);
    }
  }

  private startRecord(id: string, element: AdapterRecord['element'], adapter: PlayerAdapter): void {
    const abort = new AbortController();
    debugLog('probing player adapter', { candidateId: id, provider: adapter.provider });
    // Probing can take seconds (an embedded player still booting); a status
    // request waits only briefly for it, and a later result arrives as a
    // change.
    const record: AdapterRecord = { adapter, element, abort, probe: 'pending', probing: Promise.resolve() };
    this.records.set(id, record);
    record.probing = adapter.probe(abort.signal).then(
      () => {
        if (this.records.get(id) !== record) return;
        record.probe = 'ready';
        if (this.activeId === id) this.attachListener(record);
        this.scheduleScan();
      },
      (error: Error) => {
        if (this.records.get(id) !== record || error.name === 'AbortError') return;
        record.probe = 'failed';
        record.probeError = adapter.provider === 'obrut'
          ? 'This embedded player does not expose synchronization controls.'
          : 'The video player is not ready for synchronization.';
        debugLog('player adapter probe failed', { candidateId: id, error: error.message });
        this.send({ kind: 'playerAdapterStatus', status: 'unsupported', message: record.probeError });
        this.scheduleScan();
      },
    );
  }

  private removeRecord(id: string, record: AdapterRecord): void {
    if (this.activeId === id) this.deactivate();
    this.disposeRecord(record);
    this.records.delete(id);
  }

  private disposeRecord(record: AdapterRecord): void {
    record.abort.abort();
    record.adapter.dispose();
  }

  private async snapshot(record: AdapterRecord): Promise<PlayerSnapshot | undefined> {
    try {
      record.lastSnapshot = await withTimeout(record.adapter.getState(), this.stateTimeoutMs);
    } catch {
      // A hung player keeps its last known state rather than hiding.
    }
    return record.lastSnapshot;
  }

  private async frameStatus(): Promise<FrameVideoStatus> {
    this.reconcile();
    const probing = [...this.records.values()].filter((record) => record.probe === 'pending');
    if (probing.length > 0) {
      await Promise.race([
        Promise.allSettled(probing.map((record) => record.probing)),
        new Promise((resolve) => setTimeout(resolve, this.probeGraceMs)),
      ]);
    }
    const childFrames: ChildFrameVisibility[] = [];
    for (const iframe of scanMedia(this.document).iframes) {
      try {
        if (!iframe.contentWindow) continue;
        childFrames.push({ frameId: this.runtime.getFrameId(iframe.contentWindow), visibleArea: elementVisibleArea(iframe) });
      } catch {
        // Not a frame the extension can address.
      }
    }
    const ready = [...this.records.entries()].filter(([, record]) => record.probe === 'ready');
    const settled = await Promise.allSettled(ready.map(async ([candidateId, record]): Promise<LocalVideoCandidate | null> => {
      const state = await this.snapshot(record);
      const rect = record.element.getBoundingClientRect();
      return {
        candidateId,
        width: rect.width,
        height: rect.height,
        visibleArea: elementVisibleArea(record.element),
        currentTime: state?.position ?? 0,
        isPlaying: state?.status === 'playing',
        provider: record.adapter.provider,
        playerStatus: state?.status,
      };
    }));
    const candidates = settled.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value] : []));
    const unsupportedReason = ready.length === 0
      ? [...this.records.values()].find((record) => record.probeError)?.probeError
      : undefined;
    return { candidates, childFrames, unsupportedReason };
  }

  private attachListener(record: AdapterRecord): void {
    this.detachListener?.();
    this.detachListener = record.adapter.subscribe((event) => this.send({ kind: 'localPlayerEvent', event }));
    this.restartHeartbeat();
  }

  private activate(candidateId: string): void {
    this.deactivate();
    const record = this.records.get(candidateId);
    if (!record) return;
    this.activeId = candidateId;
    if (record.probe === 'ready') this.attachListener(record);
  }

  private deactivate(): void {
    this.detachListener?.();
    this.detachListener = null;
    this.activeId = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private activeRecord(): AdapterRecord | null {
    const record = this.activeId ? this.records.get(this.activeId) : undefined;
    return record?.probe === 'ready' ? record : null;
  }

  /** Applies room states one at a time; only the newest waiting one runs. */
  private async applyState(state: AuthoritativePlayerState): Promise<void> {
    this.pendingState = state;
    if (this.applying) return;
    this.applying = true;
    try {
      while (this.pendingState) {
        const next = this.pendingState;
        this.pendingState = null;
        const record = this.activeRecord();
        if (!record) continue;
        try {
          await record.adapter.apply(next);
        } catch (error) {
          this.send({ kind: 'playbackApplyFailed' });
          debugLog('applying room state failed', { error: (error as Error).message });
        }
      }
    } finally {
      this.applying = false;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.session?.isHost) return;
    const record = this.activeRecord();
    if (!record) return;
    const state = await this.snapshot(record);
    if (state && playableStatus(state.status)) this.send({ kind: 'playerHeartbeat', state });
  }

  private restartHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (!this.session?.isHost || !this.activeRecord()) return;
    void this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.sendHeartbeat(), this.heartbeatMs);
  }
}
