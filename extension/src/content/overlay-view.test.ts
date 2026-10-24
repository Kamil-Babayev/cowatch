import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createOverlayView, type LayoutStore, type OverlayLayout } from './overlay-view.ts';
import type { OverlayActions } from './overlay-controller.ts';
import type { VideoTabStatus } from '../shared/video-frames.ts';

const STYLES = '.hud { color: red; }';
let dom: JSDOM;
let root: ShadowRoot;
let calls: string[];
let saved: OverlayLayout[];

function actions(): OverlayActions {
  const record = (name: string) => () => calls.push(name);
  return {
    toggleMic: record('mic'),
    toggleCamera: record('camera'),
    copyLink: record('copy'),
    leave: record('leave'),
    openPicker: record('picker'),
    selectVideo: (selection) => calls.push(`select:${selection.candidateId}`),
    autoSelectVideo: record('auto'),
    retryCall: record('retry'),
    openCallWindow: record('window'),
  };
}

function store(initial: OverlayLayout | null = null): LayoutStore {
  return {
    load: async () => initial,
    save: (layout) => saved.push(structuredClone(layout)),
  };
}

beforeEach(() => {
  dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
  calls = [];
  saved = [];
  const original = dom.window.Element.prototype.attachShadow;
  dom.window.Element.prototype.attachShadow = function (init: ShadowRootInit) {
    root = original.call(this, init);
    return root;
  };
});

afterEach(() => dom.window.close());

function $(selector: string): HTMLElement {
  const found = root.querySelector(selector);
  assert.ok(found, `missing ${selector}`);
  return found as HTMLElement;
}

function click(selector: string): void {
  $(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

test('builds a click-through host with the HUD, call card and styles', () => {
  const view = createOverlayView(dom.window.document, actions(), store(), STYLES);
  const host = dom.window.document.getElementById('cowatch-overlay-host')!;
  assert.equal(host.getAttribute('popover'), 'manual');
  assert.match(host.getAttribute('style') ?? '', /pointer-events:none/);
  assert.ok(root.querySelector('style') || root.adoptedStyleSheets.length > 0, 'styles applied');
  assert.equal(view.callSlot.className, 'call-slot');
  view.destroy();
  view.destroy();
  assert.equal(dom.window.document.getElementById('cowatch-overlay-host'), null);
});

test('status, host-only link and toolbar actions', () => {
  const view = createOverlayView(dom.window.document, actions(), store(), STYLES);
  view.setParticipants('2 people');
  view.setControl('Host controls playback', false);
  assert.equal($('.participants').textContent, '2 people');
  assert.equal($('.control').textContent, 'Host controls playback');
  assert.equal($('[aria-label="Copy invite link"]').hidden, true);
  view.setControl('You control playback', true);
  assert.equal($('[aria-label="Copy invite link"]').hidden, false);
  click('[aria-label="Copy invite link"]');
  click('[aria-label="Leave room"]');
  click('[aria-label="Choose video"]');
  assert.deepEqual(calls, ['copy', 'leave', 'picker']);
  view.destroy();
});

test('mic and camera unlock only once the call joined, and show mute state', () => {
  const view = createOverlayView(dom.window.document, actions(), store(), STYLES);
  const mic = $('[aria-label="Microphone"]') as HTMLButtonElement;
  view.setCall('connecting');
  assert.equal(mic.disabled, true);
  assert.match($('.call-message').textContent ?? '', /Connecting/);
  view.setCall('joined');
  assert.equal(mic.disabled, false);
  assert.equal($('.call-message').hidden, true);
  assert.equal($('.call-state').textContent, 'Live');
  view.setMuted('audio', false);
  assert.equal(mic.getAttribute('aria-pressed'), 'true');
  assert.equal(mic.title, 'Turn microphone off');
  view.setMuted('video', true);
  assert.equal($('[aria-label="Camera"]').getAttribute('aria-pressed'), 'false');
  click('[aria-label="Microphone"]');
  click('[aria-label="Camera"]');
  assert.deepEqual(calls, ['mic', 'camera']);
  view.destroy();
});

test('a failed call offers retry and a separate window', () => {
  const view = createOverlayView(dom.window.document, actions(), store(), STYLES);
  view.setCall('failed', 'Video chat did not connect');
  assert.match($('.call-message').textContent ?? '', /did not connect/);
  assert.equal($('.live-dot').classList.contains('offline'), true);
  const [retry, open] = [...root.querySelectorAll('.call-actions button')] as HTMLElement[];
  retry.click();
  open.click();
  assert.deepEqual(calls, ['retry', 'window']);
  view.setCall('failed');
  assert.match($('.call-message').textContent ?? '', /unavailable/);
  view.destroy();
});

test('the call card collapses without removing the call', () => {
  const view = createOverlayView(dom.window.document, actions(), store(), STYLES);
  click('[aria-label="Show video chat"]');
  assert.equal($('.call-card').classList.contains('collapsed'), true);
  assert.ok(root.contains(view.callSlot), 'the call iframe stays in the DOM');
  assert.equal(saved.at(-1)?.cardCollapsed, true);
  click('[aria-label="Show video chat"]');
  assert.equal($('.call-card').classList.contains('collapsed'), false);
  click('[aria-label="Hide video chat"]');
  assert.equal($('.call-card').classList.contains('collapsed'), true);
  click('[aria-label="Minimize"]');
  assert.equal($('.hud').classList.contains('collapsed'), true);
  click('[aria-label="Expand"]');
  assert.equal($('.hud').classList.contains('collapsed'), false);
  view.destroy();
});

test('a saved layout is restored', async () => {
  const view = createOverlayView(dom.window.document, actions(), store({
    hud: { x: 40, y: 50 },
    card: { x: 60, y: 70, width: 400, height: 260 },
    cardCollapsed: true,
  }), STYLES);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal($('.hud-wrap').classList.contains('placed'), true);
  assert.equal($('.hud-wrap').style.left, '40px');
  assert.equal($('.call-card').style.width, '400px');
  assert.equal($('.call-card').classList.contains('collapsed'), true);
  view.destroy();
});

test('toasts appear and clear themselves', async () => {
  const view = createOverlayView(dom.window.document, actions(), store(), STYLES);
  view.showToast('Invite link copied', 10);
  assert.equal($('.toast').textContent, 'Invite link copied');
  assert.equal($('.toast').classList.contains('visible'), true);
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal($('.toast').textContent, '');
  view.destroy();
});

test('the picker lists videos as radios and reports the choice', () => {
  const view = createOverlayView(dom.window.document, actions(), store(), STYLES);
  const status: VideoTabStatus = {
    hasVideo: true,
    manual: true,
    selected: { frameId: 2, candidateId: 'b' },
    candidates: [
      { candidateId: 'a', frameId: 0, parentFrameId: -1, width: 640, height: 360, visibleArea: 1, effectiveVisibleArea: 1, currentTime: 0, isPlaying: true },
      { candidateId: 'b', frameId: 2, parentFrameId: 0, width: 320, height: 180, visibleArea: 0, effectiveVisibleArea: 0, currentTime: 0, isPlaying: false },
    ],
  };
  view.showPicker(status);
  const items = [...root.querySelectorAll('.picker-item')] as HTMLElement[];
  assert.deepEqual(items.map((item) => item.getAttribute('aria-checked')), ['false', 'false', 'true']);
  assert.match(items[1].textContent ?? '', /On this page640 × 360, playing/);
  assert.match(items[2].textContent ?? '', /Embedded player320 × 180, scrolled out of view/);
  items[2].click();
  items[0].click();
  assert.deepEqual(calls, ['select:b', 'auto']);
  click('[aria-label="Choose video"]');
  assert.equal($('.picker').hidden, true, 'the toolbar button closes an open picker');
  view.showPicker({ hasVideo: false, candidates: [], selected: null });
  assert.match($('.picker-empty').textContent ?? '', /No videos/);
  dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal($('.picker').hidden, true);
  view.showPicker({ hasVideo: false, candidates: [], selected: null });
  click('[aria-label="Close"]');
  assert.equal($('.picker').hidden, true);
  view.destroy();
});

test('the ended notice replaces the HUD and removes itself', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const view = createOverlayView(dom.window.document, actions(), store(), STYLES);
  view.showEnded('The host ended this room');
  assert.equal($('.ended').textContent, 'The host ended this room');
  assert.equal(root.querySelector('.call-card'), null);
  t.mock.timers.tick(5000);
  assert.equal(dom.window.document.getElementById('cowatch-overlay-host'), null);
});
