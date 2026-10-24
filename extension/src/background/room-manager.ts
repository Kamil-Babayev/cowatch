import { connectToRoom, type RoomConnection } from './ws-client.ts';
import type {
  ClockPongPayload,
  Message,
  PresencePayload,
  PlayerCommandPayload,
  PlayerHeartbeatPayload,
  PlayerStatePayload,
  RoomClosedPayload,
  SessionPayload,
  StateResponsePayload,
} from '../shared/messages.ts';
import { ClockOffset } from '../shared/clock.ts';
import type { AuthoritativePlayerState, PlayerEvent, PlayerSnapshot } from '../shared/player.ts';
import { playableStatus } from '../shared/player.ts';

export type RoomConnectionState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

/**
 * `update`: another participant changed the room. `sync`: the cached state
 * a (re)connecting client asked for. `resync`: the state that follows a
 * rejected local action in a host-only room.
 */
export type PlayerStateCause = 'update' | 'sync' | 'resync';

export interface RoomManagerCallbacks {
  onPlayerState: (state: AuthoritativePlayerState, cause: PlayerStateCause) => void;
  onControlDenied: (reason: string) => void;
  onPresence: (payload: PresencePayload) => void;
  onSession: (payload: SessionPayload) => void;
  onRoomClosed: (reason: RoomClosedPayload['reason'] | 'room-gone') => void;
  onConnectionState: (state: RoomConnectionState) => void;
}

interface Session {
  connection: RoomConnection | null;
  roomId: string;
  hostToken: string | undefined;
  connectionId: string | null;
  isHost: boolean;
  controlMode: 'open' | 'host-only' | null;
  resyncPending: boolean;
  revision: number;
  // Heartbeats refresh a state without bumping its revision, so states
  // with an equal revision are ordered by their server timestamp.
  stateTimestamp: number;
  clock: ClockOffset;
  clockTimer: ReturnType<typeof setInterval> | null;
  pongDeadline: ReturnType<typeof setTimeout> | null;
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

export interface RoomManagerOptions {
  /** Backoff between reconnect attempts; the last entry repeats. */
  reconnectDelays?: number[];
  random?: () => number;
  /** How often to measure clock offset (and check the socket is alive). */
  clockIntervalMs?: number;
  /** A ping unanswered for this long means a dead socket. */
  pongTimeoutMs?: number;
  /** After this many failed reconnects, ask whether the room still exists. */
  roomCheckAfterAttempts?: number;
  /** Resolves false when the server says the room is gone. */
  roomExists?: (roomId: string) => Promise<boolean>;
}

export class RoomManager {
  private sessions = new Map<number, Session>();
  private reconnectDelays: number[];
  private random: () => number;
  private clockIntervalMs: number;
  private pongTimeoutMs: number;
  private roomCheckAfterAttempts: number;
  private roomExists: (roomId: string) => Promise<boolean>;

  constructor(options: RoomManagerOptions = {}) {
    // Capped at 5 s so a host whose network blips gets several attempts in
    // before the server's 30 s host grace period closes the room.
    this.reconnectDelays = options.reconnectDelays ?? [1000, 2000, 4000, 5000];
    this.random = options.random ?? Math.random;
    this.clockIntervalMs = options.clockIntervalMs ?? 15_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.roomCheckAfterAttempts = options.roomCheckAfterAttempts ?? 2;
    this.roomExists = options.roomExists ?? (async () => true);
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
      connectionId: null,
      isHost: false,
      controlMode: null,
      resyncPending: false,
      revision: 0,
      stateTimestamp: 0,
      clock: new ClockOffset(),
      clockTimer: null,
      pongDeadline: null,
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
    this.stopTimers(session);
    if (explicit && session.connection?.socket.readyState === WebSocket.OPEN) {
      session.connection.socket.send(JSON.stringify({ type: 'leaveRoom', timestamp: Date.now() }));
    }
    session.connection?.close();
    this.sessions.delete(tabId);
  }

  /** Closes every session, e.g. when the extension is shutting down. */
  disconnectAll(): void {
    for (const tabId of [...this.sessions.keys()]) this.disconnect(tabId);
  }

  reportPlayerEvent(tabId: number, event: PlayerEvent, pageUrl?: string): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    const source = { ...event.source, pageUrl: pageUrl ?? event.source.pageUrl };
    if (event.action === 'buffering' || event.action === 'status' || event.action === 'ended') {
      if (session.isHost && playableStatus(event.status)) {
        this.reportPlayerHeartbeat(tabId, { ...event, source });
      }
      return;
    }
    // A joiner's player loading new media is not an instruction for the
    // room; the server would only answer it with controlDenied.
    if (event.action === 'replace' && !session.isHost) return;
    const payload: PlayerCommandPayload = {
      commandId: crypto.randomUUID(),
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

  private acceptState(session: Session, revision: number, serverTimestamp: number): boolean {
    if (revision < session.revision) return false;
    if (revision === session.revision && serverTimestamp <= session.stateTimestamp) return false;
    session.revision = revision;
    session.stateTimestamp = serverTimestamp;
    return true;
  }

  private handleMessage(tabId: number, session: Session, msg: Message): void {
    const callbacks = session.callbacks;
    switch (msg.type) {
      case 'session': {
        const payload = msg.payload as SessionPayload;
        session.connectionId = payload.connectionId;
        session.isHost = payload.isHost;
        session.controlMode = payload.controlMode;
        callbacks.onSession(payload);
        return;
      }
      case 'presence':
        callbacks.onPresence(msg.payload as PresencePayload);
        return;
      case 'stateResponse': {
        const payload = msg.payload as StateResponsePayload;
        const cause: PlayerStateCause = session.resyncPending ? 'resync' : 'sync';
        session.resyncPending = false;
        // Always applied, even at an old revision: the client asked for it.
        session.revision = Math.max(session.revision, payload.revision);
        session.stateTimestamp = Math.max(session.stateTimestamp, msg.timestamp);
        callbacks.onPlayerState({
          revision: payload.revision,
          source: payload.source,
          position: payload.position,
          status: payload.status,
          timestamp: session.clock.toLocal(msg.timestamp),
        }, cause);
        return;
      }
      case 'playerState': {
        const payload = msg.payload as PlayerStatePayload;
        if (!this.acceptState(session, payload.revision, msg.timestamp)) return;
        // Our own command: the player is already there, applying it again
        // would only re-seek it by the network delay.
        if (payload.originConnectionId === session.connectionId) return;
        callbacks.onPlayerState({
          revision: payload.revision,
          source: payload.source,
          position: payload.position,
          status: payload.status,
          commandId: payload.commandId,
          timestamp: session.clock.toLocal(msg.timestamp),
        }, 'update');
        return;
      }
      case 'clockPong': {
        const payload = msg.payload as ClockPongPayload;
        if (session.pongDeadline) clearTimeout(session.pongDeadline);
        session.pongDeadline = null;
        session.clock.addSample(payload.t0, payload.serverTime, Date.now());
        return;
      }
      case 'controlDenied': {
        const payload = msg.payload as { reason: string };
        session.resyncPending = true;
        callbacks.onControlDenied(payload.reason);
        this.requestState(tabId);
        return;
      }
      case 'roomClosed': {
        const payload = msg.payload as RoomClosedPayload;
        callbacks.onRoomClosed(payload.reason);
        this.disconnect(tabId);
        return;
      }
    }
  }

  private sendClockPing(tabId: number, session: Session): void {
    this.send(tabId, { type: 'clockPing', payload: { t0: Date.now() }, timestamp: Date.now() });
    if (session.pongDeadline) return;
    session.pongDeadline = setTimeout(() => {
      session.pongDeadline = null;
      // No answer: the socket is dead without the browser noticing yet
      // (a silent network drop can take minutes to surface as a close).
      session.connection?.close();
    }, this.pongTimeoutMs);
  }

  private stopTimers(session: Session): void {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.clockTimer) clearInterval(session.clockTimer);
    if (session.pongDeadline) clearTimeout(session.pongDeadline);
    session.reconnectTimer = null;
    session.clockTimer = null;
    session.pongDeadline = null;
  }

  private openConnection(tabId: number, session: Session): void {
    const generation = ++session.generation;
    const current = () => {
      const active = this.sessions.get(tabId);
      return active === session && session.generation === generation && !session.closed;
    };
    session.connection = connectToRoom(
      session.roomId,
      session.hostToken,
      (msg) => {
        if (current()) this.handleMessage(tabId, session, msg);
      },
      (state) => {
        if (!current()) return;
        if (state === 'connected') {
          session.reconnectAttempt = 0;
          session.callbacks.onConnectionState('connected');
          this.requestState(tabId);
          this.sendClockPing(tabId, session);
          session.clockTimer = setInterval(() => this.sendClockPing(tabId, session), this.clockIntervalMs);
          return;
        }
        if (state === 'error') {
          session.callbacks.onConnectionState('error');
          return;
        }
        if (state === 'disconnected') {
          this.stopTimers(session);
          session.callbacks.onConnectionState('disconnected');
          void this.scheduleReconnect(tabId, session);
          return;
        }
        session.callbacks.onConnectionState(state);
      },
    );
  }

  private async scheduleReconnect(tabId: number, session: Session): Promise<void> {
    if (session.closed || session.reconnectTimer) return;
    if (session.reconnectAttempt >= this.roomCheckAfterAttempts) {
      let exists = true;
      try {
        exists = await this.roomExists(session.roomId);
      } catch {
        // Network trouble: unknown, keep retrying.
      }
      if (this.sessions.get(tabId) !== session || session.closed) return;
      if (!exists) {
        session.callbacks.onRoomClosed('room-gone');
        this.disconnect(tabId);
        return;
      }
    }
    const index = Math.min(session.reconnectAttempt, this.reconnectDelays.length - 1);
    const base = this.reconnectDelays[index] ?? 5000;
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
