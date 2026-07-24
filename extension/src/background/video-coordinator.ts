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
  documentId?: string;
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

interface SelectionState {
  selection: VideoSelection;
  manual: boolean;
}

export interface DiscoveryResult {
  status: VideoTabStatus;
  selectionChanged: boolean;
}

function sameSelection(a: VideoSelection | null, b: VideoSelection | null): boolean {
  return a?.frameId === b?.frameId
    && a?.candidateId === b?.candidateId
    && a?.documentId === b?.documentId;
}

export class VideoCoordinator {
  private tabs: FrameTabsAPI;
  private navigation: WebNavigationAPI;
  private selections = new Map<number, SelectionState>();
  private documentIds = new Map<number, Map<number, string>>();

  constructor(tabs: FrameTabsAPI, navigation: WebNavigationAPI) {
    this.tabs = tabs;
    this.navigation = navigation;
  }

  noteDocument(tabId: number, frameId: number, documentId?: string): void {
    if (!documentId) return;
    let byFrame = this.documentIds.get(tabId);
    if (!byFrame) {
      byFrame = new Map();
      this.documentIds.set(tabId, byFrame);
    }
    byFrame.set(frameId, documentId);
  }

  getSelection(tabId: number): VideoSelection | null {
    return this.selections.get(tabId)?.selection ?? null;
  }

  isSelected(tabId: number, frameId = 0, documentId?: string): boolean {
    const selected = this.getSelection(tabId);
    if (!selected || selected.frameId !== frameId) return false;
    return !selected.documentId || !documentId || selected.documentId === documentId;
  }

  async discover(tabId: number): Promise<DiscoveryResult> {
    const frames = (await this.navigation.getAllFrames({ tabId })) ?? [];
    const responses = await Promise.all(frames.map(async (frame) => {
      try {
        const status = await this.tabs.sendMessage(
          tabId,
          { kind: 'frameVideoStatusRequest' },
          { frameId: frame.frameId },
        ) as FrameVideoStatus;
        return { frame, status };
      } catch {
        return null;
      }
    }));

    const responseByFrame = new Map(
      responses
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .map((item) => [item.frame.frameId, item]),
    );
    const liveCandidates: VideoCandidate[] = [];

    for (const item of responseByFrame.values()) {
      for (const candidate of item.status.candidates) {
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
          const hostFrame = parent.status.childFrames.find(
            (child) => child.frameId === current.frameId,
          );
          effectiveVisibleArea = Math.min(
            effectiveVisibleArea,
            hostFrame?.visibleArea ?? 0,
          );
          current = parent.frame;
        }
        const rememberedDocumentId =
          this.documentIds.get(tabId)?.get(item.frame.frameId);
        liveCandidates.push({
          ...candidate,
          frameId: item.frame.frameId,
          parentFrameId: item.frame.parentFrameId,
          documentId: item.frame.documentId ?? rememberedDocumentId,
          effectiveVisibleArea,
        });
      }
    }

    liveCandidates.sort((a, b) =>
      b.effectiveVisibleArea - a.effectiveVisibleArea
      || b.visibleArea - a.visibleArea
      || a.frameId - b.frameId,
    );

    const previousState = this.selections.get(tabId);
    const previous = previousState?.selection ?? null;
    const preservedManual = previousState?.manual
      ? liveCandidates.find((candidate) =>
          candidate.frameId === previous?.frameId
          && candidate.candidateId === previous?.candidateId
          && (!previous.documentId || candidate.documentId === previous.documentId))
      : undefined;
    const chosen = preservedManual ?? liveCandidates[0];
    const next = chosen
      ? {
          frameId: chosen.frameId,
          candidateId: chosen.candidateId,
          documentId: chosen.documentId,
        }
      : null;

    if (!sameSelection(previous, next)) {
      if (previous) {
        await this.sendToFrame(tabId, previous.frameId, { kind: 'deactivateVideoCandidate' });
      }
      if (next) {
        await this.sendToFrame(tabId, next.frameId, {
          kind: 'activateVideoCandidate',
          candidateId: next.candidateId,
        });
        this.selections.set(tabId, {
          selection: next,
          manual: Boolean(preservedManual),
        });
      } else {
        this.selections.delete(tabId);
      }
    }

    return {
      status: { hasVideo: liveCandidates.length > 0, candidates: liveCandidates, selected: next },
      selectionChanged: !sameSelection(previous, next),
    };
  }

  async select(tabId: number, selection: VideoSelection): Promise<VideoTabStatus> {
    const discovered = await this.discover(tabId);
    const candidate = discovered.status.candidates.find((item) =>
      item.frameId === selection.frameId
      && item.candidateId === selection.candidateId
      && (!selection.documentId || item.documentId === selection.documentId));
    if (!candidate) throw new Error('The selected video is no longer available');

    const previous = this.getSelection(tabId);
    const next: VideoSelection = {
      frameId: candidate.frameId,
      candidateId: candidate.candidateId,
      documentId: candidate.documentId,
    };
    if (!sameSelection(previous, next)) {
      if (previous) {
        await this.sendToFrame(tabId, previous.frameId, { kind: 'deactivateVideoCandidate' });
      }
      await this.sendToFrame(tabId, next.frameId, {
        kind: 'activateVideoCandidate',
        candidateId: next.candidateId,
      });
    }
    this.selections.set(tabId, { selection: next, manual: true });
    return { ...discovered.status, selected: next };
  }

  async clearManualSelection(tabId: number): Promise<DiscoveryResult> {
    const current = this.selections.get(tabId);
    if (current) current.manual = false;
    return this.discover(tabId);
  }

  async sendToSelected(tabId: number, message: ToContentMessage): Promise<boolean> {
    const selection = this.getSelection(tabId);
    if (!selection) return false;
    try {
      await this.tabs.sendMessage(tabId, message, { frameId: selection.frameId });
      return true;
    } catch {
      this.selections.delete(tabId);
      return false;
    }
  }

  async sendToTop(tabId: number, message: ToContentMessage): Promise<void> {
    await this.tabs.sendMessage(tabId, message, { frameId: 0 });
  }

  clear(tabId: number): void {
    this.selections.delete(tabId);
    this.documentIds.delete(tabId);
  }

  private async sendToFrame(
    tabId: number,
    frameId: number,
    message: ToContentMessage,
  ): Promise<void> {
    try {
      await this.tabs.sendMessage(tabId, message, { frameId });
    } catch {
      // Frames can disappear between enumeration and delivery.
    }
  }
}
