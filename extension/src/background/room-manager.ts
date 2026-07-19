import { connectToRoom, type RoomConnection } from './ws-client.ts';
import type { Message, PresencePayload, PlaybackPayload, StateResponsePayload } from '../shared/messages.ts';
import { shouldCorrectDrift, computeJoinSeekTarget } from '../shared/sync-math.ts';
import type { PlaybackEvent } from '../content/playback-events.ts';

const TIME_SYNC_INTERVAL_MS = 5000;
const DRIFT_THRESHOLD_SECONDS = 1.5;

export interface RoomManagerCallbacks {
  /** A remote play/pause/seeked to apply to this tab's video element. */
  onRemotePlayback: (event: PlaybackEvent) => void;
  /** US-2.8: seek to this position once, right after joining. */
  onJoinSeek: (targetSeconds: number) => void;
  /** US-1.9's rejection message reaching this tab. */
  onControlDenied: (reason: string) => void;
  onPresence: (payload: PresencePayload) => void;
}

interface Session {
  connection: RoomConnection;
  isHost: boolean;
  timeSyncTimer: ReturnType<typeof setInterval> | null;
  // The most recent local currentTime/isPlaying this tab reported — used
  // as the payload for the host's periodic timeSync heartbeat, so the
  // heartbeat always reflects genuinely current state rather than a stale
  // snapshot from whenever the room was first joined.
  lastLocalState: { currentTime: number; isPlaying: boolean } | null;
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

    const isHost = Boolean(hostToken);
    const connection = connectToRoom(roomId, hostToken, (msg) =>
      this.handleMessage(tabId, msg, callbacks),
    );

    const session: Session = { connection, isHost, timeSyncTimer: null, lastLocalState: null };
    this.sessions.set(tabId, session);

    // Must wait for the socket to actually be open — sending while still
    // CONNECTING throws. connectToRoom's own 'open' listener (for its
    // console log) fires independently of this one; both are allowed.
    connection.socket.addEventListener('open', () => {
      this.send(tabId, { type: 'stateRequest', timestamp: Date.now() });
    });

    if (isHost) {
      session.timeSyncTimer = setInterval(() => this.sendTimeSync(tabId), TIME_SYNC_INTERVAL_MS);
    }
  }

  disconnect(tabId: number): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (session.timeSyncTimer) clearInterval(session.timeSyncTimer);
    session.connection.close();
    this.sessions.delete(tabId);
  }

  /** Called by content/index.ts whenever a local play/pause/seeked fires. */
  reportLocalEvent(tabId: number, event: PlaybackEvent): void {
    const session = this.sessions.get(tabId);
    if (!session) return;

    session.lastLocalState = { currentTime: event.currentTime, isPlaying: event.isPlaying };

    const payload: PlaybackPayload = { currentTime: event.currentTime, isPlaying: event.isPlaying };
    this.send(tabId, { type: event.type, payload, timestamp: Date.now() });
  }

  private sendTimeSync(tabId: number): void {
    const session = this.sessions.get(tabId);
    if (!session || !session.lastLocalState) return;
    const payload: PlaybackPayload = session.lastLocalState;
    this.send(tabId, { type: 'timeSync', payload, timestamp: Date.now() });
  }

  private send(tabId: number, msg: Partial<Message>): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.connection.socket.send(JSON.stringify(msg));
  }

  private handleMessage(tabId: number, msg: Message, callbacks: RoomManagerCallbacks): void {
    switch (msg.type) {
      case 'presence':
        callbacks.onPresence(msg.payload as PresencePayload);
        return;

      case 'stateResponse': {
        const payload = msg.payload as StateResponsePayload;
        const target = computeJoinSeekTarget(payload.currentTime, payload.isPlaying, msg.timestamp);
        callbacks.onJoinSeek(target);
        return;
      }

      case 'controlDenied': {
        const payload = msg.payload as { reason: string };
        callbacks.onControlDenied(payload.reason);
        return;
      }

      case 'timeSync': {
        // US-2.7: this tab is a non-host receiving a heartbeat from
        // whoever holds control. Only correct past the threshold — see
        // shared/sync-math.ts for why.
        const session = this.sessions.get(tabId);
        const payload = msg.payload as PlaybackPayload;
        const localTime = session?.lastLocalState?.currentTime ?? payload.currentTime;
        if (shouldCorrectDrift(localTime, payload.currentTime, DRIFT_THRESHOLD_SECONDS)) {
          callbacks.onRemotePlayback({
            type: payload.isPlaying ? 'seeked' : 'pause',
            currentTime: payload.currentTime,
            isPlaying: payload.isPlaying,
          });
        }
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
