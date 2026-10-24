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

const fast = { queryTimeoutMs: 20, probeAttempts: 4, probeRetryMs: 20 };

test('PlayerJS probe retries until a slow player answers', async () => {
  const adapter = new PlayerJSAdapter('obrut-4', iframe, fast);
  const commands: Array<{ message: unknown; origin: string }> = [];
  setTimeout(() => installResponder({ id: 'player', time: 3, playing: true }, commands), 30);
  await adapter.probe(new AbortController().signal);
  assert.equal((await adapter.getState()).status, 'playing');
  adapter.dispose();
});

test('PlayerJS probe gives up after its attempts and honours abort', async () => {
  const adapter = new PlayerJSAdapter('obrut-5', iframe, fast);
  await assert.rejects(adapter.probe(new AbortController().signal), /did not respond/);
  const controller = new AbortController();
  const pending = adapter.probe(controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  adapter.dispose();
  await assert.rejects(adapter.probe(new AbortController().signal), (error: Error) => error.name === 'AbortError');
});

test('PlayerJS buffering resumes the previous state and host buffering holds joiners', async () => {
  const commands: Array<{ message: unknown; origin: string }> = [];
  installResponder({ id: 'player', time: 10, playing: false }, commands);
  const adapter = new PlayerJSAdapter('obrut-6', iframe, fast);
  await adapter.probe(new AbortController().signal);
  const events: Array<{ action: string; status: string }> = [];
  adapter.subscribe((event) => events.push({ action: event.action, status: event.status }));
  const send = (data: unknown) => window.dispatchEvent(new dom.window.MessageEvent('message', {
    source: iframe.contentWindow,
    origin: 'https://cdn2.obrut.show',
    data,
  }));
  send({ event: 'buffering' });
  send({ event: 'buffered' });
  send(JSON.stringify({ event: 'new' }));
  send({ event: 'finish' });
  send({ event: 'duration', data: 99 });
  send({ event: 'time', data: 12 });
  send({ event: 'unknown' });
  send('not json');
  assert.deepEqual(events, [
    { action: 'buffering', status: 'buffering' },
    { action: 'status', status: 'paused' },
    { action: 'replace', status: 'loading' },
    { action: 'ended', status: 'ended' },
  ]);
  const before = commands.length;
  await adapter.apply({
    revision: 1,
    source: (await adapter.getState()).source,
    position: 50,
    status: 'buffering',
    timestamp: Date.now(),
  });
  assert.equal(commands.length, before + 2, 'only the getState queries, no commands');
  assert.ok(commands.slice(-2).every((item) => item.origin === 'https://cdn2.obrut.show'), 'follows the answering origin');
  adapter.dispose();
});

test('PlayerJS switches source itself and recognises its own navigation', async () => {
  const commands: Array<{ message: unknown; origin: string }> = [];
  installResponder({ id: 'player', time: 0, playing: false }, commands);
  const adapter = new PlayerJSAdapter('obrut-7', iframe, fast);
  await adapter.probe(new AbortController().signal);
  await adapter.apply({
    revision: 1,
    source: { pageUrl: 'https://watch.example/movie', provider: 'obrut', mediaKey: 'https://abc.obrut.show/embed/two' },
    position: 30,
    status: 'paused',
    timestamp: Date.now(),
  });
  assert.equal(iframe.src, 'https://abc.obrut.show/embed/two');
  assert.equal(adapter.expectsSource('https://abc.obrut.show/embed/two'), true);
  assert.equal(adapter.expectsSource('https://abc.obrut.show/embed/three'), false);
  installResponder({ id: 'player', time: 0, playing: false }, commands);
  iframe.dispatchEvent(new dom.window.Event('load'));
  for (let i = 0; i < 20 && !commands.some((item) => (item.message as { api: string }).api === 'seek'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(commands.some((item) => {
    const value = item.message as { api: string; set?: unknown };
    return value.api === 'seek' && Number(value.set) === 30;
  }), 'the queued state is applied once the new player answers');
  adapter.dispose();
});
