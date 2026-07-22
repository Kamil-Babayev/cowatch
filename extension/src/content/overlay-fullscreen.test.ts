import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { reparentForFullscreen } from './overlay-fullscreen.ts';

before(() => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  global.document = dom.window.document as unknown as Document;
});

beforeEach(() => {
  document.body.innerHTML = '';
});

test('moves host into the fullscreen element when one exists', () => {
  const fsElement = document.createElement('div');
  fsElement.id = 'fs-target';
  document.body.appendChild(fsElement);

  const host = document.createElement('div');
  document.body.appendChild(host);

  reparentForFullscreen(host, () => fsElement, document.body);

  assert.equal(host.parentElement, fsElement);
});

test('moves host back to the fallback parent when fullscreen exits (null)', () => {
  const fsElement = document.createElement('div');
  document.body.appendChild(fsElement);

  const host = document.createElement('div');
  fsElement.appendChild(host); // simulate it currently living inside the fullscreen element

  reparentForFullscreen(host, () => null, document.body);

  assert.equal(host.parentElement, document.body);
});

test('is a no-op if host is already in the right place (no redundant move)', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);

  let appendCalls = 0;
  const realAppend = document.body.appendChild.bind(document.body);
  document.body.appendChild = ((node: Node) => {
    appendCalls++;
    return realAppend(node);
  }) as typeof document.body.appendChild;

  reparentForFullscreen(host, () => null, document.body);

  assert.equal(appendCalls, 0);
  document.body.appendChild = realAppend;
});

test('re-parenting an element with children (e.g. the shadow host) moves the whole subtree intact', () => {
  const fsElement = document.createElement('div');
  document.body.appendChild(fsElement);

  const host = document.createElement('div');
  const child = document.createElement('span');
  child.textContent = 'still here';
  host.appendChild(child);
  document.body.appendChild(host);

  reparentForFullscreen(host, () => fsElement, document.body);

  assert.equal(host.parentElement, fsElement);
  assert.equal(host.firstChild, child);
  assert.equal(child.textContent, 'still here');
});
