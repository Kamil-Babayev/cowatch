import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClockOffset } from './clock.ts';

test('ClockOffset: zero until a sample arrives', () => {
  const clock = new ClockOffset();
  assert.equal(clock.offset, 0);
  assert.equal(clock.toLocal(5000), 5000);
});

test('ClockOffset: assumes the server read its clock mid round trip', () => {
  const clock = new ClockOffset();
  // Sent at 1000, answered at 1100 local; server said 3050 => +2000 offset.
  clock.addSample(1000, 3050, 1100);
  assert.equal(clock.offset, 2000);
  assert.equal(clock.toLocal(5000), 3000);
});

test('ClockOffset: prefers the shortest round trip and ignores bad samples', () => {
  const clock = new ClockOffset(3);
  clock.addSample(0, 600, 400); // rtt 400 => offset 400
  clock.addSample(1000, 1520, 1040); // rtt 40 => offset 500
  clock.addSample(2000, 2000, 1000); // negative rtt, dropped
  assert.equal(clock.offset, 500);
  clock.addSample(3000, 3800, 3200);
  clock.addSample(4000, 4800, 4200);
  clock.addSample(5000, 5800, 5200); // the rtt-40 sample is evicted
  assert.equal(clock.offset, 700);
});
