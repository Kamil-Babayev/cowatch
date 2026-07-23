import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlaybackState,
  correctedPlaybackState,
  correctionForHeartbeat,
} from './playback-sync.ts';

test('correctedPlaybackState advances a playing snapshot', () => {
  assert.deepEqual(
    correctedPlaybackState(
      { currentTime: 10, isPlaying: true },
      1_000,
      4_000,
    ),
    { currentTime: 13, isPlaying: true },
  );
});

test('correctionForHeartbeat uses the element current time and threshold', () => {
  assert.equal(
    correctionForHeartbeat(
      10,
      { currentTime: 10.5, isPlaying: false },
      1_000,
      1_000,
    ),
    null,
  );
  assert.deepEqual(
    correctionForHeartbeat(
      10,
      { currentTime: 13, isPlaying: false },
      1_000,
      1_000,
    ),
    { currentTime: 13, isPlaying: false },
  );
});

test('applyPlaybackState seeks and restores play/pause', async () => {
  let played = 0;
  let paused = 0;
  const video = {
    currentTime: 0,
    paused: true,
    play: async () => {
      played++;
    },
    pause: () => {
      paused++;
    },
  } as unknown as HTMLVideoElement;
  await applyPlaybackState(video, { currentTime: 5, isPlaying: true });
  assert.equal(video.currentTime, 5);
  assert.equal(played, 1);

  Object.defineProperty(video, 'paused', { value: false, configurable: true });
  await applyPlaybackState(video, { currentTime: -2, isPlaying: false });
  assert.equal(video.currentTime, 0);
  assert.equal(paused, 1);
});
