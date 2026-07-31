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
  timestamp: number;
}

export interface PlayerCapabilities {
  canPlay: boolean;
  canPause: boolean;
  canSeek: boolean;
  canLoadSource: boolean;
  canSetRate: boolean;
}

export interface PlayerEvent extends PlayerSnapshot {
  action: 'play' | 'pause' | 'seek' | 'replace' | 'buffering' | 'ended';
}

export interface PlayerAdapter {
  readonly id: string;
  readonly provider: PlayerProvider;
  probe(signal: AbortSignal): Promise<PlayerCapabilities>;
  getState(): Promise<PlayerSnapshot>;
  subscribe(listener: (event: PlayerEvent) => void): () => void;
  apply(state: AuthoritativePlayerState): Promise<void>;
  loadSource(source: MediaSource): Promise<void>;
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
