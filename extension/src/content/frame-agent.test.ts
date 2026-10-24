import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { FrameAgent, type AdapterFactory, type FrameRuntime } from './frame-agent.ts';
import type { ToBackgroundMessage } from '../shared/runtime-messages.ts';
import type {
  AuthoritativePlayerState,
  PlayerAdapter,
  PlayerCapabilities,
  PlayerEvent,
  PlayerSnapshot,
} from '../shared/player.ts';
import type { FrameVideoStatus } from '../shared/video-frames.ts';

const capabilities: PlayerCapabilities = { canPlay: true, canPause: true, canSeek: true, canLoadSource: false, canSetRate: true };

class FakeAdapter implements PlayerAdapter {
  readonly id: string;
  readonly provider: 'native' | 'obrut';
  element: Element;
  listeners = new Set<(event: PlayerEvent) => void>();
  applied: AuthoritativePlayerState[] = [];
  disposed = false;
  probeResult: Promise<PlayerCapabilities>;
  resolveProbe!: () => void;
  rejectProbe!: (error: Error) => void;
  state: PlayerSnapshot;
  hangState = false;
  applyDelay = 0;
  expected: string | null = null;

  constructor(id: string, provider: 'native' | 'obrut', element: Element, autoReady: boolean) {
    this.id = id;
    this.provider = provider;
    this.element = element;
    this.probeResult = new Promise((resolve, reject) => {
      this.resolveProbe = () => resolve(capabilities);
      this.rejectProbe = reject;
    });
    if (autoReady) this.resolveProbe();
    this.state = {
      source: { pageUrl: 'https://page.example/', provider, mediaKey: 'https://page.example/' },
      position: 7,
      status: 'playing',
    };
  }

  probe(): Promise<PlayerCapabilities> {
    return this.probeResult;
  }

  getState(): Promise<PlayerSnapshot> {
    return this.hangState ? new Promise(() => undefined) : Promise.resolve(this.state);
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async apply(state: AuthoritativePlayerState): Promise<void> {
    if (this.applyDelay) await new Promise((resolve) => setTimeout(resolve, this.applyDelay));
    if (state.position < 0) throw new Error('bad state');
    this.applied.push(state);
  }

  expectsSource(src: string): boolean {
    return src === this.expected;
  }

  dispose(): void {
    this.disposed = true;
  }

  emit(action: PlayerEvent['action']): void {
    for (const listener of this.listeners) listener({ ...this.state, action });
  }
}

let dom: JSDOM | null = null;
afterEach(() => {
  dom?.window.close();
  dom = null;
});

function setup(html: string, options: { autoReady?: boolean; url?: string } = {}) {
  dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url: options.url ?? 'https://page.example/' });
  const window = dom.window as unknown as Window;
  const sent: ToBackgroundMessage[] = [];
  const created: FakeAdapter[] = [];
  const runtime: FrameRuntime = {
    sendMessage: async (message) => {
      sent.push(message);
    },
    getFrameId: (target) => {
      if ((target as unknown as { blocked?: boolean }).blocked) throw new Error('unknown frame');
      return 42;
    },
  };
  const adapters: AdapterFactory = {
    native: (id, video) => {
      const adapter = new FakeAdapter(id, 'native', video, options.autoReady ?? true);
      created.push(adapter);
      return adapter;
    },
    obrut: (id, iframe) => {
      const adapter = new FakeAdapter(id, 'obrut', iframe, options.autoReady ?? true);
      created.push(adapter);
      return adapter;
    },
    isObrutFrame: (iframe) => iframe.src.includes('obrut.show'),
  };
  let prefixes = 0;
  const agent = new FrameAgent(window, runtime, adapters, {
    heartbeatMs: 20,
    debounceMs: 5,
    maxWaitMs: 20,
    stateTimeoutMs: 20,
    probeGraceMs: 10,
    newDocumentPrefix: () => `doc${++prefixes}`,
  });
  return { agent, window: dom.window, document: dom.window.document, sent, created };
}

async function tick(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await tick(10);
  }
  throw new Error(message);
}

async function status(agent: FrameAgent): Promise<FrameVideoStatus> {
  return (await agent.handleMessage({ kind: 'frameVideoStatusRequest' })) as FrameVideoStatus;
}

test('reports videos with per-document ids, including shadow DOM players', async () => {
  const { agent, document, sent } = setup('<video></video><x-player></x-player>');
  document.querySelector('x-player')!.attachShadow({ mode: 'open' }).innerHTML = '<video></video>';
  agent.init();
  await until(() => sent.some((message) => message.kind === 'frameVideoCandidatesChanged'), 'no change report');
  const result = await status(agent);
  assert.deepEqual(result.candidates.map((candidate) => candidate.candidateId).sort(), ['doc1-video-1', 'doc1-video-2']);
  assert.equal(result.candidates[0].currentTime, 7);
  agent.dispose();
});

test('a restored document gets fresh candidate ids', async () => {
  const { agent } = setup('<video></video>');
  agent.init();
  assert.equal((await status(agent)).candidates[0].candidateId, 'doc1-video-1');
  agent.dispose();
  agent.init();
  assert.equal((await status(agent)).candidates[0].candidateId, 'doc2-video-1');
  agent.dispose();
});

test('players appear once their probe succeeds, and failures are reported', async () => {
  const { agent, created, sent } = setup('<video></video><iframe src="https://x.obrut.show/e/1"></iframe>', { autoReady: false });
  agent.init();
  const before = await status(agent);
  assert.deepEqual(before.candidates, [], 'pending probes do not block or appear');
  created[1].rejectProbe(new Error('no answer'));
  await until(() => sent.some((message) => message.kind === 'playerAdapterStatus'), 'failure not reported');
  const failed = await status(agent);
  assert.match(failed.unsupportedReason ?? '', /does not expose/);
  assert.ok(sent.some((message) => message.kind === 'playerAdapterStatus'));
  created[0].resolveProbe();
  await tick(30);
  const ready = await status(agent);
  assert.equal(ready.candidates.length, 1);
  assert.equal(ready.unsupportedReason, undefined, 'a usable player hides the failure');
  agent.dispose();
});

test('only DOM changes involving media trigger a rescan', async () => {
  const { agent, document, sent } = setup('<div id="feed"></div>');
  agent.init();
  await tick(30);
  sent.length = 0;
  document.getElementById('feed')!.append(document.createElement('p'));
  await tick(30);
  assert.equal(sent.length, 0);
  document.getElementById('feed')!.append(document.createElement('video'));
  await until(() => sent.length >= 1, 'media change not reported');
  assert.ok(sent.every((message) => message.kind === 'frameVideoCandidatesChanged'));
  agent.dispose();
});

test('removed players are disposed and deactivated', async () => {
  const { agent, document, created } = setup('<video></video>');
  agent.init();
  const [candidate] = (await status(agent)).candidates;
  agent.handleMessage({ kind: 'activateVideoCandidate', candidateId: candidate.candidateId });
  document.querySelector('video')!.remove();
  assert.deepEqual((await status(agent)).candidates, []);
  assert.equal(created[0].disposed, true);
  agent.dispose();
});

test('the active player forwards events and heartbeats for the host only', async () => {
  const { agent, sent, created } = setup('<video></video>');
  agent.init();
  const [candidate] = (await status(agent)).candidates;
  agent.handleMessage({ kind: 'activateVideoCandidate', candidateId: candidate.candidateId });
  created[0].emit('pause');
  assert.equal(sent.at(-1)?.kind, 'localPlayerEvent');
  agent.handleMessage({ kind: 'sessionInfo', payload: { connectionId: 'c', isHost: false, controlMode: 'open' } });
  sent.length = 0;
  await tick(50);
  assert.equal(sent.filter((message) => message.kind === 'playerHeartbeat').length, 0);
  agent.handleMessage({ kind: 'sessionInfo', payload: { connectionId: 'c', isHost: true, controlMode: 'open' } });
  await until(() => sent.filter((message) => message.kind === 'playerHeartbeat').length >= 2, 'no heartbeats');
  agent.handleMessage({ kind: 'deactivateVideoCandidate' });
  sent.length = 0;
  created[0].emit('play');
  await tick(50);
  assert.deepEqual(sent.filter((message) => message.kind !== 'frameVideoCandidatesChanged'), []);
  agent.dispose();
});

test('a hung player keeps its last state instead of hiding the frame', async () => {
  const { agent, created } = setup('<video></video><video></video>');
  agent.init();
  await status(agent);
  created[1].hangState = true;
  created[1].state = { ...created[1].state, position: 99 };
  const result = await status(agent);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.some((candidate) => candidate.currentTime === 7));
  agent.dispose();
});

test('room states are applied in order, only the newest waiting one', async () => {
  const { agent, sent, created } = setup('<video></video>');
  agent.init();
  const [candidate] = (await status(agent)).candidates;
  agent.handleMessage({ kind: 'applyPlayerState', state: { ...created[0].state, revision: 0, status: 'playing', timestamp: 0 } });
  agent.handleMessage({ kind: 'activateVideoCandidate', candidateId: candidate.candidateId });
  created[0].applyDelay = 10;
  const state = (revision: number, position = 1): AuthoritativePlayerState => ({
    revision,
    source: created[0].state.source,
    position,
    status: 'playing',
    timestamp: 0,
  });
  agent.handleMessage({ kind: 'applyPlayerState', state: state(1) });
  agent.handleMessage({ kind: 'applyPlayerState', state: state(2) });
  agent.handleMessage({ kind: 'applyPlayerState', state: state(3) });
  await until(() => created[0].applied.length >= 2, 'states not applied');
  assert.deepEqual(created[0].applied.map((item) => item.revision), [1, 3]);
  agent.handleMessage({ kind: 'applyPlayerState', state: state(4, -1) });
  await until(() => sent.some((message) => message.kind === 'playbackApplyFailed'), 'failure not reported');
  agent.dispose();
});

test('an iframe navigated by the page becomes a new player, unless the adapter did it', async () => {
  const { agent, document, created } = setup('<iframe src="https://x.obrut.show/e/1"></iframe>');
  agent.init();
  const first = (await status(agent)).candidates[0].candidateId;
  const iframe = document.querySelector('iframe')!;
  created[0].expected = 'https://x.obrut.show/e/2';
  iframe.src = 'https://x.obrut.show/e/2';
  await tick(30);
  assert.equal((await status(agent)).candidates[0].candidateId, first);
  iframe.src = 'https://x.obrut.show/e/3';
  await tick(30);
  const second = (await status(agent)).candidates[0].candidateId;
  assert.notEqual(second, first);
  assert.equal(created[0].disposed, true);
  agent.dispose();
});

test('inside an obrut frame the raw video is not offered twice', async () => {
  const { agent } = setup('<video></video>', { url: 'https://cdn.obrut.show/embed' });
  agent.init();
  assert.deepEqual((await status(agent)).candidates, []);
  agent.dispose();
});

test('child frames report their frame id and visibility', async () => {
  const { agent, document } = setup('<iframe></iframe><iframe></iframe>');
  const second = document.querySelectorAll('iframe')[1];
  (second.contentWindow as unknown as { blocked: boolean }).blocked = true;
  agent.init();
  const result = await status(agent);
  assert.deepEqual(result.childFrames.map((child) => child.frameId), [42]);
  assert.equal(agent.handleMessage({ kind: 'resynced' }), undefined);
  agent.dispose();
  agent.dispose();
});
