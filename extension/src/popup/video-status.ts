export type PopupVideoStatus =
  | 'available'
  | 'no-video'
  | 'restricted'
  | 'unreachable';

interface TabSummary {
  id?: number;
  url?: string;
}

/** Queries the content script instead of guessing video presence from a URL. */
export async function detectPopupVideoStatus(
  tab: TabSummary,
  sendMessage: (
    tabId: number,
    message: { kind: 'videoStatusRequest' },
  ) => Promise<unknown>,
): Promise<PopupVideoStatus> {
  if (tab.id == null) return 'restricted';
  const tabId = tab.id;
  const restricted =
    !tab.url
    || tab.url.startsWith('about:')
    || tab.url.startsWith('moz-extension:')
    || tab.url.startsWith('https://addons.mozilla.org/');
  if (restricted) return 'restricted';

  try {
    const result = (await sendMessage(tabId, {
      kind: 'videoStatusRequest',
    })) as { hasVideo?: boolean };
    return result.hasVideo ? 'available' : 'no-video';
  } catch {
    return 'unreachable';
  }
}
