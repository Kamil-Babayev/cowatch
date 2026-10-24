export type PlayerProvider = 'native' | 'obrut';

export type PlayerStatus =
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'ended'
  | 'reloading'
  | 'closed'
  | 'unsupported';

export interface MediaSource {
  pageUrl: string;
  provider: PlayerProvider;
  mediaKey: string;
}

export interface PlayerSnapshot {
  source: MediaSource;
  position: number;
  status: PlayerStatus;
  duration?: number;
}

export interface AuthoritativePlayerState {
  revision: number;
  source: MediaSource;
  position: number;
  status: Extract<PlayerStatus, 'playing' | 'paused' | 'buffering' | 'ended'>;
  commandId?: string;
  /**
   * When `position` was true, in this machine's clock (Date.now()). The
   * background converts the server's timestamp using its measured clock
   * offset, so adapters can project the position without knowing about it.
   */
  timestamp: number;
}

export interface PlayerCapabilities {
  canPlay: boolean;
  canPause: boolean;
  canSeek: boolean;
  canLoadSource: boolean;
  canSetRate: boolean;
}

/**
 * `play`/`pause`/`seek`/`replace` are user intents that become room
 * commands. `buffering`/`status`/`ended` only describe the player's state;
 * the host reports them as heartbeats and joiners ignore them.
 */
export interface PlayerEvent extends PlayerSnapshot {
  action: 'play' | 'pause' | 'seek' | 'replace' | 'buffering' | 'status' | 'ended';
}

export interface PlayerAdapter {
  readonly id: string;
  readonly provider: PlayerProvider;
  probe(signal: AbortSignal): Promise<PlayerCapabilities>;
  getState(): Promise<PlayerSnapshot>;
  subscribe(listener: (event: PlayerEvent) => void): () => void;
  apply(state: AuthoritativePlayerState): Promise<void>;
  /** True when the adapter itself navigated its element to `src`. */
  expectsSource?(src: string): boolean;
  dispose(): void;
}

export function playableStatus(
  status: PlayerStatus,
): status is AuthoritativePlayerState['status'] {
  return status === 'playing'
    || status === 'paused'
    || status === 'buffering'
    || status === 'ended';
}
