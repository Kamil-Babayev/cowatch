import { createRoom, mintFreshLink, type ControlMode } from '../shared/api-client.ts';
import type { ToBackgroundMessage } from '../shared/runtime-messages.ts';
import { detectPopupVideoStatus } from './video-status.ts';
import {
  canonicalizeStoredSession,
  type StoredSession,
} from './stored-session.ts';

console.log('[CoWatch] popup loaded');

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

function showCreateView(noVideo: boolean, message = 'No video detected on this page.'): void {
  document.getElementById('loading-view')!.hidden = true;
  document.getElementById('create-view')!.hidden = false;
  document.getElementById('room-view')!.hidden = true;
  const noVideoMessage = document.getElementById('no-video-message')!;
  noVideoMessage.textContent = message;
  noVideoMessage.hidden = !noVideo;
  (document.getElementById('create-room-btn') as HTMLButtonElement).disabled = noVideo;
}

function showRoomView(joinUrl: string): void {
  document.getElementById('loading-view')!.hidden = true;
  document.getElementById('create-view')!.hidden = true;
  document.getElementById('room-view')!.hidden = false;
  (document.getElementById('join-url') as HTMLInputElement).value = joinUrl;
}

function setStatus(message: string): void {
  document.getElementById('status')!.textContent = message;
}

function setBusy(busy: boolean): void {
  for (const id of ['create-room-btn', 'copy-link-btn', 'leave-room-btn']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) button.disabled = busy;
  }
}

async function main(): Promise<void> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;

  const stored = await browser.storage.session.get([sessionKey(tabId)]);
  let existing = stored[sessionKey(tabId)] as StoredSession | undefined;
  let storedSessionError = '';

  if (existing) {
    try {
      existing = canonicalizeStoredSession(existing);
      await browser.storage.session.set({ [sessionKey(tabId)]: existing });
    } catch {
      await browser.storage.session.remove([sessionKey(tabId)]);
      existing = undefined;
      storedSessionError = 'Saved room link was invalid. Create a new room.';
    }
  }

  if (existing) {
    const connectMsg: ToBackgroundMessage = {
      kind: 'connectRoom',
      roomId: existing.roomId,
      hostToken: existing.hostToken,
      tabId,
    };
    await browser.runtime.sendMessage(connectMsg);
    showRoomView(existing.joinUrl);
  } else {
    const videoStatus = await detectPopupVideoStatus(
      tab,
      (_id, message) => browser.runtime.sendMessage(message),
    );
    if (videoStatus === 'restricted') {
      showCreateView(true);
      setStatus('CoWatch cannot access this Firefox page.');
    } else if (videoStatus === 'unreachable') {
      showCreateView(true);
      setStatus('CoWatch could not inspect this tab. Reload it and try again.');
    } else if (videoStatus === 'unsupported-player') {
      showCreateView(true, 'This embedded player does not expose synchronization controls.');
    } else {
      showCreateView(videoStatus === 'no-video');
      if (storedSessionError) setStatus(storedSessionError);
    }
  }

  document.getElementById('create-room-btn')?.addEventListener('click', async () => {
    try {
      setBusy(true);
      setStatus('Creating room...');
      const controlMode = (document.getElementById('control-mode') as HTMLSelectElement).value as ControlMode;
      const result = await createRoom(tab.url as string, controlMode);

      const session: StoredSession = {
        roomId: result.roomId,
        hostToken: result.hostToken,
        joinToken: result.joinToken,
        joinUrl: result.joinUrl,
      };
      await browser.storage.session.set({ [sessionKey(tabId)]: session });

      const connectMsg: ToBackgroundMessage = {
        kind: 'connectRoom',
        roomId: result.roomId,
        hostToken: result.hostToken,
        tabId,
      };
      await browser.runtime.sendMessage(connectMsg);

      showRoomView(result.joinUrl);
      setStatus('');
    } catch (err) {
      setStatus(`Failed to create room: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById('copy-link-btn')?.addEventListener('click', async () => {
    const stored2 = await browser.storage.session.get([sessionKey(tabId)]);
    const session = stored2[sessionKey(tabId)] as StoredSession | undefined;
    if (!session) return;

    try {
      setBusy(true);
      setStatus('Generating fresh link...');
      // Always mints a new token rather than re-copying the existing
      // joinUrl — matches US-2.12/US-1.4: old tokens aren't revoked, they
      // just age out, so this is safe to do every time regardless of
      // whether the current link is still valid.
      const fresh = await mintFreshLink(session.roomId, session.hostToken);
      await navigator.clipboard.writeText(fresh.joinUrl);

      const updated: StoredSession = {
        ...session,
        joinToken: fresh.joinToken,
        joinUrl: fresh.joinUrl,
      };
      await browser.storage.session.set({ [sessionKey(tabId)]: updated });
      showRoomView(fresh.joinUrl);
      setStatus('Copied!');
    } catch (err) {
      setStatus(`Failed to generate link: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  });

  document.getElementById('leave-room-btn')?.addEventListener('click', async () => {
    try {
      setBusy(true);
      const leaveMsg: ToBackgroundMessage = { kind: 'leaveRoom', tabId };
      await browser.runtime.sendMessage(leaveMsg);
      await browser.storage.session.remove([sessionKey(tabId)]);
      showCreateView(false);
      setStatus('Left room.');
    } catch (err) {
      setStatus(`Failed to leave room: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  });
}

main().catch((err) => setStatus(`Error: ${(err as Error).message}`));
