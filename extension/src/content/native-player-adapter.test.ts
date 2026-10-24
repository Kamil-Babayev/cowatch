import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { NativePlayerAdapter } from './native-player-adapter.ts';
import type { AuthoritativePlayerState, PlayerEvent } from '../shared/player.ts';

let dom: JSDOM;
let video: HTMLVideoElement;
let paused = true;
let readyState = 4;
let now = 100_000;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><video src="blob:https://watch.example/1234"></video>', {
    url: 'https://watch.example/movie?id=7&utm_source=share',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    DOMException: dom.window.DOMException,
    HTMLMediaElement: dom.window.HTMLMediaElement,
  });
  video = document.querySelector('video')!;
  paused = true;
  readyState = 4;
  now = 100_000;
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => paused },
    ended: { configurable: true, get: () => false },
    readyState: { configurable: true, get: () => readyState },
    duration: { configurable: true, get: () => 100 },
  });
  video.play = async () => {
    paused = false;
    video.dispatchEvent(new dom.window.Event('play'));
  };
  video.pause = () => {
    paused = true;
    video.dispatchEvent(new dom.window.Event('pause'));
  };
});

afterEach(() => dom.window.close());

function adapter(): NativePlayerAdapter {
  return new NativePlayerAdapter('video-1', video, () => now);
}

function state(position: number, status: AuthoritativePlayerState['status'], timestamp = now): AuthoritativePlayerState {
  return {
    revision: 1,
    source: { pageUrl: 'https://watch.example/movie', provider: 'native', mediaKey: 'https://watch.example/movie?id=7' },
    position,
    status,
    timestamp,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('identifies the media by page, never by the blob URL', async () => {
  const player = adapter();
  assert.equal((await player.probe(new AbortController().signal)).canSetRate, true);
  const snapshot = await player.getState();
  assert.equal(snapshot.source.mediaKey, 'https://watch.example/movie?id=7');
  assert.equal(snapshot.status, 'paused');
  readyState = 1;
  assert.equal((await player.getState()).status, 'loading');
  paused = false;
  assert.equal((await player.getState()).status, 'buffering');
  player.dispose();
  await assert.rejects(player.probe(new AbortController().signal));
});

test('reports user actions and state changes', async () => {
  const player = adapter();
  const events: Array<Pick<PlayerEvent, 'action' | 'status'>> = [];
  player.subscribe((event) => events.push({ action: event.action, status: event.status }));
  for (const name of ['play', 'pause', 'seeked', 'waiting', 'playing', 'ended']) {
    video.dispatchEvent(new dom.window.Event(name));
  }
  await settle();
  assert.deepEqual(events.map((event) => event.action), ['play', 'pause', 'seek', 'buffering', 'status', 'ended']);
  assert.equal(events[3].status, 'buffering');
  player.dispose();
  video.dispatchEvent(new dom.window.Event('play'));
  await settle();
  assert.equal(events.length, 6, 'no events after dispose');
});

test('applying a state seeks and plays without echoing it back', async () => {
  const player = adapter();
  const events: string[] = [];
  player.subscribe((event) => events.push(event.action));
  await player.apply(state(20, 'playing', now - 2000));
  assert.equal(paused, false);
  assert.equal(video.currentTime, 22);
  video.dispatchEvent(new dom.window.Event('seeked'));
  await settle();
  assert.deepEqual(events, [], 'play and seeked caused by the sync are not reported');

  // A user seek elsewhere moments later is still heard.
  video.currentTime = 60;
  video.dispatchEvent(new dom.window.Event('seeked'));
  await settle();
  assert.deepEqual(events, ['seek']);

  await player.apply(state(60, 'paused'));
  assert.equal(paused, true);
  player.dispose();
});

test('small drift is nudged relative to the user speed, large drift seeks', async () => {
  const player = adapter();
  video.playbackRate = 1.5;
  video.dispatchEvent(new dom.window.Event('ratechange'));
  await player.apply(state(10, 'playing'));
  assert.equal(video.currentTime, 10);
  video.currentTime = 9.5;
  await player.apply(state(10, 'playing'));
  assert.equal(video.currentTime, 9.5, 'no seek for half a second');
  assert.ok(Math.abs(video.playbackRate - 1.575) < 1e-9);
  video.currentTime = 10;
  await player.apply(state(10, 'playing'));
  assert.equal(video.playbackRate, 1.5, 'back to the user speed once in sync');
  video.currentTime = 2;
  await player.apply(state(10, 'playing'));
  assert.equal(video.currentTime, 10);
  player.dispose();
});

test('the first state seeks even for moderate drift', async () => {
  const player = adapter();
  video.currentTime = 9.5;
  await player.apply(state(10, 'playing'));
  assert.equal(video.currentTime, 10);
  player.dispose();
});

test('host buffering holds the joiner instead of pausing it', async () => {
  const player = adapter();
  await player.apply(state(10, 'playing'));
  video.currentTime = 11;
  await player.apply(state(10, 'buffering'));
  assert.equal(paused, false);
  assert.equal(video.currentTime, 11);
  player.dispose();
});

test('a blocked autoplay does not make later states hard-seek', async () => {
  const player = adapter();
  video.play = async () => {
    throw new DOMException('blocked', 'NotAllowedError');
  };
  await assert.rejects(player.apply(state(10, 'playing')));
  video.currentTime = 10.5;
  await assert.rejects(player.apply(state(10, 'playing')));
  assert.equal(video.currentTime, 10.5, 'moderate drift nudges once a state was applied');
  player.dispose();
  await player.apply(state(50, 'paused'));
  assert.equal(video.currentTime, 10.5, 'disposed adapters ignore states');
});
