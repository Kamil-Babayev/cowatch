import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalizeStoredSession } from './stored-session.ts';

test('migrates a 0.1.2 session containing the old Render hostname', () => {
  const migrated = canonicalizeStoredSession({
    roomId: 'room-1',
    hostToken: 'host-1',
    joinUrl: 'https://cowatch.onrender.com/join-page/?token=legacy-token',
  });

  assert.deepEqual(migrated, {
    roomId: 'room-1',
    hostToken: 'host-1',
    joinToken: 'legacy-token',
    joinUrl: 'http://localhost:8080/join-page/?token=legacy-token',
  });
});

test('stored joinToken takes precedence over an untrusted cached URL', () => {
  const migrated = canonicalizeStoredSession({
    roomId: 'room-2',
    hostToken: 'host-2',
    joinToken: 'trusted-token',
    joinUrl: 'https://attacker.example/join-page/?token=wrong-token',
  });

  assert.equal(migrated.joinToken, 'trusted-token');
  assert.equal(
    migrated.joinUrl,
    'http://localhost:8080/join-page/?token=trusted-token',
  );
});

test('rejects a cached session without a recoverable token', () => {
  assert.throws(
    () => canonicalizeStoredSession({
      roomId: 'room-3',
      hostToken: 'host-3',
      joinUrl: 'https://cowatch.onrender.com/join-page/',
    }),
    /no valid join token/,
  );
});
