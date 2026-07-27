import { SERVER_BASE_URL } from './config.ts';

export function canonicalJoinUrl(joinToken: string): string {
  if (
    typeof joinToken !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(joinToken)
  ) {
    throw new Error('server returned an invalid join token');
  }
  const url = new URL('/join-page/', SERVER_BASE_URL);
  url.searchParams.set('token', joinToken);
  return url.toString();
}

export function joinTokenFromUrl(joinUrl: string): string | null {
  if (typeof joinUrl !== 'string' || joinUrl === '') return null;
  try {
    const token = new URL(joinUrl).searchParams.get('token');
    return token && /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
  } catch {
    return null;
  }
}
