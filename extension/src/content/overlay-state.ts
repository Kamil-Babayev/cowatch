import type { SessionPayload } from '../shared/messages.ts';

export function formatParticipants(count: number): string {
  return `${count} ${count === 1 ? 'person' : 'people'}`;
}

/** Who may control playback, from this participant's point of view. */
export function formatControl(session: SessionPayload | null): string {
  if (!session) return 'Connecting…';
  if (session.controlMode === 'open') return 'Everyone can control';
  return session.isHost ? 'You control playback' : 'Host controls playback';
}
