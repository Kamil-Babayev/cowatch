import type { PresencePayload, SessionPayload } from './messages.ts';
import type { VideoSelection } from './video-frames.ts';
import type { AuthoritativePlayerState, PlayerEvent, PlayerSnapshot } from './player.ts';
import type { ControlMode } from './api-client.ts';

/** Why a tab's room session ended, as shown to the user. */
export type RoomEndReason = 'host-left' | 'server-shutdown' | 'room-gone' | 'left';

/** Content script / popup -> background */
export type ToBackgroundMessage =
  | { kind: 'localPlayerEvent'; event: PlayerEvent }
  | { kind: 'playerHeartbeat'; state: PlayerSnapshot }
  | { kind: 'playerAdapterStatus'; status: string; message?: string }
  | { kind: 'playbackApplyFailed' }
  | { kind: 'frameVideoCandidatesChanged' }
  | { kind: 'queryVideoCandidates'; tabId?: number }
  | { kind: 'selectVideoCandidate'; selection: VideoSelection }
  | { kind: 'clearVideoSelection' }
  // Landing-bridge content script: the user clicked "continue" on a
  // resolved join link.
  | { kind: 'joinRequested'; roomId: string; videoUrl: string }
  // Popup: create a room for this tab. Runs in the background so closing
  // the popup mid-request cannot leave a room nobody is connected to.
  // Replies with a CreateRoomReply.
  | { kind: 'createRoom'; tabId: number; videoUrl: string; controlMode: ControlMode }
  // Popup, reopening on a tab whose room it already knows about.
  | { kind: 'connectRoom'; roomId: string; hostToken?: string; tabId?: number }
  | { kind: 'leaveRoom'; tabId?: number }
  // Sent by the top-frame content script on every page load to ask "am I
  // part of a room?" — content scripts cannot learn their own tabId, so
  // background answers using sender.tab.id.
  | { kind: 'checkPendingJoin' }
  // Top-frame content script, every 20 s while in a room. Firefox unloads
  // an idle MV3 event page (and its WebSockets) after ~30 s; any runtime
  // message resets that timer.
  | { kind: 'keepalive' }
  // The overlay's Copy Link button: only background holds the hostToken
  // needed to mint a fresh join link.
  | { kind: 'requestFreshLink' };

export interface CreateRoomReply {
  roomId: string;
  joinUrl: string;
}

/** Background -> content script (for a specific tab) */
export type ToContentMessage =
  | { kind: 'frameVideoStatusRequest' }
  | { kind: 'activateVideoCandidate'; candidateId: string }
  | { kind: 'deactivateVideoCandidate' }
  | { kind: 'playbackApplyFailed' }
  | { kind: 'applyPlayerState'; state: AuthoritativePlayerState }
  | { kind: 'controlDenied'; reason: string }
  // The authoritative state that follows a controlDenied was applied.
  | { kind: 'resynced' }
  | { kind: 'presenceUpdate'; payload: PresencePayload }
  | { kind: 'sessionInfo'; payload: SessionPayload }
  | { kind: 'connectionState'; state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error' }
  | { kind: 'playerAdapterStatus'; status: string; message?: string }
  // The tab is (still) in this room — sent on connect and again whenever a
  // reloaded page asks, so the overlay can build itself and derive the
  // Jitsi room name on both the host and the joiner path.
  | { kind: 'roomConnected'; roomId: string }
  // The tab's room session is over: tear down the overlay and the call.
  | { kind: 'roomEnded'; reason: RoomEndReason }
  // Replies to requestFreshLink. A non-host tab has no hostToken to mint
  // with at all, which is worth distinguishing from a network failure.
  | { kind: 'freshLinkResult'; joinUrl: string }
  | { kind: 'freshLinkError'; message: string };
