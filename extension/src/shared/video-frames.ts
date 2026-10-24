export interface LocalVideoCandidate {
  /** Unique per document: a reloaded page never reuses an old id. */
  candidateId: string;
  width: number;
  height: number;
  visibleArea: number;
  currentTime: number;
  isPlaying: boolean;
  provider?: 'native' | 'obrut';
  playerStatus?: string;
}

export interface ChildFrameVisibility {
  frameId: number;
  visibleArea: number;
}

export interface FrameVideoStatus {
  candidates: LocalVideoCandidate[];
  childFrames: ChildFrameVisibility[];
  unsupportedReason?: string;
}

export interface VideoCandidate extends LocalVideoCandidate {
  frameId: number;
  parentFrameId: number;
  effectiveVisibleArea: number;
}

export interface VideoSelection {
  frameId: number;
  candidateId: string;
}

export interface VideoTabStatus {
  hasVideo: boolean;
  candidates: VideoCandidate[];
  selected: VideoSelection | null;
  /** True when the user picked the video rather than automatic selection. */
  manual?: boolean;
  unsupportedReason?: string;
}
