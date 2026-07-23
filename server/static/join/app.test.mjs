import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const stateIds = [
  'state-loading',
  'state-valid',
  'state-expired',
  'state-not-found',
  'state-no-extension',
  'state-error',
];

class FakeElement {
  constructor() {
    this.hidden = true;
    this.disabled = false;
    this.textContent = '';
    this.attributes = new Map();
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((candidate) => candidate !== listener),
    );
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  click() {
    for (const listener of [...(this.listeners.get('click') ?? [])]) listener();
  }
}

class FakeCustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}

async function render({
  search = '?token=join-token',
  status = 200,
  body = { roomId: 'room-1', videoUrl: 'https://video.example/watch' },
  extension = true,
  networkError = false,
} = {}) {
  const elements = Object.fromEntries(
    [...stateIds, 'destination-domain', 'continue-btn', 'retry-btn'].map((id) => [
      id,
      new FakeElement(),
    ]),
  );
  const windowListeners = new Map();
  const joinRequests = [];
  const window = {
    location: { search },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener(type, listener) {
      windowListeners.set(
        type,
        (windowListeners.get(type) ?? []).filter((candidate) => candidate !== listener),
      );
    },
    dispatchEvent(event) {
      if (event.type === 'cowatch:join-requested') joinRequests.push(event.detail);
      for (const listener of [...(windowListeners.get(event.type) ?? [])]) listener(event);
      if (event.type === 'cowatch:extension-check' && extension) {
        queueMicrotask(() => window.dispatchEvent(new FakeCustomEvent('cowatch:extension-detected')));
      }
      return true;
    },
  };

  const fetch = async () => {
    if (networkError) throw new Error('offline');
    return { status, json: async () => body };
  };
  const fastTimeout = (callback) => setTimeout(callback, 2);

  vm.runInNewContext(source, {
    window,
    document: { getElementById: (id) => elements[id] },
    fetch,
    URL,
    URLSearchParams,
    CustomEvent: FakeCustomEvent,
    Promise,
    console,
    queueMicrotask,
    setTimeout: fastTimeout,
    clearTimeout,
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  return { elements, joinRequests };
}

function visibleState(elements) {
  return stateIds.find((id) => !elements[id].hidden);
}

test('landing renders a valid resolved destination', async () => {
  const { elements } = await render();
  assert.equal(visibleState(elements), 'state-valid');
  assert.equal(elements['destination-domain'].textContent, 'video.example');
});

test('landing distinguishes expired and unknown links', async () => {
  assert.equal(visibleState((await render({ status: 410 })).elements), 'state-expired');
  assert.equal(visibleState((await render({ status: 404 })).elements), 'state-not-found');
});

test('landing handles a missing token without calling the server', async () => {
  const { elements } = await render({ search: '' });
  assert.equal(visibleState(elements), 'state-not-found');
});

test('landing asks for installation only after a valid link resolves', async () => {
  const { elements } = await render({ extension: false });
  assert.equal(visibleState(elements), 'state-no-extension');
});

test('landing exposes a retryable network error', async () => {
  const { elements } = await render({ networkError: true });
  assert.equal(visibleState(elements), 'state-error');
});

test('Continue dispatches once and becomes busy', async () => {
  const { elements, joinRequests } = await render();
  elements['continue-btn'].click();
  elements['continue-btn'].click();
  assert.equal(joinRequests.length, 1);
  assert.equal(joinRequests[0].roomId, 'room-1');
  assert.equal(joinRequests[0].videoUrl, 'https://video.example/watch');
  assert.equal(elements['continue-btn'].disabled, true);
  assert.equal(elements['continue-btn'].attributes.get('aria-busy'), 'true');
});
