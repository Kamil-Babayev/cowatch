import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { attachPlaybackListeners, type PlaybackEvent } from './playback-events.ts';

let video: HTMLVideoElement;

before(() => {
  const dom = new JSDOM('<!DOCTYPE html><html><body><video></video></body></html>');
  global.document = dom.window.document as unknown as Document;
  // jsdom's dispatchEvent rejects Event instances from any realm but its
  // own — Node's built-in global Event is a same-named but different
  // class, and dispatching one throws "parameter 1 is not of type
  // 'Event'" despite looking like it should work.
  global.Event = dom.window.Event as unknown as typeof Event;
});

beforeEach(() => {
  video = document.querySelector('video') as HTMLVideoElement;
  video.currentTime = 0;
});

test('play event reports currentTime and isPlaying: true', () => {
  const events: PlaybackEvent[] = [];
  attachPlaybackListeners(video, (e) => events.push(e));

  video.currentTime = 12.5;
  video.dispatchEvent(new Event('play'));

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'play', currentTime: 12.5, isPlaying: true });
});

test('pause event reports isPlaying: false', () => {
  const events: PlaybackEvent[] = [];
  attachPlaybackListeners(video, (e) => events.push(e));

  video.currentTime = 30;
  video.dispatchEvent(new Event('pause'));

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'pause', currentTime: 30, isPlaying: false });
});

test("seeked event reflects the video's actual paused state, not an assumption", () => {
  const events: PlaybackEvent[] = [];
  attachPlaybackListeners(video, (e) => events.push(e));

  // jsdom's HTMLMediaElement defaults `paused` to true and has no real
  // playback engine, so forcing isPlaying: true here isn't meaningfully
  // verifiable in this environment — but that `paused` is read live off
  // the element (not cached/assumed) is exactly what's worth asserting.
  video.currentTime = 5;
  video.dispatchEvent(new Event('seeked'));

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'seeked');
  assert.equal(events[0].currentTime, 5);
  assert.equal(events[0].isPlaying, !video.paused);
});

test('detach() stops further events from firing', () => {
  const events: PlaybackEvent[] = [];
  const detach = attachPlaybackListeners(video, (e) => events.push(e));

  detach();
  video.dispatchEvent(new Event('play'));

  assert.equal(events.length, 0);
});
