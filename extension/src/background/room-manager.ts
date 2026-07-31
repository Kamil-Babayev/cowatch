import { connectToRoom, type RoomConnection } from './ws-client.ts';
import type {
  Message,
  PresencePayload,
  PlaybackPayload,
  PlayerCommandPayload,
  PlayerHeartbeatPayload,
  PlayerStatePayload,
  RoomClosedPayload,
  SessionPayload,
  StateResponsePayload,
} from '../shared/messages.ts';
import { computeJoinSeekTarget } from '../shared/sync-math.ts';
import type { PlaybackEvent } from '../content/playback-events.ts';
import type { AuthoritativePlayerState, PlayerEvent, PlayerSnapshot } from '../shared/player.ts';
import { playableStatus } from '../shared/player.ts';

export type RoomConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

export interface RoomManagerCallbacks {
  onRemotePlayback: (event: PlaybackEvent) => void;
  onAuthoritativeState: (
    state: PlaybackPayload,
    source: 'join' | 'control-denied',
  ) => void;
  onTimeSync: (state: PlaybackPayload, timestamp: number) => void;
  onPlayerState: (state: AuthoritativePlayerState) => void;
  onControlDenied: (reason: string) => void;
  onPresence: (payload: PresencePayload) => void;
  onSession: (payload: SessionPayload) => void;
  onRoomClosed: (reason: RoomClosedPayload['reason']) => void;
  onConnectionState: (state: RoomConnectionState) => void;
}

interface Session {
  connection: RoomConnection | null;
  roomId: string;
  hostToken: string | undefined;
  isHost: boolean;
  controlMode: 'open' | 'host-only' | null;
  resyncPending: boolean;
  revision: number;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  generation: number;
  closed: boolean;
  callbacks: RoomManagerCallbacks;
}

export interface SessionInfo {
  roomId: string;
  hostToken: string | undefined;
  isHost: boolean;
  controlMode: 'open' | 'host-only' | null;
}

export class RoomManager {
  private sessions = new Map<number, Session>();
  private reconnectDelays: number[];
  private random: () => number;

  constructor(
    reconnectDelays = [1000, 2000, 4000, 8000, 15000],
    random: () => number = Math.random,
  ) {
    this.reconnectDelays = reconnectDelays;
    this.random = random;
  }

  connect(
    tabId: number,
    roomId: string,
    hostToken: string | undefined,
    callbacks: RoomManagerCallbacks,
  ): void {
    this.disconnect(tabId);
    const session: Session = {
      connection: null,
      roomId,
      hostToken,
      isHost: false,
      controlMode: null,
      resyncPending: false,
      revision: 0,
      reconnectAttempt: 0,
      reconnectTimer: null,
      generation: 0,
      closed: false,
      callbacks,
    };
    this.sessions.set(tabId, session);
    this.openConnection(tabId, session);
  }

  getSession(tabId: number): SessionInfo | undefined {
    const session = this.sessions.get(tabId);
    if (!session) return undefined;
    return {
      roomId: session.roomId,
      hostToken: session.hostToken,
      isHost: session.isHost,
      controlMode: session.controlMode,
    };
  }

  disconnect(tabId: number, explicit = false): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.closed = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (explicit && session.connection?.socket.readyState === WebSocket.OPEN) {
      session.connection.socket.send(JSON.stringify({ type: 'leaveRoom', timestamp: Date.now() }));
    }
    session.connection?.close();
    this.sessions.delete(tabId);
  }

  reportLocalEvent(tabId: number, event: PlaybackEvent): void {
    const payload: PlaybackPayload = { currentTime: event.currentTime, isPlaying: event.isPlaying };
    this.send(tabId, { type: event.type, payload, timestamp: Date.now() });
  }

  reportHeartbeat(tabId: number, state: PlaybackPayload): void {
    const session = this.sessions.get(tabId);
    if (!session?.isHost) return;
    this.send(tabId, { type: 'timeSync', payload: state, timestamp: Date.now() });
  }

  reportPlayerEvent(tabId: number, event: PlayerEvent, pageUrl?: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    const source = { ...event.source, pageUrl: pageUrl ?? event.source.pageUrl };
    if (event.action === 'buffering' || event.action === 'ended') {
      if (session.isHost && playableStatus(event.status)) {
        this.reportPlayerHeartbeat(tabId, { ...event, source });
      }
      return;
    }
    const payload: PlayerCommandPayload = {
      commandId: crypto.randomUUID(),
      baseRevision: session.revision,
      action: event.action,
      source,
      position: event.position,
    };
    this.send(tabId, { type: 'playerCommand', payload, timestamp: Date.now() });
  }

  reportPlayerHeartbeat(tabId: number, state: PlayerSnapshot, pageUrl?: string): void {
    const session = this.sessions.get(tabId);
    if (!session?.isHost || !playableStatus(state.status)) return;
    const payload: PlayerHeartbeatPayload = {
      baseRevision: session.revision,
      source: { ...state.source, pageUrl: pageUrl ?? state.source.pageUrl },
      position: state.position,
      status: state.status,
    };
    this.send(tabId, { type: 'playerHeartbeat', payload, timestamp: Date.now() });
  }

  requestState(tabId: number): void {
    this.send(tabId, { type: 'stateRequest', timestamp: Date.now() });
  }

  private send(tabId: number, msg: Partial<Message>): void {
    const socket = this.sessions.get(tabId)?.connection?.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(msg));
  }

  private handleMessage(tabId: number, msg: Message, callbacks: RoomManagerCallbacks): void {
    switch (msg.type) {
      case 'session': {
        const payload = msg.payload as SessionPayload;
        const session = this.sessions.get(tabId);
        if (session) {
          session.isHost = payload.isHost;
          session.controlMode = payload.controlMode;
        }
        callbacks.onSession(payload);
        return;
      }
      case 'presence':
        callbacks.onPresence(msg.payload as PresencePayload);
        return;
      case 'stateResponse': {
        const payload = msg.payload as StateResponsePayload;
        if (payload.revision != null && payload.source && payload.status) {
          const session = this.sessions.get(tabId);
          if (session) session.revision = payload.revision;
          callbacks.onPlayerState({
            revision: payload.revision,
            source: payload.source,
            position: payload.position ?? payload.currentTime,
            status: payload.status,
            timestamp: msg.timestamp,
          });
          return;
        }
        const target = computeJoinSeekTarget(payload.currentTime, payload.isPlaying, msg.timestamp);
        const session = this.sessions.get(tabId);
        const source = session?.resyncPending ? 'control-denied' : 'join';
        if (session) session.resyncPending = false;
        callbacks.onAuthoritativeState(
          { currentTime: target, isPlaying: payload.isPlaying },
          source,
        );
        return;
      }
      case 'playerState': {
        const payload = msg.payload as PlayerStatePayload;
        const session = this.sessions.get(tabId);
        if (!session || payload.revision <= session.revision) return;
        session.revision = payload.revision;
        callbacks.onPlayerState({ ...payload, timestamp: msg.timestamp });
        return;
      }
      case 'controlDenied': {
        const payload = msg.payload as { reason: string };
        const session = this.sessions.get(tabId);
        if (session) session.resyncPending = true;
        callbacks.onControlDenied(payload.reason);
        this.requestState(tabId);
        return;
      }
      case 'timeSync':
        callbacks.onTimeSync(msg.payload as PlaybackPayload, msg.timestamp);
        return;
      case 'roomClosed': {
        const payload = msg.payload as RoomClosedPayload;
        callbacks.onRoomClosed(payload.reason);
        this.disconnect(tabId);
        return;
      }
      case 'play':
      case 'pause':
      case 'seeked': {
        const payload = msg.payload as PlaybackPayload;
        callbacks.onRemotePlayback({
          type: msg.type,
          currentTime: payload.currentTime,
          isPlaying: payload.isPlaying,
        });
        return;
      }
    }
  }

  private openConnection(tabId: number, session: Session): void {
    const generation = ++session.generation;
    session.connection = connectToRoom(
      session.roomId,
      session.hostToken,
      (msg) => {
        const current = this.sessions.get(tabId);
        if (current === session && current.generation === generation) {
          this.handleMessage(tabId, msg, session.callbacks);
        }
      },
      (state) => {
        const current = this.sessions.get(tabId);
        if (current !== session || current.generation !== generation || current.closed) return;
        if (state === 'connected') {
          session.reconnectAttempt = 0;
          session.callbacks.onConnectionState('connected');
          this.requestState(tabId);
          return;
        }
        if (state === 'error') {
          session.callbacks.onConnectionState('error');
          return;
        }
        if (state === 'disconnected') {
          session.callbacks.onConnectionState('disconnected');
          this.scheduleReconnect(tabId, session);
          return;
        }
        session.callbacks.onConnectionState(state);
      },
    );
  }

  private scheduleReconnect(tabId: number, session: Session): void {
    if (session.closed || session.reconnectTimer) return;
    const index = Math.min(session.reconnectAttempt, this.reconnectDelays.length - 1);
    const base = this.reconnectDelays[index] ?? 15000;
    session.reconnectAttempt += 1;
    const delay = Math.round(base * (0.8 + this.random() * 0.4));
    session.callbacks.onConnectionState('reconnecting');
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      if (this.sessions.get(tabId) === session && !session.closed) {
        this.openConnection(tabId, session);
      }
    }, delay);
  }
}
