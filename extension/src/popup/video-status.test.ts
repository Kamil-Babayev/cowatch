import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPopupVideoStatus } from './video-status.ts';

test('detectPopupVideoStatus distinguishes all outcomes', async () => {
  const send = async () => ({ hasVideo: true });
  assert.equal(
    await detectPopupVideoStatus({ id: 1, url: 'https://video.example' }, send),
    'available',
  );
  assert.equal(
    await detectPopupVideoStatus(
      { id: 1, url: 'https://video.example' },
      async () => ({ hasVideo: false }),
    ),
    'no-video',
  );
  assert.equal(
    await detectPopupVideoStatus({ id: 1, url: 'about:config' }, send),
    'restricted',
  );
  assert.equal(
    await detectPopupVideoStatus(
      { id: 1, url: 'https://video.example' },
      async () => {
        throw new Error('content script unavailable');
      },
    ),
    'unreachable',
  );
});
