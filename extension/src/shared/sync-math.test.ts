import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driftAction, projectPosition } from './sync-math.ts';
import type { AuthoritativePlayerState } from './player.ts';

function state(status: AuthoritativePlayerState['status']): AuthoritativePlayerState {
  return {
    revision: 1,
    source: { pageUrl: 'https://a.example/v', provider: 'native', mediaKey: 'https://a.example/v' },
    position: 10,
    status,
    timestamp: 1000,
  };
}

test('projectPosition: a playing state keeps moving after it was stamped', () => {
  assert.equal(projectPosition(state('playing'), 3500), 12.5);
});

test('projectPosition: paused and buffering states stay put', () => {
  assert.equal(projectPosition(state('paused'), 9000), 10);
  assert.equal(projectPosition(state('buffering'), 9000), 10);
});

test('projectPosition: never moves backwards for a timestamp in the future', () => {
  assert.equal(projectPosition(state('playing'), 0), 10);
});

test('driftAction: ignores tiny drift and is symmetric', () => {
  assert.equal(driftAction(0.1, true, true), 'none');
  assert.equal(driftAction(-0.1, true, true), 'none');
});

test('driftAction: nudges moderate drift while playing, seeks otherwise', () => {
  assert.equal(driftAction(0.8, true, true), 'nudge');
  assert.equal(driftAction(-0.8, true, true), 'nudge');
  assert.equal(driftAction(0.8, false, true), 'seek');
  assert.equal(driftAction(0.8, true, false), 'seek');
});

test('driftAction: seeks large drift', () => {
  assert.equal(driftAction(1.5, true, true), 'seek');
  assert.equal(driftAction(-40, true, true), 'seek');
});
