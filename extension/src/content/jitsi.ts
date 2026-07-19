/**
 * Jitsi IFrame API embed — US-2.14.
 *
 * This module cannot be verified in this sandbox at all: it needs a real
 * network path to meet.jit.si (not in this project's allowed domains
 * list even if it were reachable here) and a real getUserMedia-capable
 * browser. Everything below is written to match Jitsi's documented
 * IFrame API shape, but treat it as unverified until checked by hand in
 * actual Firefox.
 */

export interface JitsiHandle {
  toggleAudio(): void;
  toggleVideo(): void;
  dispose(): void;
}

interface JitsiExternalAPIInstance {
  executeCommand(command: string): void;
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

const JITSI_DOMAIN = 'meet.jit.si';
const JITSI_SCRIPT_URL = `https://${JITSI_DOMAIN}/external_api.js`;

let scriptLoadPromise: Promise<void> | null = null;

function loadJitsiScript(): Promise<void> {
  if (window.JitsiMeetExternalAPI) return Promise.resolve();
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = JITSI_SCRIPT_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Jitsi external_api.js'));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

/**
 * Derives a Jitsi room name from our roomId via SHA-256 rather than using
 * roomId directly — our roomId is treated as "an identifier, not a
 * secret" (see idgen.ts), but a Jitsi room name is effectively public on
 * Jitsi's own infrastructure (anyone who has it can join the call
 * directly through Jitsi's own web UI, bypassing our server entirely).
 * Keeping the two values unlinkable is cheap defense in depth.
 */
async function deriveJitsiRoomName(roomId: string): Promise<string> {
  const data = new TextEncoder().encode(`cowatch-jitsi:${roomId}`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

/**
 * Injects the Jitsi IFrame API and starts a call for this room. The
 * generated iframe needs camera/mic permission delegation
 * (`allow="camera *; microphone *; display-capture *"`) — Jitsi's own
 * IFrame API sets this on the iframe it creates; if getUserMedia fails
 * silently when verifying this by hand, that attribute is the first
 * thing to check.
 */
export async function injectJitsi(roomId: string): Promise<JitsiHandle> {
  await loadJitsiScript();
  const jitsiRoomName = await deriveJitsiRoomName(roomId);

  const container = document.createElement('div');
  container.id = 'cowatch-jitsi-container';
  document.body.appendChild(container);

  const ExternalAPI = window.JitsiMeetExternalAPI;
  if (!ExternalAPI) {
    throw new Error('JitsiMeetExternalAPI failed to load');
  }

  const api = new ExternalAPI(JITSI_DOMAIN, {
    roomName: jitsiRoomName,
    parentNode: container,
    width: '100%',
    height: '100%',
  });

  return {
    toggleAudio: () => api.executeCommand('toggleAudio'),
    toggleVideo: () => api.executeCommand('toggleVideo'),
    dispose: () => api.dispose(),
  };
}
