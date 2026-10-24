// Mirrors the server's internal/ws/message.go — kept in lockstep with it.
// If the server's message.go gains/changes a type, this file needs the
// same edit, or the two sides will silently disagree about the wire format.

import type { MediaSource } from './player.ts';

export type MessageType =
  | 'session'
  | 'presence'
  | 'playerCommand'
  | 'playerHeartbeat'
  | 'playerState'
  | 'stateRequest'
  | 'stateResponse'
  | 'clockPing'
  | 'clockPong'
  | 'controlDenied'
  | 'leaveRoom'
  | 'roomClosed';

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

export interface SessionPayload {
  connectionId: string;
  isHost: boolean;
  controlMode: 'open' | 'host-only';
}

export type RoomPlayerStatus = 'playing' | 'paused' | 'buffering' | 'ended';

/** Cached room state; the envelope timestamp is when it was true. */
export interface StateResponsePayload {
  revision: number;
  source: MediaSource;
  position: number;
  status: RoomPlayerStatus;
}

export interface PlayerCommandPayload {
  commandId: string;
  action: 'play' | 'pause' | 'seek' | 'replace';
  source: MediaSource;
  position: number;
}

export interface PlayerHeartbeatPayload {
  baseRevision: number;
  source: MediaSource;
  position: number;
  status: RoomPlayerStatus;
}

export interface PlayerStatePayload {
  revision: number;
  source: MediaSource;
  position: number;
  status: RoomPlayerStatus;
  commandId?: string;
  originConnectionId: string;
}

export interface ClockPingPayload {
  t0: number;
}

export interface ClockPongPayload {
  t0: number;
  serverTime: number;
}

export interface ControlDeniedPayload {
  reason: string;
}

export interface RoomClosedPayload {
  reason: 'host-left' | 'server-shutdown';
}
