import type { SessionPayload } from '../shared/messages.ts';

/** Formats the persistent presence and playback-authority line. */
export function formatRoomStatus(
  participantCount: number,
  session: SessionPayload | null,
): string {
  const control = !session
    ? 'Connecting…'
    : session.controlMode === 'open'
      ? 'Everyone can control'
      : session.isHost
        ? 'You control playback'
        : 'Host controls playback';
  return `${participantCount} participant${participantCount === 1 ? '' : 's'} · ${control}`;
}
