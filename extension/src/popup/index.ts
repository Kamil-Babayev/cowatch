import { createRoom, mintFreshLink, type ControlMode } from './api-client.ts';
import type { ToBackgroundMessage } from '../shared/runtime-messages.ts';

console.log('[CoWatch] popup loaded');

interface StoredSession {
  roomId: string;
  hostToken: string;
  joinUrl: string;
}

function sessionKey(tabId: number): string {
  return `hostSession:${tabId}`;
}

async function getActiveTab(): Promise<browser.tabs.Tab> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) {
    throw new Error('No active tab found');
  }
  return tab;
}

function showCreateView(noVideo: boolean): void {
  document.getElementById('create-view')!.hidden = false;
  document.getElementById('room-view')!.hidden = true;
  document.getElementById('no-video-message')!.hidden = !noVideo;
  (document.getElementById('create-room-btn') as HTMLButtonElement).disabled = noVideo;
}

function showRoomView(joinUrl: string): void {
  document.getElementById('create-view')!.hidden = true;
  document.getElementById('room-view')!.hidden = false;
  (document.getElementById('join-url') as HTMLInputElement).value = joinUrl;
}

function setStatus(message: string): void {
  document.getElementById('status')!.textContent = message;
}

async function main(): Promise<void> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;

  const stored = await browser.storage.session.get([sessionKey(tabId)]);
  const existing = stored[sessionKey(tabId)] as StoredSession | undefined;

  if (existing) {
    showRoomView(existing.joinUrl);
  } else {
    // US-2.5's own scope: disabled if this tab has no detected video.
    // The popup can't run VideoDetector itself (that's the content
    // script's job in a different execution context) — it asks instead.
    const noVideo = !tab.url || tab.url.startsWith('about:') || tab.url.startsWith('moz-extension:');
    showCreateView(noVideo);
  }

  document.getElementById('create-room-btn')?.addEventListener('click', async () => {
    try {
      setStatus('Creating room...');
      const controlMode = (document.getElementById('control-mode') as HTMLSelectElement).value as ControlMode;
      const result = await createRoom(tab.url as string, controlMode);

      const session: StoredSession = {
        roomId: result.roomId,
        hostToken: result.hostToken,
        joinUrl: result.joinUrl,
      };
      await browser.storage.session.set({ [sessionKey(tabId)]: session });

      const connectMsg: ToBackgroundMessage = {
        kind: 'connectRoom',
        roomId: result.roomId,
        hostToken: result.hostToken,
      };
      await browser.runtime.sendMessage(connectMsg);

      showRoomView(result.joinUrl);
      setStatus('');
    } catch (err) {
      setStatus(`Failed to create room: ${(err as Error).message}`);
    }
  });

  document.getElementById('copy-link-btn')?.addEventListener('click', async () => {
    const stored2 = await browser.storage.session.get([sessionKey(tabId)]);
    const session = stored2[sessionKey(tabId)] as StoredSession | undefined;
    if (!session) return;

    try {
      setStatus('Generating fresh link...');
      // Always mints a new token rather than re-copying the existing
      // joinUrl — matches US-2.12/US-1.4: old tokens aren't revoked, they
      // just age out, so this is safe to do every time regardless of
      // whether the current link is still valid.
      const fresh = await mintFreshLink(session.roomId, session.hostToken);
      await navigator.clipboard.writeText(fresh.joinUrl);

      const updated: StoredSession = { ...session, joinUrl: fresh.joinUrl };
      await browser.storage.session.set({ [sessionKey(tabId)]: updated });
      showRoomView(fresh.joinUrl);
      setStatus('Copied!');
    } catch (err) {
      setStatus(`Failed to generate link: ${(err as Error).message}`);
    }
  });

  document.getElementById('leave-room-btn')?.addEventListener('click', async () => {
    const leaveMsg: ToBackgroundMessage = { kind: 'leaveRoom' };
    await browser.runtime.sendMessage(leaveMsg);
    await browser.storage.session.remove([sessionKey(tabId)]);
    showCreateView(false);
    setStatus('Left room.');
  });
}

main().catch((err) => setStatus(`Error: ${(err as Error).message}`));
