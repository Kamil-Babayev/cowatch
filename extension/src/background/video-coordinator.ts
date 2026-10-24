import type { ToContentMessage } from '../shared/runtime-messages.ts';
import type {
  FrameVideoStatus,
  VideoCandidate,
  VideoSelection,
  VideoTabStatus,
} from '../shared/video-frames.ts';

export interface FrameDetails {
  frameId: number;
  parentFrameId: number;
}

export interface FrameTabsAPI {
  sendMessage(
    tabId: number,
    message: ToContentMessage,
    options?: { frameId?: number },
  ): Promise<unknown>;
}

export interface WebNavigationAPI {
  getAllFrames(details: { tabId: number }): Promise<FrameDetails[] | null>;
}

export interface VideoCoordinatorOptions {
  now?: () => number;
  /** How long a clearly bigger video must stay bigger before taking over. */
  switchDelayMs?: number;
}

interface SelectionState {
  selection: VideoSelection;
  manual: boolean;
  challenger: { key: string; since: number } | null;
  challengeTimer: ReturnType<typeof setTimeout> | null;
}

export interface DiscoveryResult {
  status: VideoTabStatus;
  selectionChanged: boolean;
}

export type SelectionListener = (tabId: number, selection: VideoSelection | null) => void;

/** A challenger must be this much larger (rendered size) to take over. */
const TAKEOVER_RATIO = 1.5;

function key(selection: VideoSelection): string {
  return `${selection.frameId}:${selection.candidateId}`;
}

function sameSelection(a: VideoSelection | null, b: VideoSelection | null): boolean {
  return (a ? key(a) : null) === (b ? key(b) : null);
}

function renderedArea(candidate: VideoCandidate): number {
  return candidate.width * candidate.height;
}

/**
 * Finds the videos in every frame of a tab and decides which one the room
 * syncs. Selection is sticky: once a video is chosen it stays chosen while
 * it exists, even scrolled out of view, unless another video is clearly
 * bigger for a while — so a muted preview or an ad appearing next to the
 * player never steals the sync.
 */
export class VideoCoordinator {
  private tabs: FrameTabsAPI;
  private navigation: WebNavigationAPI;
  private now: () => number;
  private switchDelayMs: number;
  private selections = new Map<number, SelectionState>();
  private chains = new Map<number, Promise<unknown>>();
  private pendingDiscovery = new Map<number, Promise<DiscoveryResult>>();
  private listener: SelectionListener = () => undefined;

  constructor(tabs: FrameTabsAPI, navigation: WebNavigationAPI, options: VideoCoordinatorOptions = {}) {
    this.tabs = tabs;
    this.navigation = navigation;
    this.now = options.now ?? Date.now;
    this.switchDelayMs = options.switchDelayMs ?? 2000;
  }

  /** Called after every change of a tab's selected video, however caused. */
  onSelectionChanged(listener: SelectionListener): void {
    this.listener = listener;
  }

  getSelection(tabId: number): VideoSelection | null {
    return this.selections.get(tabId)?.selection ?? null;
  }

  isSelected(tabId: number, frameId = 0): boolean {
    return this.getSelection(tabId)?.frameId === frameId;
  }

  /**
   * Re-inspects every frame. Calls arriving while a run is in progress are
   * coalesced into one follow-up run, so a burst of DOM changes across many
   * frames costs two passes, not one per change.
   */
  discover(tabId: number): Promise<DiscoveryResult> {
    const pending = this.pendingDiscovery.get(tabId);
    if (pending) return pending;
    const run = this.exclusive(tabId, () => {
      this.pendingDiscovery.delete(tabId);
      return this.runDiscovery(tabId);
    });
    this.pendingDiscovery.set(tabId, run);
    return run;
  }

  select(tabId: number, selection: VideoSelection): Promise<VideoTabStatus> {
    return this.exclusive(tabId, async () => {
      const discovered = await this.inspect(tabId);
      const candidate = discovered.candidates.find((item) => key(item) === key(selection));
      if (!candidate) throw new Error('The selected video is no longer available');
      const next = { frameId: candidate.frameId, candidateId: candidate.candidateId };
      await this.changeSelection(tabId, next, true);
      return { ...discovered, selected: this.getSelection(tabId), manual: true };
    });
  }

  async clearManualSelection(tabId: number): Promise<DiscoveryResult> {
    await this.exclusive(tabId, async () => {
      const current = this.selections.get(tabId);
      if (current) current.manual = false;
    });
    return this.discover(tabId);
  }

  /**
   * A frame navigated. Candidate ids belong to a document, so a selection
   * in the navigated frame (or anywhere, if the whole page navigated) is
   * stale and must be chosen again once the new document reports in.
   */
  handleNavigation(tabId: number, frameId: number): void {
    const current = this.selections.get(tabId);
    if (!current) return;
    if (frameId !== 0 && current.selection.frameId !== frameId) return;
    this.dropSelection(tabId);
    this.listener(tabId, null);
  }

  async sendToSelected(tabId: number, message: ToContentMessage): Promise<boolean> {
    const selection = this.getSelection(tabId);
    if (!selection) return false;
    try {
      await this.tabs.sendMessage(tabId, message, { frameId: selection.frameId });
      return true;
    } catch {
      // The frame went away between selection and delivery: choose again.
      if (sameSelection(this.getSelection(tabId), selection)) {
        this.dropSelection(tabId);
        this.listener(tabId, null);
      }
      void this.discover(tabId);
      return false;
    }
  }

  async sendToTop(tabId: number, message: ToContentMessage): Promise<void> {
    await this.tabs.sendMessage(tabId, message, { frameId: 0 });
  }

  clear(tabId: number): void {
    this.dropSelection(tabId);
  }

  private exclusive<T>(tabId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(tabId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.chains.set(tabId, next);
    void next.catch(() => undefined).then(() => {
      if (this.chains.get(tabId) === next) this.chains.delete(tabId);
    });
    return next;
  }

  private dropSelection(tabId: number): void {
    const current = this.selections.get(tabId);
    if (current?.challengeTimer) clearTimeout(current.challengeTimer);
    this.selections.delete(tabId);
  }

  private async inspect(tabId: number): Promise<VideoTabStatus> {
    const frames = (await this.navigation.getAllFrames({ tabId })) ?? [];
    const responses = await Promise.all(frames.map(async (frame) => {
      try {
        const status = await this.tabs.sendMessage(
          tabId,
          { kind: 'frameVideoStatusRequest' },
          { frameId: frame.frameId },
        ) as FrameVideoStatus | undefined;
        return status ? { frame, status } : null;
      } catch {
        return null;
      }
    }));

    const responseByFrame = new Map(
      responses
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .map((item) => [item.frame.frameId, item]),
    );
    const candidates: VideoCandidate[] = [];
    for (const item of responseByFrame.values()) {
      for (const candidate of item.status.candidates) {
        // A video is only as visible as the chain of iframes hosting it.
        let effectiveVisibleArea = candidate.visibleArea;
        let current = item.frame;
        const visited = new Set<number>();
        while (current.parentFrameId >= 0 && !visited.has(current.frameId)) {
          visited.add(current.frameId);
          const parent = responseByFrame.get(current.parentFrameId);
          if (!parent) {
            effectiveVisibleArea = 0;
            break;
          }
          const hostFrame = parent.status.childFrames.find((child) => child.frameId === current.frameId);
          effectiveVisibleArea = Math.min(effectiveVisibleArea, hostFrame?.visibleArea ?? 0);
          current = parent.frame;
        }
        candidates.push({
          ...candidate,
          frameId: item.frame.frameId,
          parentFrameId: item.frame.parentFrameId,
          effectiveVisibleArea,
        });
      }
    }
    candidates.sort((a, b) =>
      b.effectiveVisibleArea - a.effectiveVisibleArea
      || renderedArea(b) - renderedArea(a)
      || a.frameId - b.frameId
      || (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0),
    );
    return {
      hasVideo: candidates.length > 0,
      candidates,
      selected: this.getSelection(tabId),
      manual: this.selections.get(tabId)?.manual ?? false,
      unsupportedReason: responses.find((item) => item?.status.unsupportedReason)?.status.unsupportedReason,
    };
  }

  private async runDiscovery(tabId: number): Promise<DiscoveryResult> {
    const status = await this.inspect(tabId);
    const state = this.selections.get(tabId);
    const previous = state?.selection ?? null;
    const current = previous
      ? status.candidates.find((item) => key(item) === key(previous))
      : undefined;
    const best = status.candidates[0];

    let next: VideoCandidate | undefined = best;
    let manual = false;
    if (current && state) {
      if (state.manual) {
        next = current;
        manual = true;
      } else if (renderedArea(current) > 0) {
        next = this.stickyChoice(tabId, state, current, best);
      }
    }

    const nextSelection = next ? { frameId: next.frameId, candidateId: next.candidateId } : null;
    const changed = !sameSelection(previous, nextSelection);
    if (changed) await this.changeSelection(tabId, nextSelection, manual);
    return {
      status: { ...status, selected: this.getSelection(tabId), manual },
      selectionChanged: !sameSelection(previous, this.getSelection(tabId)),
    };
  }

  /** Keeps the current video unless `best` has been clearly bigger for a while. */
  private stickyChoice(
    tabId: number,
    state: SelectionState,
    current: VideoCandidate,
    best: VideoCandidate,
  ): VideoCandidate {
    const challenging = best !== current
      && best.effectiveVisibleArea > 0
      && renderedArea(best) > renderedArea(current) * TAKEOVER_RATIO;
    if (!challenging) {
      if (state.challengeTimer) clearTimeout(state.challengeTimer);
      state.challenger = null;
      state.challengeTimer = null;
      return current;
    }
    const challengerKey = key(best);
    if (state.challenger?.key !== challengerKey) {
      if (state.challengeTimer) clearTimeout(state.challengeTimer);
      state.challenger = { key: challengerKey, since: this.now() };
      // Look again once the delay has passed, even if the page is quiet.
      state.challengeTimer = setTimeout(() => {
        state.challengeTimer = null;
        void this.discover(tabId);
      }, this.switchDelayMs);
      return current;
    }
    return this.now() - state.challenger.since >= this.switchDelayMs ? best : current;
  }

  private async changeSelection(tabId: number, next: VideoSelection | null, manual: boolean): Promise<void> {
    const previous = this.getSelection(tabId);
    if (sameSelection(previous, next)) {
      const state = this.selections.get(tabId);
      if (state) state.manual = manual;
      return;
    }
    if (previous) {
      await this.sendToFrame(tabId, previous.frameId, { kind: 'deactivateVideoCandidate' });
    }
    this.dropSelection(tabId);
    if (next && await this.sendToFrame(tabId, next.frameId, {
      kind: 'activateVideoCandidate',
      candidateId: next.candidateId,
    })) {
      this.selections.set(tabId, { selection: next, manual, challenger: null, challengeTimer: null });
    }
    this.listener(tabId, this.getSelection(tabId));
  }

  private async sendToFrame(tabId: number, frameId: number, message: ToContentMessage): Promise<boolean> {
    try {
      await this.tabs.sendMessage(tabId, message, { frameId });
      return true;
    } catch {
      // Frames can disappear between enumeration and delivery.
      return false;
    }
  }
}
