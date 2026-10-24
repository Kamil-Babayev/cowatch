import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { elementVisibleArea, scanMedia, shadowRootOf, touchesMedia } from './media-scan.ts';

function setRect(element: Element, rect: { left: number; top: number; width: number; height: number }): void {
  element.getBoundingClientRect = () => ({
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    toJSON: () => rect,
  });
}

test('scanMedia finds players nested in open shadow roots', () => {
  const dom = new JSDOM('<!doctype html><video id="a"></video><x-player></x-player><iframe id="f"></iframe>');
  const document = dom.window.document;
  const host = document.querySelector('x-player')!;
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<div><video id="b"></video><y-inner></y-inner></div>';
  const inner = shadow.querySelector('y-inner')!.attachShadow({ mode: 'open' });
  inner.innerHTML = '<iframe id="g"></iframe>';

  const scan = scanMedia(document);
  assert.deepEqual(scan.videos.map((video) => video.id).sort(), ['a', 'b']);
  assert.deepEqual(scan.iframes.map((iframe) => iframe.id).sort(), ['f', 'g']);
  assert.equal(scan.shadowRoots.length, 2);
  dom.window.close();
});

test('shadowRootOf prefers the Firefox closed-root accessor', () => {
  const dom = new JSDOM('<!doctype html><div></div>');
  const div = dom.window.document.querySelector('div')!;
  assert.equal(shadowRootOf(div), null);
  const closed = {} as ShadowRoot;
  Object.defineProperty(div, 'openOrClosedShadowRoot', { value: closed });
  assert.equal(shadowRootOf(div), closed);
  dom.window.close();
});

test('touchesMedia ignores unrelated nodes', () => {
  const dom = new JSDOM('<!doctype html><p>text</p><div><video></video></div><iframe></iframe>');
  const document = dom.window.document;
  assert.equal(touchesMedia(document.querySelector('p')!), false);
  assert.equal(touchesMedia(document.querySelector('p')!.firstChild!), false);
  assert.equal(touchesMedia(document.querySelector('div')!), true);
  assert.equal(touchesMedia(document.querySelector('iframe')!), true);
  const host = document.createElement('span');
  host.attachShadow({ mode: 'open' });
  assert.equal(touchesMedia(host), true);
  dom.window.close();
});

test('elementVisibleArea clips to the viewport and ignores hidden elements', () => {
  const dom = new JSDOM('<!doctype html><video></video>', { pretendToBeVisual: true });
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: 1000 });
  Object.defineProperty(window, 'innerHeight', { value: 800 });
  const video = window.document.querySelector('video')!;
  setRect(video, { left: -100, top: 700, width: 400, height: 200 });
  assert.equal(elementVisibleArea(video), 300 * 100);
  video.style.opacity = '0';
  assert.equal(elementVisibleArea(video), 0);
  video.style.opacity = '';
  video.style.display = 'none';
  assert.equal(elementVisibleArea(video), 0);
  dom.window.close();
});
