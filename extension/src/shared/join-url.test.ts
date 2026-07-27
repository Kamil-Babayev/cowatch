import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJoinUrl, joinTokenFromUrl } from './join-url.ts';

test('canonicalJoinUrl always uses the configured server origin', () => {
  assert.equal(
    canonicalJoinUrl('abc_123-XYZ'),
    'http://localhost:8080/join-page/?token=abc_123-XYZ',
  );
  assert.equal(
    joinTokenFromUrl('https://cowatch.onrender.com/join-page/?token=old-token'),
    'old-token',
  );
  assert.equal(
    joinTokenFromUrl('https://unrelated.example/anything?token=other-token'),
    'other-token',
  );
});

test('join URL helpers reject missing and malformed tokens', () => {
  assert.throws(() => canonicalJoinUrl(''), /invalid join token/);
  assert.throws(() => canonicalJoinUrl('   '), /invalid join token/);
  assert.throws(() => canonicalJoinUrl('token with spaces'), /invalid join token/);
  assert.equal(joinTokenFromUrl('not a URL'), null);
  assert.equal(joinTokenFromUrl('https://example.com/join-page/'), null);
  assert.equal(joinTokenFromUrl('https://example.com/?token='), null);
  assert.equal(joinTokenFromUrl('https://example.com/?token=bad%20token'), null);
});
