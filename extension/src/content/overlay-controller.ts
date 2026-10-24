import type { JitsiEvent, JitsiHandle } from './jitsi.ts';
import { formatControl, formatParticipants } from './overlay-state.ts';
import type { RoomEndReason, ToBackgroundMessage, ToContentMessage } from '../shared/runtime-messages.ts';
import type { SessionPayload } from '../shared/messages.ts';
import type { VideoSelection, VideoTabStatus } from '../shared/video-frames.ts';

/**
 * `waiting`: the call is still open, but needs the viewer — Jitsi is asking
 * for a moderator login, or joining is taking unusually long — so the
 * Jitsi screen is shown instead of being covered.
 */
export type CallState = 'connecting' | 'waiting' | 'joined' | 'failed';

/** What the controller needs from the DOM; overlay-view.ts implements it. */
export interface OverlayView {
  readonly callSlot: HTMLElement;
  setParticipants(text: string): void;
  setControl(text: string, isHost: boolean | null): void;
  setCall(state: CallState, message?: string): void;
  setMuted(kind: 'audio' | 'video', muted: boolean): void;
  showToast(message: string, durationMs?: number): void;
  showPicker(status: VideoTabStatus): void;
  hidePicker(): void;
  /** Shows why the room ended, then removes itself. */
  showEnded(message: string): void;
  destroy(): void;
}

export interface OverlayActions {
  toggleMic(): void;
  toggleCamera(): void;
  copyLink(): void;
  leave(): void;
  openPicker(): void;
  selectVideo(selection: VideoSelection): void;
  autoSelectVideo(): void;
  retryCall(): void;
  openCallWindow(): void;
}

export interface OverlayDeps {
  createView(actions: OverlayActions): OverlayView;
  sendMessage(message: ToBackgroundMessage): Promise<unknown>;
  injectJitsi(roomId: string, slot: HTMLElement, onEvent: (event: JitsiEvent) => void): Promise<JitsiHandle>;
  openCallWindow(roomId: string): void;
  writeClipboard(text: string): Promise<void>;
}

export interface OverlayTiming {
  /** How long the call may take to join before the viewer is asked to help. */
  joinTimeoutMs: number;
  /** Interval of the keepalive that stops Firefox unloading the background. */
  keepaliveMs: number;
}

const DEFAULT_TIMING: OverlayTiming = { joinTimeoutMs: 20_000, keepaliveMs: 20_000 };

const SLOW_JOIN_MESSAGE =
  'Still connecting. If Jitsi asks you to sign in, do it here, or open the call in a window.';

const END_MESSAGES: Record<RoomEndReason, string> = {
  'host-left': 'The host ended this room',
  'server-shutdown': 'The server closed this room',
  'room-gone': 'This room no longer exists',
  left: 'You left the room',
};

/**
 * The top frame's room lifecycle: one overlay and one call per room, both
 * torn down whenever the room ends, however it ends. Every asynchronous
 * step checks a generation number, so a call that finishes starting after
 * the user already left is disposed instead of lingering.
 */
export class OverlayController {
  private deps: OverlayDeps;
  private timing: OverlayTiming;
  private roomId: string | null = null;
  private view: OverlayView | null = null;
  private generation = 0;
  private session: SessionPayload | null = null;
  private participants = 0;
  private call: JitsiHandle | null = null;
  private callState: CallState | null = null;
  private joinTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private wasReconnecting = false;

  constructor(deps: OverlayDeps, timing: Partial<OverlayTiming> = {}) {
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  /** Asks the background whether this page belongs to a room. */
  start(): void {
    this.send({ kind: 'checkPendingJoin' });
  }

  get currentRoomId(): string | null {
    return this.roomId;
  }

  get currentCallState(): CallState | null {
    return this.callState;
  }

  handleMessage(msg: ToContentMessage): void {
    switch (msg.kind) {
      case 'roomConnected':
        if (msg.roomId !== this.roomId || !this.view) this.open(msg.roomId);
        return;
      case 'roomEnded':
        this.end(msg.reason);
        return;
      case 'sessionInfo': {
        const first = !this.session;
        this.session = msg.payload;
        this.renderStatus();
        if (first) void this.hintMultipleVideos();
        return;
      }
      case 'presenceUpdate':
        this.participants = msg.payload.connections.length;
        this.renderStatus();
        return;
      case 'connectionState':
        if (msg.state === 'reconnecting') this.toast('Connection lost — reconnecting…', 10_000);
        else if (msg.state === 'connected' && this.wasReconnecting) this.toast('Connection restored');
        else if (msg.state === 'error') this.toast('Room connection failed', 10_000);
        this.wasReconnecting = msg.state === 'reconnecting' || (this.wasReconnecting && msg.state !== 'connected');
        return;
      case 'controlDenied':
        this.toast('The host controls playback — resyncing…');
        return;
      case 'resynced':
        this.toast('Back in sync with the host');
        return;
      case 'playbackApplyFailed':
        this.toast('Playback was blocked — press play once on this page', 8000);
        return;
      case 'playerAdapterStatus':
        this.toast(msg.message ?? `Player status: ${msg.status}`, 8000);
        return;
      case 'freshLinkResult':
        this.deps.writeClipboard(msg.joinUrl).then(
          () => this.toast('Invite link copied'),
          () => this.toast('Link created, but the clipboard was not available'),
        );
        return;
      case 'freshLinkError':
        this.toast(msg.message);
        return;
    }
  }

  private send(message: ToBackgroundMessage): Promise<unknown> {
    return this.deps.sendMessage(message).catch(() => undefined);
  }

  private toast(message: string, durationMs?: number): void {
    this.view?.showToast(message, durationMs);
  }

  private open(roomId: string): void {
    this.close();
    this.roomId = roomId;
    this.view = this.deps.createView({
      toggleMic: () => this.call?.toggleAudio(),
      toggleCamera: () => this.call?.toggleVideo(),
      copyLink: () => void this.send({ kind: 'requestFreshLink' }),
      leave: () => {
        void this.send({ kind: 'leaveRoom' });
        this.end('left');
      },
      openPicker: () => void this.openPicker(),
      selectVideo: (selection) => void this.selectVideo(selection),
      autoSelectVideo: () => void this.autoSelectVideo(),
      retryCall: () => this.startCall(),
      openCallWindow: () => {
        if (this.roomId) this.deps.openCallWindow(this.roomId);
      },
    });
    this.renderStatus();
    this.keepaliveTimer = setInterval(() => void this.send({ kind: 'keepalive' }), this.timing.keepaliveMs);
    this.startCall();
  }

  /** Stops everything belonging to the current room. */
  private close(): void {
    this.generation += 1;
    this.stopCall();
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.view?.destroy();
    this.view = null;
    this.roomId = null;
    this.session = null;
    this.participants = 0;
    this.wasReconnecting = false;
  }

  private end(reason: RoomEndReason): void {
    if (!this.view) return;
    const view = this.view;
    this.view = null; // keep close() from destroying it before the notice shows
    this.close();
    if (reason === 'left') view.destroy();
    else view.showEnded(END_MESSAGES[reason]);
  }

  private renderStatus(): void {
    if (!this.view) return;
    this.view.setParticipants(formatParticipants(this.participants));
    this.view.setControl(formatControl(this.session), this.session ? this.session.isHost : null);
  }

  private stopCall(): void {
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.joinTimer = null;
    this.call?.dispose();
    this.call = null;
    this.callState = null;
  }

  private setCall(state: CallState, message?: string): void {
    this.callState = state;
    this.view?.setCall(state, message);
  }

  private failCall(message: string): void {
    const generation = this.generation;
    this.stopCall();
    if (generation !== this.generation || !this.view) return;
    this.setCall('failed', message);
  }

  /** Keeps the call open but uncovered, so the viewer can act on it. */
  private waitForViewer(message: string): void {
    if (this.joinTimer) clearTimeout(this.joinTimer);
    this.joinTimer = null;
    if (this.callState === 'joined') this.toast(message);
    else this.setCall('waiting', message);
  }

  private startCall(): void {
    const roomId = this.roomId;
    const view = this.view;
    if (!roomId || !view) return;
    this.stopCall();
    const generation = ++this.generation;
    this.setCall('connecting');
    view.setMuted('audio', true);
    view.setMuted('video', true);
    this.joinTimer = setTimeout(() => {
      if (generation === this.generation) this.waitForViewer(SLOW_JOIN_MESSAGE);
    }, this.timing.joinTimeoutMs);

    this.deps.injectJitsi(roomId, view.callSlot, (event) => {
      if (generation !== this.generation) return;
      this.onCallEvent(event);
    }).then(
      (handle) => {
        if (generation !== this.generation) {
          handle.dispose();
          return;
        }
        this.call = handle;
      },
      (error: Error) => {
        if (generation === this.generation) this.failCall(error.message || 'Video chat unavailable');
      },
    );
  }

  private onCallEvent(event: JitsiEvent): void {
    switch (event.type) {
      case 'joined':
        if (this.joinTimer) clearTimeout(this.joinTimer);
        this.joinTimer = null;
        this.setCall('joined');
        return;
      case 'audioMuted':
        this.view?.setMuted('audio', event.muted);
        return;
      case 'videoMuted':
        this.view?.setMuted('video', event.muted);
        return;
      case 'error':
        if (event.fatal) this.failCall(event.message);
        else this.waitForViewer(event.message);
        return;
      case 'left':
        this.failCall('Video chat ended');
        return;
    }
  }

  private async openPicker(): Promise<void> {
    try {
      const status = await this.deps.sendMessage({ kind: 'queryVideoCandidates' }) as VideoTabStatus;
      this.view?.showPicker(status);
    } catch (error) {
      this.toast(`Could not inspect videos: ${(error as Error).message}`);
    }
  }

  private async selectVideo(selection: VideoSelection): Promise<void> {
    this.view?.hidePicker();
    try {
      await this.deps.sendMessage({ kind: 'selectVideoCandidate', selection });
      this.toast('Syncing the selected video');
    } catch (error) {
      this.toast((error as Error).message);
    }
  }

  private async autoSelectVideo(): Promise<void> {
    this.view?.hidePicker();
    await this.send({ kind: 'clearVideoSelection' });
    this.toast('Choosing the video automatically');
  }

  private async hintMultipleVideos(): Promise<void> {
    const status = await this.send({ kind: 'queryVideoCandidates' }) as VideoTabStatus | undefined;
    if ((status?.candidates.length ?? 0) > 1) {
      this.toast('Several videos found — use the video picker if the wrong one syncs', 6000);
    }
  }
}
