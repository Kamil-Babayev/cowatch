import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatControl, formatParticipants } from './overlay-state.ts';

test('formatParticipants pluralises', () => {
  assert.equal(formatParticipants(1), '1 person');
  assert.equal(formatParticipants(3), '3 people');
});

test('formatControl describes authority from this participant’s side', () => {
  assert.equal(formatControl(null), 'Connecting…');
  assert.equal(formatControl({ connectionId: 'c', isHost: false, controlMode: 'open' }), 'Everyone can control');
  assert.equal(formatControl({ connectionId: 'c', isHost: true, controlMode: 'host-only' }), 'You control playback');
  assert.equal(formatControl({ connectionId: 'c', isHost: false, controlMode: 'host-only' }), 'Host controls playback');
});
