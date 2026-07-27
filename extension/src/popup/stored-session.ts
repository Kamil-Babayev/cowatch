import { canonicalJoinUrl, joinTokenFromUrl } from '../shared/join-url.ts';

export interface StoredSession {
  roomId: string;
  hostToken: string;
  joinToken?: string;
  joinUrl: string;
}

export interface CanonicalStoredSession extends StoredSession {
  joinToken: string;
}

export function canonicalizeStoredSession(
  session: StoredSession,
): CanonicalStoredSession {
  const joinToken = session.joinToken ?? joinTokenFromUrl(session.joinUrl);
  if (!joinToken) {
    throw new Error('saved room link has no valid join token');
  }
  return {
    ...session,
    joinToken,
    joinUrl: canonicalJoinUrl(joinToken),
  };
}
