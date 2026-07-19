import { SERVER_BASE_URL } from '../shared/config.ts';

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
  return (await res.json()) as CreateRoomResult;
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
  return (await res.json()) as MintTokenResult;
}
