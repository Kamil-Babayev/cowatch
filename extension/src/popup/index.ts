import { mintFreshLink, type ControlMode } from '../shared/api-client.ts';
import type { CreateRoomReply, ToBackgroundMessage } from '../shared/runtime-messages.ts';
import { detectPopupVideoStatus, type PopupVideoStatus } from './video-status.ts';
import { canonicalizeStoredSession, type StoredSession } from './stored-session.ts';

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function hostKey(tabId: number): string {
  return `hostSession:${tabId}`;
}

function activeKey(tabId: number): string {
  return `activeSession:${tabId}`;
}

async function getActiveTab(): Promise<browser.tabs.Tab> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) throw new Error('No active tab found');
  return tab;
}

function send(message: ToBackgroundMessage): Promise<unknown> {
  return browser.runtime.sendMessage(message);
}

function setStatus(message: string, tone: 'info' | 'error' | 'success' = 'info'): void {
  const status = element('status');
  status.textContent = message;
  status.dataset.tone = tone;
}

function setBusy(busy: boolean): void {
  for (const id of ['create-room-btn', 'copy-link-btn', 'leave-room-btn']) {
    element<HTMLButtonElement>(id).disabled = busy;
  }
}

function showView(name: 'loading' | 'create' | 'room'): void {
  element('loading-view').hidden = name !== 'loading';
  element('create-view').hidden = name !== 'create';
  element('room-view').hidden = name !== 'room';
  element('room-pill').hidden = name !== 'room';
}

const VIDEO_MESSAGES: Partial<Record<PopupVideoStatus, string>> = {
  'no-video': 'No video detected on this page yet. Start playing it, or open a page with a video.',
  'unsupported-player': 'This embedded player does not expose synchronization controls.',
  restricted: 'CoWatch cannot run on this Firefox page.',
  unreachable: 'CoWatch could not inspect this tab. Reload it and try again.',
};

async function showCreate(tab: browser.tabs.Tab): Promise<void> {
  showView('loading');
  const videoStatus = await detectPopupVideoStatus(tab, (_tabId, message) => send(message));
  const notice = element('no-video-message');
  notice.textContent = VIDEO_MESSAGES[videoStatus] ?? '';
  notice.hidden = videoStatus === 'available';
  element<HTMLButtonElement>('create-room-btn').disabled = videoStatus !== 'available';
  showView('create');
}

/** Shows a URL shortened in the middle, keeping the token's end visible. */
function setJoinUrl(url: string): void {
  const field = element('join-url');
  const tail = url.slice(-8);
  field.querySelector('.link-head')!.textContent = url.slice(0, -8);
  field.querySelector('.link-tail')!.textContent = tail;
  field.title = url;
}

function showHostRoom(session: StoredSession): void {
  element('room-title').textContent = 'You’re hosting';
  element('invite').hidden = false;
  element('guest-note').hidden = true;
  setJoinUrl(session.joinUrl);
  showView('room');
}

function showGuestRoom(): void {
  element('room-title').textContent = 'You joined a watch party';
  element('invite').hidden = true;
  element('guest-note').hidden = false;
  showView('room');
}

async function readHostSession(tabId: number): Promise<StoredSession | undefined> {
  const stored = (await browser.storage.session.get(hostKey(tabId)))[hostKey(tabId)] as StoredSession | undefined;
  if (!stored) return undefined;
  try {
    const canonical = canonicalizeStoredSession(stored);
    await browser.storage.session.set({ [hostKey(tabId)]: canonical });
    return canonical;
  } catch {
    await browser.storage.session.remove(hostKey(tabId));
    setStatus('The saved invite link was invalid. Copy a new one.', 'error');
    return undefined;
  }
}

async function render(tab: browser.tabs.Tab): Promise<void> {
  const tabId = tab.id as number;
  const active = (await browser.storage.session.get(activeKey(tabId)))[activeKey(tabId)];
  if (!active) {
    await showCreate(tab);
    return;
  }
  const host = await readHostSession(tabId);
  if (host) showHostRoom(host);
  else showGuestRoom();
}

async function main(): Promise<void> {
  const tab = await getActiveTab();
  const tabId = tab.id as number;
  await render(tab);

  element('create-room-btn').addEventListener('click', async () => {
    const checked = document.querySelector<HTMLInputElement>('input[name="control-mode"]:checked');
    const controlMode = (checked?.value ?? 'open') as ControlMode;
    try {
      setBusy(true);
      setStatus('Starting watch party…');
      // The background creates and connects the room, so closing the popup
      // mid-request cannot strand a room nobody is connected to.
      await send({ kind: 'createRoom', tabId, videoUrl: tab.url as string, controlMode }) as CreateRoomReply;
      await render(tab);
      setStatus('Invite friends with the link below.', 'success');
    } catch (err) {
      setStatus(`Could not start the watch party: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  });

  element('copy-link-btn').addEventListener('click', async () => {
    const session = await readHostSession(tabId);
    if (!session) return;
    try {
      setBusy(true);
      // Always a new token: old ones are not revoked, they just expire, so
      // a fresh link is never worse than re-copying the last one.
      const fresh = await mintFreshLink(session.roomId, session.hostToken);
      await navigator.clipboard.writeText(fresh.joinUrl);
      const updated: StoredSession = { ...session, joinToken: fresh.joinToken, joinUrl: fresh.joinUrl };
      await browser.storage.session.set({ [hostKey(tabId)]: updated });
      showHostRoom(updated);
      setStatus('Invite link copied.', 'success');
    } catch (err) {
      setStatus(`Could not create a link: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  });

  element('leave-room-btn').addEventListener('click', async () => {
    try {
      setBusy(true);
      await send({ kind: 'leaveRoom', tabId });
      await showCreate(tab);
      setStatus('You left the watch party.');
    } catch (err) {
      setStatus(`Could not leave: ${(err as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  });
}

main().catch((err) => setStatus(`Error: ${(err as Error).message}`, 'error'));
