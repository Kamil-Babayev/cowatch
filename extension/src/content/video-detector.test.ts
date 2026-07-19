import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { pickLargestVisible, VideoDetector } from './video-detector.ts';

// jsdom has no real layout engine, so every element's getBoundingClientRect
// is zero by default — tests set it explicitly per element to simulate size.
function withRect(el: HTMLVideoElement, width: number, height: number): HTMLVideoElement {
  el.getBoundingClientRect = () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} }) as DOMRect;
  return el;
}

before(() => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  global.document = dom.window.document as unknown as Document;
  global.MutationObserver = dom.window.MutationObserver as unknown as typeof MutationObserver;
  global.HTMLVideoElement = dom.window.HTMLVideoElement as unknown as typeof HTMLVideoElement;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

test('pickLargestVisible picks the biggest of several candidates', () => {
  const small = withRect(document.createElement('video'), 100, 100);
  const big = withRect(document.createElement('video'), 800, 450);
  const ad = withRect(document.createElement('video'), 300, 200);

  const result = pickLargestVisible([small, ad, big]);
  assert.equal(result, big);
});

test('pickLargestVisible falls back to the first candidate when none have area', () => {
  const first = document.createElement('video'); // no rect override — 0x0
  const second = document.createElement('video');

  const result = pickLargestVisible([first, second]);
  assert.equal(result, first);
});

test('pickLargestVisible returns null for an empty list', () => {
  assert.equal(pickLargestVisible([]), null);
});

test('VideoDetector auto-picks the largest video present at construction', () => {
  document.body.appendChild(withRect(document.createElement('video'), 200, 200));
  const big = withRect(document.createElement('video'), 1000, 600);
  document.body.appendChild(big);

  const detector = new VideoDetector(document);
  assert.equal(detector.getCurrent(), big);
  detector.destroy();
});

test('VideoDetector re-evaluates when a video is added later', async () => {
  const detector = new VideoDetector(document);
  assert.equal(detector.getCurrent(), null);

  const late = withRect(document.createElement('video'), 640, 360);
  document.body.appendChild(late);

  // MutationObserver callbacks fire as a microtask, not synchronously.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(detector.getCurrent(), late);
  detector.destroy();
});

test('selectOverride pins the choice regardless of size, until cleared', () => {
  const big = withRect(document.createElement('video'), 1000, 600);
  const small = withRect(document.createElement('video'), 100, 100);
  document.body.append(big, small);

  const detector = new VideoDetector(document);
  assert.equal(detector.getCurrent(), big);

  detector.selectOverride(small);
  assert.equal(detector.getCurrent(), small);

  detector.clearOverride();
  assert.equal(detector.getCurrent(), big);
  detector.destroy();
});

test('override falls back to auto-pick if the overridden element is removed', async () => {
  const big = withRect(document.createElement('video'), 1000, 600);
  const small = withRect(document.createElement('video'), 100, 100);
  document.body.append(big, small);

  const detector = new VideoDetector(document);
  detector.selectOverride(small);
  assert.equal(detector.getCurrent(), small);

  small.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(detector.getCurrent(), big);
  detector.destroy();
});

test('onChange fires only when the selected video actually changes', () => {
  const changes: (HTMLVideoElement | null)[] = [];
  const detector = new VideoDetector(document);
  detector.onChange((v) => changes.push(v));

  const video = withRect(document.createElement('video'), 640, 360);
  document.body.appendChild(video);
  detector.selectOverride(video); // manual call — no need to wait on MutationObserver here
  detector.selectOverride(video); // same video again — should not re-fire

  assert.equal(changes.length, 1);
  assert.equal(changes[0], video);
  detector.destroy();
});
