import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  VideoCoordinator,
  type FrameDetails,
  type FrameTabsAPI,
  type WebNavigationAPI,
} from './video-coordinator.ts';
import type { FrameVideoStatus } from '../shared/video-frames.ts';

function candidate(candidateId: string, visibleArea: number, width = 800, height = 450) {
  return {
    candidateId,
    width,
    height,
    visibleArea,
    currentTime: 12,
    isPlaying: true,
  };
}

function setup(
  frames: FrameDetails[],
  statuses: Record<number, FrameVideoStatus>,
) {
  const sent: Array<{ tabId: number; frameId?: number; message: unknown }> = [];
  const tabs: FrameTabsAPI = {
    async sendMessage(tabId, message, options) {
      sent.push({ tabId, frameId: options?.frameId, message });
      if (message.kind === 'frameVideoStatusRequest') {
        const status = statuses[options?.frameId ?? 0];
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
  return { coordinator: new VideoCoordinator(tabs, navigation), sent };
}

test('selects a visible video inside a child frame', async () => {
  const { coordinator, sent } = setup(
    [
      { frameId: 0, parentFrameId: -1 },
      { frameId: 2, parentFrameId: 0, documentId: 'child-doc' },
    ],
    {
      0: {
        candidates: [],
        childFrames: [{ frameId: 2, visibleArea: 780 * 468 }],
      },
      2: {
        candidates: [candidate('player', 780 * 468, 780, 468)],
        childFrames: [],
      },
    },
  );

  const result = await coordinator.discover(7);

  assert.equal(result.status.hasVideo, true);
  assert.deepEqual(result.status.selected, {
    frameId: 2,
    candidateId: 'player',
    documentId: 'child-doc',
  });
  assert.deepEqual(sent.at(-1), {
    tabId: 7,
    frameId: 2,
    message: { kind: 'activateVideoCandidate', candidateId: 'player' },
  });
});

test('ignores a large video hosted by an off-screen iframe', async () => {
  const { coordinator } = setup(
    [
      { frameId: 0, parentFrameId: -1 },
      { frameId: 4, parentFrameId: 0 },
    ],
    {
      0: {
        candidates: [candidate('page-video', 120_000, 600, 200)],
        childFrames: [{ frameId: 4, visibleArea: 0 }],
      },
      4: {
        candidates: [candidate('hidden-player', 500_000, 1000, 500)],
        childFrames: [],
      },
    },
  );

  const result = await coordinator.discover(9);

  assert.equal(result.status.selected?.frameId, 0);
  assert.equal(result.status.selected?.candidateId, 'page-video');
  assert.equal(
    result.status.candidates.find((item) => item.frameId === 4)?.effectiveVisibleArea,
    0,
  );
});

test('manual selection survives later automatic discovery', async () => {
  const statuses: Record<number, FrameVideoStatus> = {
    0: {
      candidates: [
        candidate('large', 500_000),
        candidate('small', 100_000, 400, 250),
      ],
      childFrames: [],
    },
  };
  const { coordinator } = setup([{ frameId: 0, parentFrameId: -1 }], statuses);
  await coordinator.discover(3);
  await coordinator.select(3, { frameId: 0, candidateId: 'small' });

  statuses[0].candidates[0].visibleArea = 700_000;
  const result = await coordinator.discover(3);

  assert.equal(result.status.selected?.candidateId, 'small');
  assert.equal(result.selectionChanged, false);
});

test('routes playback only to the selected frame', async () => {
  const { coordinator, sent } = setup(
    [{ frameId: 5, parentFrameId: 0 }],
    {
      5: {
        candidates: [candidate('movie', 300_000)],
        childFrames: [],
      },
    },
  );
  // The missing parent makes this candidate non-visible, but it remains
  // the only playable candidate and is still selected as the fallback.
  await coordinator.discover(11);
  await coordinator.sendToSelected(11, {
    kind: 'remotePlaybackEvent',
    event: { type: 'play', currentTime: 20, isPlaying: true },
  });

  assert.deepEqual(sent.at(-1), {
    tabId: 11,
    frameId: 5,
    message: {
      kind: 'remotePlaybackEvent',
      event: { type: 'play', currentTime: 20, isPlaying: true },
    },
  });
  assert.equal(coordinator.isSelected(11, 5), true);
  assert.equal(coordinator.isSelected(11, 0), false);
});

test('replaces a selection when its document changes', async () => {
  const frames = [{ frameId: 2, parentFrameId: -1, documentId: 'old-doc' }];
  const { coordinator } = setup(
    frames,
    { 2: { candidates: [candidate('video-1', 200_000)], childFrames: [] } },
  );
  await coordinator.discover(15);
  frames[0].documentId = 'new-doc';

  const result = await coordinator.discover(15);

  assert.equal(result.selectionChanged, true);
  assert.equal(result.status.selected?.documentId, 'new-doc');
});
