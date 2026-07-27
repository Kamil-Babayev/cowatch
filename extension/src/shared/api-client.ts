import { SERVER_BASE_URL } from './config.ts';
import { canonicalJoinUrl } from './join-url.ts';

export type ControlMode = 'open' | 'host-only';

export interface CreateRoomResult {
  roomId: string;
  joinToken: string;
  joinUrl: string;
  hostToken: string;
}

export interface MintTokenResult {
  joinToken: string;
  joinUrl: string;
}

/** US-2.5 / US-2.13: create a room via the server's REST API directly. */
export async function createRoom(videoUrl: string, controlMode: ControlMode): Promise<CreateRoomResult> {
  const res = await fetch(`${SERVER_BASE_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl, controlMode }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`createRoom failed (${res.status}): ${body.error ?? 'unknown error'}`);
  }
  const result = (await res.json()) as CreateRoomResult;
  return { ...result, joinUrl: canonicalJoinUrl(result.joinToken) };
}

/** US-2.12: mint a fresh join link for a room that already exists. */
export async function mintFreshLink(roomId: string, hostToken: string): Promise<MintTokenResult> {
  const res = await fetch(`${SERVER_BASE_URL}/rooms/${roomId}/tokens`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hostToken}` },
  });
  if (!res.ok) {
    throw new Error(`mintFreshLink failed (${res.status})`);
  }
  const result = (await res.json()) as MintTokenResult;
  return { ...result, joinUrl: canonicalJoinUrl(result.joinToken) };
}
