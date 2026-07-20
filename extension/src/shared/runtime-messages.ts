import type { PlaybackEvent } from '../content/playback-events.ts';
import type { PresencePayload } from './messages.ts';

/** Content script -> background */
export type ToBackgroundMessage =
  | { kind: 'localPlaybackEvent'; event: PlaybackEvent }
  // US-2.11: landing-bridge content script telling background the user
  // clicked "continue" on a resolved join link.
  | { kind: 'joinRequested'; roomId: string; videoUrl: string }
  // US-2.5: popup, after it already created/resolved a room via the
  // server's REST API directly — background's only job from here is to
  // actually open the WebSocket for this tab.
  | { kind: 'connectRoom'; roomId: string; hostToken?: string }
  | { kind: 'leaveRoom' }
  | { kind: 'extensionInstalledCheck' } // US-2.10, sent by the landing-bridge script
  // US-2.11: sent by the generic content script on every page load to ask
  // "was I just navigated here as part of a join handoff?" — content
  // scripts have no synchronous way to learn their own tabId
  // (browser.tabs.getCurrent() isn't available there), so background
  // answers using sender.tab.id, which it does have.
  | { kind: 'checkPendingJoin' }
  // US-3.2: the in-page overlay's Copy Link button needs a fresh join
  // link, but only background retains the hostToken (via RoomManager's
  // session state) needed to call the server's mint-token endpoint — the
  // content script itself never has it.
  | { kind: 'requestFreshLink' };

/** Background -> content script (for a specific tab) */
export type ToContentMessage =
  | { kind: 'remotePlaybackEvent'; event: PlaybackEvent }
  | { kind: 'joinSeek'; targetSeconds: number }
  | { kind: 'controlDenied'; reason: string }
  | { kind: 'presenceUpdate'; payload: PresencePayload }
  | { kind: 'extensionInstalledResponse' } // reply to extensionInstalledCheck
  | { kind: 'pendingJoinResult'; roomId: string | null } // reply to checkPendingJoin
  // Sent right after connectRoom succeeds, on BOTH the host path (popup ->
  // connectRoom directly) and the joiner path (pendingJoinResult ->
  // connectRoom) — content/index.ts needs its own roomId either way to
  // derive a matching Jitsi room name (US-2.14), and only background
  // reliably knows it on both paths.
  | { kind: 'roomConnected'; roomId: string }
  // Replies to requestFreshLink. Split into two variants rather than one
  // with an optional error field — a non-host tab (or one whose session
  // vanished) has no hostToken to mint with at all, which is worth
  // distinguishing from an actual network/server failure.
  | { kind: 'freshLinkResult'; joinUrl: string }
  | { kind: 'freshLinkError'; message: string };
