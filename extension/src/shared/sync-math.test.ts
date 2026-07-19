import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldCorrectDrift, computeJoinSeekTarget } from './sync-math.ts';

test('shouldCorrectDrift: false for small gaps', () => {
  assert.equal(shouldCorrectDrift(100, 100.8), false);
});

test('shouldCorrectDrift: true past the threshold', () => {
  assert.equal(shouldCorrectDrift(100, 102), true);
});

test('shouldCorrectDrift: symmetric regardless of which side is ahead', () => {
  assert.equal(shouldCorrectDrift(102, 100), true);
});

test('shouldCorrectDrift: exactly at the threshold is not over it', () => {
  assert.equal(shouldCorrectDrift(100, 101.5, 1.5), false);
});

test('computeJoinSeekTarget: paused state — no time added regardless of elapsed', () => {
  const result = computeJoinSeekTarget(50, false, Date.now() - 10_000, Date.now());
  assert.equal(result, 50);
});

test('computeJoinSeekTarget: playing state — adds elapsed wall-clock time', () => {
  const stateTimestamp = 1_000_000;
  const now = 1_003_000; // 3 seconds later
  const result = computeJoinSeekTarget(50, true, stateTimestamp, now);
  assert.equal(result, 53);
});

test('computeJoinSeekTarget: never returns a value before the recorded time (no negative elapsed)', () => {
  // A stale/out-of-order timestamp shouldn't cause a seek backwards past
  // the recorded position.
  const result = computeJoinSeekTarget(50, true, /* stateTimestamp */ 2_000, /* now */ 1_000);
  assert.equal(result, 50);
});
