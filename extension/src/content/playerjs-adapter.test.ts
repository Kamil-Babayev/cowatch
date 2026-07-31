import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { PlayerJSAdapter, isObrutPlayerFrame } from './playerjs-adapter.ts';

let dom: JSDOM;
let iframe: HTMLIFrameElement;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><iframe src="https://abc.obrut.show/embed/one"></iframe>', {
    url: 'https://watch.example/movie',
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    DOMException: dom.window.DOMException,
  });
  iframe = document.querySelector('iframe')!;
});

afterEach(() => dom.window.close());

function installResponder(values: Record<string, unknown>, commands: Array<{ message: unknown; origin: string }>): void {
  const child = iframe.contentWindow!;
  child.postMessage = ((message: unknown, origin: string) => {
    commands.push({ message, origin });
    const api = (message as { api: string }).api;
    if (!(api in values)) return;
    queueMicrotask(() => {
      window.dispatchEvent(new dom.window.MessageEvent('message', {
        source: child,
        origin: 'https://abc.obrut.show',
        data: { event: api, answer: values[api] },
      }));
    });
  }) as typeof child.postMessage;
}

test('recognizes only obrut iframe origins', () => {
  assert.equal(isObrutPlayerFrame(iframe), true);
  iframe.src = 'https://example.com/embed';
  assert.equal(isObrutPlayerFrame(iframe), false);
});

test('PlayerJS probe uses the documented postMessage handshake and exact origin', async () => {
  const commands: Array<{ message: unknown; origin: string }> = [];
  installResponder({ id: 'player', time: 12, playing: false }, commands);
  const adapter = new PlayerJSAdapter('obrut-1', iframe);
  const capabilities = await adapter.probe(new AbortController().signal);
  assert.equal(capabilities.canSeek, true);
  assert.deepEqual(commands.map((item) => (item.message as { api: string }).api), ['id', 'time', 'playing']);
  assert.ok(commands.every((item) => item.origin === 'https://abc.obrut.show'));
  assert.deepEqual(await adapter.getState(), {
    source: {
      pageUrl: 'https://watch.example/movie',
      provider: 'obrut',
      mediaKey: 'https://abc.obrut.show/embed/one',
    },
    position: 12,
    status: 'paused',
    duration: undefined,
  });
  adapter.dispose();
});

test('PlayerJS events and remote commands are routed without reading iframe DOM', async () => {
  const commands: Array<{ message: unknown; origin: string }> = [];
  installResponder({ id: 'player', time: 10, playing: false }, commands);
  const adapter = new PlayerJSAdapter('obrut-2', iframe);
  await adapter.probe(new AbortController().signal);
  const events: string[] = [];
  adapter.subscribe((event) => events.push(event.action));
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: iframe.contentWindow,
    origin: 'https://evil.example',
    data: { event: 'play' },
  }));
  window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: iframe.contentWindow,
    origin: 'https://abc.obrut.show',
    data: { event: 'userplay' },
  }));
  assert.deepEqual(events, ['play']);

  await adapter.apply({
    revision: 1,
    source: (await adapter.getState()).source,
    position: 20,
    status: 'playing',
    timestamp: Date.now(),
  });
  const apiCalls = commands.map((item) => item.message as { api: string; set?: unknown });
  assert.ok(apiCalls.some((item) => item.api === 'seek' && Number(item.set) >= 20));
  assert.ok(apiCalls.some((item) => item.api === 'play'));
  adapter.dispose();
});

test('PlayerJS keeps only the newest state while the handshake is pending', async () => {
  const commands: Array<{ message: unknown; origin: string }> = [];
  const adapter = new PlayerJSAdapter('obrut-3', iframe);
  const source = {
    pageUrl: 'https://watch.example/movie',
    provider: 'obrut' as const,
    mediaKey: 'https://abc.obrut.show/embed/one',
  };
  await adapter.apply({ revision: 1, source, position: 5, status: 'paused', timestamp: Date.now() });
  await adapter.apply({ revision: 2, source, position: 9, status: 'playing', timestamp: Date.now() });
  installResponder({ id: 'player', time: 0, playing: false }, commands);
  await adapter.probe(new AbortController().signal);
  assert.ok(commands.some((item) => {
    const value = item.message as { api: string; set?: unknown };
    return value.api === 'seek' && Number(value.set) >= 9;
  }));
  adapter.dispose();
});
