import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageKey, samePage } from './page-key.ts';

test('pageKey: keeps the meaningful query and drops fragments and tracking', () => {
  assert.equal(
    pageKey('https://www.youtube.com/watch?v=abc&t=42s&utm_source=x&si=share#comments'),
    'https://www.youtube.com/watch?v=abc',
  );
});

test('pageKey: sorts parameters so their order does not matter', () => {
  assert.equal(pageKey('https://a.example/v?b=2&a=1'), 'https://a.example/v?a=1&b=2');
  assert.equal(pageKey('https://a.example/v'), 'https://a.example/v');
});

test('pageKey: returns unparseable input unchanged', () => {
  assert.equal(pageKey('not a url'), 'not a url');
});

test('samePage: distinguishes different videos but not share links', () => {
  assert.equal(samePage('https://a.example/v?id=1&t=5', 'https://a.example/v?id=1'), true);
  assert.equal(samePage('https://a.example/v?id=1', 'https://a.example/v?id=2'), false);
});
