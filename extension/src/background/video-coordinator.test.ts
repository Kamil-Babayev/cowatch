import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VideoCoordinator,
  type FrameDetails,
  type FrameTabsAPI,
  type VideoCoordinatorOptions,
  type WebNavigationAPI,
} from './video-coordinator.ts';
import type { FrameVideoStatus, VideoSelection } from '../shared/video-frames.ts';

function candidate(candidateId: string, visibleArea: number, width = 800, height = 450) {
  return { candidateId, width, height, visibleArea, currentTime: 12, isPlaying: true };
}

function setup(
  frames: FrameDetails[],
  statuses: Record<number, FrameVideoStatus>,
  options: VideoCoordinatorOptions = {},
) {
  const sent: Array<{ tabId: number; frameId?: number; message: { kind: string } }> = [];
  const unreachable = new Set<number>();
  let statusRequests = 0;
  const tabs: FrameTabsAPI = {
    async sendMessage(tabId, message, opts) {
      const frameId = opts?.frameId ?? 0;
      sent.push({ tabId, frameId, message });
      if (unreachable.has(frameId)) throw new Error('no receiver');
      if (message.kind === 'frameVideoStatusRequest') {
        statusRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        const status = statuses[frameId];
        if (!status) throw new Error('restricted frame');
        return status;
      }
      return undefined;
    },
  };
  const navigation: WebNavigationAPI = {
    async getAllFrames() {
      return frames;
    },
  };
  const coordinator = new VideoCoordinator(tabs, navigation, options);
  const changes: Array<VideoSelection | null> = [];
  coordinator.onSelectionChanged((_tabId, selection) => changes.push(selection));
  return { coordinator, sent, changes, unreachable, statusRequests: () => statusRequests };
}

test('selects a visible video inside a child frame', async () => {
  const { coordinator, sent, changes } = setup(
    [{ frameId: 0, parentFrameId: -1 }, { frameId: 2, parentFrameId: 0 }],
    {
      0: { candidates: [], childFrames: [{ frameId: 2, visibleArea: 780 * 468 }] },
      2: { candidates: [candidate('player', 780 * 468, 780, 468)], childFrames: [] },
    },
  );
  const result = await coordinator.discover(7);
  assert.equal(result.status.hasVideo, true);
  assert.equal(result.selectionChanged, true);
  assert.deepEqual(result.status.selected, { frameId: 2, candidateId: 'player' });
  assert.deepEqual(sent.at(-1), {
    tabId: 7,
    frameId: 2,
    message: { kind: 'activateVideoCandidate', candidateId: 'player' },
  });
  assert.deepEqual(changes, [{ frameId: 2, candidateId: 'player' }]);
});

test('ignores a large video hosted by an off-screen iframe', async () => {
  const { coordinator } = setup(
    [{ frameId: 0, parentFrameId: -1 }, { frameId: 4, parentFrameId: 0 }],
    {
      0: { candidates: [candidate('page-video', 120_000, 600, 200)], childFrames: [{ frameId: 4, visibleArea: 0 }] },
      4: { candidates: [candidate('hidden-player', 500_000, 1000, 500)], childFrames: [] },
    },
  );
  const result = await coordinator.discover(9);
  assert.equal(result.status.selected?.candidateId, 'page-video');
  assert.equal(result.status.candidates.find((item) => item.frameId === 4)?.effectiveVisibleArea, 0);
});

test('keeps the selected video when it scrolls out of view next to a smaller one', async () => {
  const statuses: Record<number, FrameVideoStatus> = {
    0: { candidates: [candidate('main', 360_000, 800, 450), candidate('preview', 0, 320, 180)], childFrames: [] },
  };
  const { coordinator, changes } = setup([{ frameId: 0, parentFrameId: -1 }], statuses, { switchDelayMs: 5 });
  await coordinator.discover(3);
  statuses[0].candidates = [candidate('main', 0, 800, 450), candidate('preview', 57_600, 320, 180)];
  const result = await coordinator.discover(3);
  assert.equal(result.status.selected?.candidateId, 'main');
  assert.equal(result.selectionChanged, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(changes.map((item) => item?.candidateId), ['main']);
});

test('a clearly bigger video takes over only after staying bigger', async () => {
  let now = 1000;
  const statuses: Record<number, FrameVideoStatus> = {
    0: { candidates: [candidate('small', 50_000, 320, 180)], childFrames: [] },
  };
  const { coordinator } = setup([{ frameId: 0, parentFrameId: -1 }], statuses, {
    now: () => now,
    switchDelayMs: 60_000, // the follow-up timer never fires during this test
  });
  await coordinator.discover(4);
  statuses[0].candidates.push(candidate('big', 360_000, 800, 450));
  assert.equal((await coordinator.discover(4)).status.selected?.candidateId, 'small');
  now += 30_000;
  assert.equal((await coordinator.discover(4)).status.selected?.candidateId, 'small');
  now += 30_000;
  const result = await coordinator.discover(4);
  assert.equal(result.status.selected?.candidateId, 'big');
  assert.equal(result.selectionChanged, true);
  coordinator.clear(4);
});

test('a challenger that shrinks back is forgotten', async () => {
  let now = 0;
  const statuses: Record<number, FrameVideoStatus> = {
    0: { candidates: [candidate('small', 50_000, 320, 180), candidate('big', 360_000, 800, 450)], childFrames: [] },
  };
  const { coordinator } = setup([{ frameId: 0, parentFrameId: -1 }], statuses, { now: () => now, switchDelayMs: 60_000 });
  await coordinator.select(5, { frameId: 0, candidateId: 'small' });
  await coordinator.clearManualSelection(5); // challenger 'big' starts at t=0
  statuses[0].candidates[1] = candidate('big', 0, 0, 0);
  now = 30_000;
  await coordinator.discover(5); // big vanished from view: challenge reset
  statuses[0].candidates[1] = candidate('big', 360_000, 800, 450);
  now = 61_000;
  assert.equal((await coordinator.discover(5)).status.selected?.candidateId, 'small');
  coordinator.clear(5);
});

test('manual selection survives later discovery until cleared', async () => {
  const statuses: Record<number, FrameVideoStatus> = {
    0: { candidates: [candidate('large', 500_000), candidate('small', 100_000, 400, 250)], childFrames: [] },
  };
  const { coordinator } = setup([{ frameId: 0, parentFrameId: -1 }], statuses);
  await coordinator.discover(3);
  const selected = await coordinator.select(3, { frameId: 0, candidateId: 'small' });
  assert.equal(selected.manual, true);
  const result = await coordinator.discover(3);
  assert.equal(result.status.selected?.candidateId, 'small');
  assert.equal(result.status.manual, true);
  await assert.rejects(coordinator.select(3, { frameId: 0, candidateId: 'gone' }), /no longer available/);
});

test('a removed manual selection falls back to automatic selection', async () => {
  const statuses: Record<number, FrameVideoStatus> = {
    0: { candidates: [candidate('a', 500_000), candidate('b', 100_000)], childFrames: [] },
  };
  const { coordinator } = setup([{ frameId: 0, parentFrameId: -1 }], statuses);
  await coordinator.select(6, { frameId: 0, candidateId: 'b' });
  statuses[0].candidates = [candidate('a', 500_000)];
  const result = await coordinator.discover(6);
  assert.equal(result.status.selected?.candidateId, 'a');
  assert.equal(result.status.manual, false);
});

test('concurrent discoveries are coalesced', async () => {
  const { coordinator, statusRequests } = setup(
    [{ frameId: 0, parentFrameId: -1 }],
    { 0: { candidates: [candidate('v', 1000)], childFrames: [] } },
  );
  const first = coordinator.discover(8);
  assert.equal(coordinator.discover(8), first, 'requests before the run starts share it');
  while (statusRequests() === 0) await new Promise((resolve) => setImmediate(resolve));
  // Requested while the first run is in flight: one follow-up run for all.
  const followUps = [coordinator.discover(8), coordinator.discover(8), coordinator.discover(8)];
  const results = await Promise.all([first, ...followUps]);
  assert.equal(statusRequests(), 2);
  assert.equal(results.filter((result) => result.selectionChanged).length, 1);
});

test('a failed activation records no selection', async () => {
  const { coordinator, unreachable, changes } = setup(
    [{ frameId: 0, parentFrameId: -1 }, { frameId: 3, parentFrameId: 0 }],
    {
      0: { candidates: [], childFrames: [{ frameId: 3, visibleArea: 1000 }] },
      3: { candidates: [candidate('v', 1000)], childFrames: [] },
    },
  );
  const tabs = coordinator as unknown as { tabs: FrameTabsAPI };
  const original = tabs.tabs.sendMessage.bind(tabs.tabs);
  tabs.tabs.sendMessage = async (tabId, message, options) => {
    if (message.kind === 'activateVideoCandidate') unreachable.add(3);
    return original(tabId, message, options);
  };
  const result = await coordinator.discover(10);
  assert.equal(result.status.selected, null);
  assert.equal(result.selectionChanged, false);
  assert.deepEqual(changes, [null]);
});

test('routes messages only to the selected frame and re-discovers when it is gone', async () => {
  const { coordinator, sent, unreachable, changes } = setup(
    [{ frameId: 5, parentFrameId: -1 }],
    { 5: { candidates: [candidate('movie', 300_000)], childFrames: [] } },
  );
  await coordinator.discover(11);
  assert.equal(await coordinator.sendToSelected(11, { kind: 'deactivateVideoCandidate' }), true);
  assert.equal(sent.at(-1)?.frameId, 5);
  assert.equal(coordinator.isSelected(11, 5), true);
  assert.equal(coordinator.isSelected(11, 0), false);

  unreachable.add(5);
  assert.equal(await coordinator.sendToSelected(11, { kind: 'deactivateVideoCandidate' }), false);
  assert.equal(coordinator.getSelection(11), null);
  await coordinator.discover(11);
  assert.deepEqual(changes.map((item) => item?.candidateId ?? null), ['movie', null]);
  assert.equal(await coordinator.sendToSelected(11, { kind: 'deactivateVideoCandidate' }), false);
});

test('navigation of the page or the selected frame clears the selection', async () => {
  const { coordinator, changes } = setup(
    [{ frameId: 0, parentFrameId: -1 }, { frameId: 2, parentFrameId: 0 }],
    {
      0: { candidates: [], childFrames: [{ frameId: 2, visibleArea: 1000 }] },
      2: { candidates: [candidate('v', 1000)], childFrames: [] },
    },
  );
  await coordinator.discover(12);
  coordinator.handleNavigation(12, 7); // unrelated subframe
  assert.notEqual(coordinator.getSelection(12), null);
  coordinator.handleNavigation(12, 2);
  assert.equal(coordinator.getSelection(12), null);
  await coordinator.discover(12);
  coordinator.handleNavigation(12, 0);
  assert.equal(coordinator.getSelection(12), null);
  coordinator.handleNavigation(12, 0); // nothing selected: no extra notification
  assert.deepEqual(changes.map((item) => item?.candidateId ?? null), ['v', null, 'v', null]);
});
