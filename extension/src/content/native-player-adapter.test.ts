import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { NativePlayerAdapter } from './native-player-adapter.ts';

let dom: JSDOM;
let video: HTMLVideoElement;
let paused = true;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><video src="https://cdn.example/one.mp4"></video>', {
    url: 'https://watch.example/movie',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    DOMException: dom.window.DOMException,
    HTMLMediaElement: dom.window.HTMLMediaElement,
  });
  video = document.querySelector('video')!;
  paused = true;
  Object.defineProperties(video, {
    paused: { configurable: true, get: () => paused },
    ended: { configurable: true, get: () => false },
    readyState: { configurable: true, get: () => 4 },
    duration: { configurable: true, get: () => 100 },
  });
  video.play = async () => { paused = false; };
  video.pause = () => { paused = true; };
  video.load = () => undefined;
});

afterEach(() => dom.window.close());

test('native adapter reports capabilities and playback events', async () => {
  const adapter = new NativePlayerAdapter('video-1', video);
  const capabilities = await adapter.probe(new AbortController().signal);
  assert.equal(capabilities.canSetRate, true);
  const events: string[] = [];
  adapter.subscribe((event) => events.push(event.action));
  video.currentTime = 3;
  video.dispatchEvent(new dom.window.Event('play'));
  await Promise.resolve();
  assert.deepEqual(events, ['play']);
  adapter.dispose();
});

test('native adapter applies authoritative play, pause, and source replacement', async () => {
  const adapter = new NativePlayerAdapter('video-2', video);
  await adapter.probe(new AbortController().signal);
  const source = (await adapter.getState()).source;
  await adapter.apply({
    revision: 1,
    source,
    position: 20,
    status: 'playing',
    timestamp: Date.now(),
  });
  assert.equal(paused, false);
  assert.ok(video.currentTime >= 20);
  await adapter.apply({
    revision: 2,
    source,
    position: 20.5,
    status: 'paused',
    timestamp: Date.now(),
  });
  assert.equal(paused, true);
  await adapter.loadSource({ ...source, mediaKey: 'https://cdn.example/two.mp4' });
  assert.equal(video.src, 'https://cdn.example/two.mp4');
  adapter.dispose();
});

test('native adapter rejects non-http media replacement', async () => {
  const adapter = new NativePlayerAdapter('video-3', video);
  const source = (await adapter.getState()).source;
  await assert.rejects(adapter.loadSource({ ...source, mediaKey: 'javascript:alert(1)' }));
  adapter.dispose();
});
