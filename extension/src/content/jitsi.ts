import { JITSI_DOMAIN } from '../shared/config.ts';

/**
 * Jitsi IFrame API embed. It needs a Jitsi deployment that allows anonymous
 * rooms and being framed by other sites: public meet.jit.si limits embedded
 * meetings to a short demo and asks for a moderator login, so production
 * builds point JITSI_DOMAIN at a self-hosted server (see README.md).
 */

export type JitsiEvent =
  | { type: 'joined' }
  | { type: 'left' }
  | { type: 'error'; message: string }
  | { type: 'audioMuted'; muted: boolean }
  | { type: 'videoMuted'; muted: boolean };

export interface JitsiHandle {
  toggleAudio(): void;
  toggleVideo(): void;
  dispose(): void;
}

interface JitsiExternalAPIInstance {
  executeCommand(command: string): void;
  addListener(event: string, listener: (payload: unknown) => void): void;
  dispose(): void;
}

declare global {
  interface Window {
    JitsiMeetExternalAPI?: new (
      domain: string,
      options: Record<string, unknown>,
    ) => JitsiExternalAPIInstance;
  }
}

/** FNV-1a, for the rare page where crypto.subtle is unavailable. */
function fallbackHash(input: string): string {
  let out = '';
  for (let seed = 0; seed < 4; seed += 1) {
    let hash = 0x811c9dc5 ^ seed;
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, '0');
  }
  return out;
}

/**
 * Derives the Jitsi room name from our roomId via SHA-256 rather than using
 * roomId directly — a Jitsi room name is effectively public on the Jitsi
 * server (anyone who has it can join through Jitsi's own UI), so keeping
 * the two unlinkable is cheap defense in depth.
 */
export async function jitsiRoomName(roomId: string): Promise<string> {
  const input = `cowatch-jitsi:${roomId}`;
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fallbackHash(input);
  const hash = await subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/** The same call, opened directly on the Jitsi server in its own window. */
export async function jitsiRoomUrl(roomId: string): Promise<string> {
  return `https://${JITSI_DOMAIN}/${await jitsiRoomName(roomId)}`;
}

/**
 * Starts the call for this room inside `parentNode`. The iframe Jitsi's API
 * creates carries `allow="camera; microphone; display-capture; autoplay"`
 * itself. Everything after the iframe is created — joining, failures,
 * mute changes — arrives through `onEvent`.
 */
export async function injectJitsi(
  roomId: string,
  parentNode: HTMLElement,
  onEvent: (event: JitsiEvent) => void,
  displayName = 'CoWatch viewer',
): Promise<JitsiHandle> {
  const roomName = await jitsiRoomName(roomId);
  const ExternalAPI = window.JitsiMeetExternalAPI;
  if (!ExternalAPI) {
    throw new Error('JitsiMeetExternalAPI failed to load');
  }

  const api = new ExternalAPI(JITSI_DOMAIN, {
    roomName,
    parentNode,
    width: '100%',
    height: '100%',
    userInfo: { displayName },
    configOverwrite: {
      // The tile is small and the overlay has its own controls: skip the
      // lobby-style pre-join screen and the app download prompts.
      prejoinConfig: { enabled: false },
      prejoinPageEnabled: false,
      disableDeepLinking: true,
      // Nobody is put on camera or microphone without asking.
      startWithAudioMuted: true,
      startWithVideoMuted: true,
      toolbarButtons: [],
      hideConferenceSubject: true,
      disableInviteFunctions: true,
    },
    interfaceConfigOverwrite: {
      SHOW_JITSI_WATERMARK: false,
      SHOW_WATERMARK_FOR_GUESTS: false,
      MOBILE_APP_PROMO: false,
    },
  });

  api.addListener('videoConferenceJoined', () => onEvent({ type: 'joined' }));
  api.addListener('videoConferenceLeft', () => onEvent({ type: 'left' }));
  api.addListener('readyToClose', () => onEvent({ type: 'left' }));
  api.addListener('errorOccurred', (payload) => {
    const error = (payload as { error?: { message?: string; name?: string } } | undefined)?.error;
    onEvent({ type: 'error', message: error?.message || error?.name || 'Video chat error' });
  });
  api.addListener('audioMuteStatusChanged', (payload) =>
    onEvent({ type: 'audioMuted', muted: Boolean((payload as { muted?: boolean }).muted) }));
  api.addListener('videoMuteStatusChanged', (payload) =>
    onEvent({ type: 'videoMuted', muted: Boolean((payload as { muted?: boolean }).muted) }));

  return {
    toggleAudio: () => api.executeCommand('toggleAudio'),
    toggleVideo: () => api.executeCommand('toggleVideo'),
    dispose: () => api.dispose(),
  };
}
