import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EchoFilter } from './echo-filter.ts';
import type { PlayerEvent } from '../shared/player.ts';

function event(action: PlayerEvent['action'], position = 0): PlayerEvent {
  return {
    action,
    position,
    status: 'playing',
    source: { pageUrl: 'https://a.example/v', provider: 'native', mediaKey: 'https://a.example/v' },
  };
}

test('EchoFilter: nothing is an echo before a state is applied', () => {
  const filter = new EchoFilter(() => 0);
  assert.equal(filter.isEcho(event('play')), false);
});

test('EchoFilter: matches the events an applied state produces', () => {
  let now = 1000;
  const filter = new EchoFilter(() => now);
  filter.expect(30, true);
  now = 1500;
  assert.equal(filter.isEcho(event('play')), true);
  assert.equal(filter.isEcho(event('pause')), false);
  assert.equal(filter.isEcho(event('seek', 30.4)), true, 'projected to 30.5');
  assert.equal(filter.isEcho(event('seek', 90)), false, 'a user seek elsewhere');
  assert.equal(filter.isEcho(event('buffering')), true);
  assert.equal(filter.isEcho(event('replace')), false);
});

test('EchoFilter: a paused expectation does not move and matches pause', () => {
  let now = 0;
  const filter = new EchoFilter(() => now);
  filter.expect(10, false);
  now = 1500;
  assert.equal(filter.isEcho(event('pause')), true);
  assert.equal(filter.isEcho(event('play')), false);
  assert.equal(filter.isEcho(event('seek', 10.2)), true);
});

test('EchoFilter: expires after its window', () => {
  let now = 0;
  const filter = new EchoFilter(() => now, 2000);
  filter.expect(10, true);
  now = 2500;
  assert.equal(filter.isEcho(event('play')), false);
  assert.equal(filter.isEcho(event('status')), false);
});
