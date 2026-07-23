import { connectToRoom, type RoomConnection } from './ws-client.ts';
import type {
  Message,
  PresencePayload,
  PlaybackPayload,
  RoomClosedPayload,
  SessionPayload,
  StateResponsePayload,
} from '../shared/messages.ts';
import { computeJoinSeekTarget } from '../shared/sync-math.ts';
import type { PlaybackEvent } from '../content/playback-events.ts';

export interface RoomManagerCallbacks {
  /** A remote play/pause/seeked to apply to this tab's video element. */
  onRemotePlayback: (event: PlaybackEvent) => void;
  onAuthoritativeState: (
    state: PlaybackPayload,
    source: 'join' | 'control-denied',
  ) => void;
  onTimeSync: (state: PlaybackPayload, timestamp: number) => void;
  /** US-1.9's rejection message reaching this tab. */
  onControlDenied: (reason: string) => void;
  onPresence: (payload: PresencePayload) => void;
  onSession: (payload: SessionPayload) => void;
  onRoomClosed: (reason: RoomClosedPayload['reason']) => void;
  onConnectionState: (
    state: 'connecting' | 'connected' | 'disconnected' | 'error',
  ) => void;
}

interface Session {
  connection: RoomConnection;
  roomId: string;
  hostToken: string | undefined;
  isHost: boolean;
  controlMode: 'open' | 'host-only' | null;
  resyncPending: boolean;
}

export interface SessionInfo {
  roomId: string;
  hostToken: string | undefined;
  isHost: boolean;
  controlMode: 'open' | 'host-only' | null;
}

// No TS constructor parameter-property shorthand — see video-detector.ts's
// comment on why (Node's --experimental-strip-types can't transform it).
export class RoomManager {
  private sessions: Map<number, Session> = new Map();

  connect(
    tabId: number,
    roomId: string,
    hostToken: string | undefined,
    callbacks: RoomManagerCallbacks,
  ): void {
    this.disconnect(tabId); // idempotent — replaces any existing session for this tab

    let connection: RoomConnection;
    connection = connectToRoom(
      roomId,
      hostToken,
      (msg) => this.handleMessage(tabId, msg, callbacks),
      (state) => {
        callbacks.onConnectionState(state);
        if (state === 'disconnected') {
          const current = this.sessions.get(tabId);
          if (current?.connection === connection) {
            this.sessions.delete(tabId);
          }
        }
      },
    );

    const session: Session = {
      connection,
      roomId,
      hostToken,
      isHost: false,
      controlMode: null,
      resyncPending: false,
    };
    this.sessions.set(tabId, session);

    // Must wait for the socket to actually be open — sending while still
    // CONNECTING throws. connectToRoom's own 'open' listener (for its
    // console log) fires independently of this one; both are allowed.
    connection.socket.addEventListener('open', () => {
      this.send(tabId, { type: 'stateRequest', timestamp: Date.now() });
    });
  }

  /** US-3.2: lets the message router look up a tab's roomId/hostToken for the fresh-link round trip. */
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

  disconnect(tabId: number): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.connection.close();
    this.sessions.delete(tabId);
  }

  /** Called by content/index.ts whenever a local play/pause/seeked fires. */
  reportLocalEvent(tabId: number, event: PlaybackEvent): void {
    const session = this.sessions.get(tabId);
    if (!session) return;

    const payload: PlaybackPayload = { currentTime: event.currentTime, isPlaying: event.isPlaying };
    this.send(tabId, { type: event.type, payload, timestamp: Date.now() });
  }

  reportHeartbeat(tabId: number, state: PlaybackPayload): void {
    const session = this.sessions.get(tabId);
    if (!session || !session.isHost) return;
    this.send(tabId, { type: 'timeSync', payload: state, timestamp: Date.now() });
  }

  private send(tabId: number, msg: Partial<Message>): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.connection.socket.readyState !== WebSocket.OPEN) return;
    session.connection.socket.send(JSON.stringify(msg));
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

      case 'controlDenied': {
        const payload = msg.payload as { reason: string };
        const session = this.sessions.get(tabId);
        if (session) session.resyncPending = true;
        callbacks.onControlDenied(payload.reason);
        this.send(tabId, { type: 'stateRequest', timestamp: Date.now() });
        return;
      }

      case 'timeSync': {
        const payload = msg.payload as PlaybackPayload;
        callbacks.onTimeSync(payload, msg.timestamp);
        return;
      }

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

      default:
        console.log('[CoWatch] room-manager: unhandled message type', msg.type);
    }
  }
}
