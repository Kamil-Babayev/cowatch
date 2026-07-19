// Mirrors the server's internal/ws/message.go — kept in lockstep with it.
// If the server's message.go gains/changes a type, this file needs the
// same edit, or the two sides will silently disagree about the wire format.

export type MessageType =
  | 'presence'
  | 'play'
  | 'pause'
  | 'seeked'
  | 'timeSync'
  | 'stateRequest'
  | 'stateResponse'
  | 'controlDenied';

export interface Message<T = unknown> {
  type: MessageType;
  payload?: T;
  timestamp: number;
}

export interface PresenceEntry {
  connId: string;
  isHost: boolean;
}

export interface PresencePayload {
  connections: PresenceEntry[];
}

export interface PlaybackPayload {
  currentTime: number;
  isPlaying: boolean;
}

export interface StateResponsePayload {
  currentTime: number;
  isPlaying: boolean;
}

export interface ControlDeniedPayload {
  reason: string;
}
