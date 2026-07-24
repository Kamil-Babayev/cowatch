export interface LocalVideoCandidate {
  candidateId: string;
  width: number;
  height: number;
  visibleArea: number;
  currentTime: number;
  isPlaying: boolean;
}

export interface ChildFrameVisibility {
  frameId: number;
  visibleArea: number;
}

export interface FrameVideoStatus {
  candidates: LocalVideoCandidate[];
  childFrames: ChildFrameVisibility[];
}

export interface VideoCandidate extends LocalVideoCandidate {
  frameId: number;
  parentFrameId: number;
  documentId?: string;
  effectiveVisibleArea: number;
}

export interface VideoSelection {
  frameId: number;
  candidateId: string;
  documentId?: string;
}

export interface VideoTabStatus {
  hasVideo: boolean;
  candidates: VideoCandidate[];
  selected: VideoSelection | null;
}
