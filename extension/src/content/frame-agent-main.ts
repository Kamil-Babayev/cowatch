// Bootstrap for the per-frame agent: the only part that touches the real
// `browser` global. All behavior lives in frame-agent.ts.
import { FrameAgent } from './frame-agent.ts';
import type { ToContentMessage } from '../shared/runtime-messages.ts';
import { debugLog } from '../shared/config.ts';

debugLog('frame agent loaded', { pageUrl: location.href, topFrame: window === window.top });

const agent = new FrameAgent(window, {
  sendMessage: (message) => browser.runtime.sendMessage(message),
  getFrameId: (target) => browser.runtime.getFrameId(target),
});
agent.init();

browser.runtime.onMessage.addListener((message: unknown) => agent.handleMessage(message as ToContentMessage));

// Pages restored from the back/forward cache never re-run content scripts.
window.addEventListener('pagehide', () => agent.dispose());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) agent.init();
});
