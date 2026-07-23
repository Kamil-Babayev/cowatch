import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatRoomStatus } from './overlay-state.ts';

test('formatRoomStatus renders connection, open, host, and joiner authority', () => {
  assert.equal(formatRoomStatus(0, null), '0 participants · Connecting…');
  assert.equal(
    formatRoomStatus(2, { connectionId: 'a', isHost: false, controlMode: 'open' }),
    '2 participants · Everyone can control',
  );
  assert.equal(
    formatRoomStatus(1, { connectionId: 'a', isHost: true, controlMode: 'host-only' }),
    '1 participant · You control playback',
  );
  assert.equal(
    formatRoomStatus(3, { connectionId: 'b', isHost: false, controlMode: 'host-only' }),
    '3 participants · Host controls playback',
  );
});
