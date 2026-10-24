import type { CallState, OverlayActions, OverlayView } from './overlay-controller.ts';
import type { VideoCandidate, VideoTabStatus } from '../shared/video-frames.ts';

export interface PanelPosition {
  x: number;
  y: number;
}

export interface OverlayLayout {
  hud?: PanelPosition;
  card?: PanelPosition & { width?: number; height?: number };
  cardCollapsed?: boolean;
}

/** Remembers where the user put the panels, per site. */
export interface LayoutStore {
  load(): Promise<OverlayLayout | null>;
  save(layout: OverlayLayout): void;
}

type Shape = [tag: 'path' | 'rect', attributes: Record<string, string>];

const slash: Shape = ['path', { class: 'slash', d: 'M2.75 2.75l10.5 10.5' }];
const ICONS: Record<string, Shape[]> = {
  mic: [
    ['path', { d: 'M8 1.75a2 2 0 0 1 2 2v3.5a2 2 0 0 1-4 0v-3.5a2 2 0 0 1 2-2z' }],
    ['path', { d: 'M4.25 7.25a3.75 3.75 0 0 0 7.5 0M8 11v3M5.75 14h4.5' }],
    slash,
  ],
  camera: [
    ['rect', { x: '1.5', y: '4.25', width: '9', height: '7.5', rx: '2' }],
    ['path', { d: 'M10.5 7.25l4-2.25v6l-4-2.25' }],
    slash,
  ],
  call: [['path', { d: 'M2.25 3.5h11.5v7.25H6.5l-3 2.5v-2.5H2.25z' }]],
  picker: [
    ['rect', { x: '1.5', y: '3', width: '13', height: '10', rx: '2' }],
    ['path', { d: 'M6.5 6v4l3.5-2z' }],
  ],
  link: [['path', { d: 'M6.75 9.25l2.5-2.5M7.25 4.75l.9-.9a2.47 2.47 0 0 1 3.5 3.5l-.9.9M8.75 11.25l-.9.9a2.47 2.47 0 0 1-3.5-3.5l.9-.9' }]],
  leave: [['path', { d: 'M6.25 2.5h-2.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h2.5M10 5l3 3-3 3M13 8H6' }]],
  collapse: [['path', { d: 'M4 6.25l4 4 4-4' }]],
  expand: [['path', { d: 'M4 9.75l4-4 4 4' }]],
  close: [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }]],
  check: [['path', { d: 'M3.25 8.5l3 3 6.5-7' }]],
};

const CALL_STATE_LABELS: Record<CallState, string> = {
  connecting: 'Connecting…',
  waiting: 'Waiting',
  joined: 'Live',
  failed: 'Unavailable',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(doc: Document, shapes: Shape[]): SVGSVGElement {
  const root = doc.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', '0 0 16 16');
  root.setAttribute('aria-hidden', 'true');
  for (const [tag, attributes] of shapes) {
    const shape = doc.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    root.append(shape);
  }
  return root;
}

function iconButton(doc: Document, icon: Shape[], label: string, className = ''): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `icon-btn ${className}`.trim();
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(svg(doc, icon));
  return button;
}

function pushButton(doc: Document, text: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = primary ? 'push-btn primary' : 'push-btn';
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

/** Names a video by where it is, with its size and state as the detail. */
function describe(candidate: VideoCandidate): { name: string; detail: string } {
  const name = candidate.frameId === 0 ? 'On this page' : 'Embedded player';
  const size = `${Math.round(candidate.width)} × ${Math.round(candidate.height)}`;
  const state = candidate.isPlaying ? 'playing' : candidate.effectiveVisibleArea > 0 ? 'paused' : 'scrolled out of view';
  return { name, detail: `${size}, ${state}` };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Moves `target` (absolutely positioned) when `handle` is dragged, keeping
 * it on screen. Clicks on buttons inside the handle still work.
 */
function makeDraggable(
  handle: HTMLElement,
  target: HTMLElement,
  onPlaced: (position: PanelPosition) => void,
): void {
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    const view = handle.ownerDocument.defaultView!;
    const start = target.getBoundingClientRect();
    const offsetX = event.clientX - start.left;
    const offsetY = event.clientY - start.top;
    let moved = false;
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('dragging');
    const move = (next: PointerEvent) => {
      moved = true;
      target.classList.add('placed');
      target.style.left = `${clamp(next.clientX - offsetX, 8, view.innerWidth - start.width - 8)}px`;
      target.style.top = `${clamp(next.clientY - offsetY, 8, view.innerHeight - start.height - 8)}px`;
    };
    const up = () => {
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      if (moved) onPlaced({ x: parseFloat(target.style.left), y: parseFloat(target.style.top) });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

function place(target: HTMLElement, position: PanelPosition | undefined): void {
  if (!position) return;
  const view = target.ownerDocument.defaultView!;
  target.classList.add('placed');
  target.style.left = `${clamp(position.x, 8, view.innerWidth - 120)}px`;
  target.style.top = `${clamp(position.y, 8, view.innerHeight - 60)}px`;
}

function applyStyles(shadow: ShadowRoot, doc: Document, styles: string): void {
  // A constructed stylesheet is not subject to the page's style-src CSP;
  // fall back to a <style> element where adopting one is not allowed.
  try {
    const Sheet = (doc.defaultView as unknown as { CSSStyleSheet: typeof CSSStyleSheet }).CSSStyleSheet;
    const sheet = new Sheet();
    sheet.replaceSync(styles);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = doc.createElement('style');
    style.textContent = styles;
    shadow.prepend(style);
  }
}

/**
 * Builds the overlay DOM. The host element is a manual popover so it lives
 * in the browser's top layer: re-showing it on fullscreen changes puts it
 * above the fullscreen video without moving it in the DOM — moving it
 * would reload the call's iframe and drop the call.
 */
export function createOverlayView(
  doc: Document,
  actions: OverlayActions,
  layout: LayoutStore,
  styles: string,
): OverlayView {
  const host = doc.createElement('div');
  host.id = 'cowatch-overlay-host';
  host.setAttribute('popover', 'manual');
  host.setAttribute(
    'style',
    'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;'
      + 'border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;display:block;',
  );
  doc.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  applyStyles(shadow, doc, styles);

  const showOnTop = () => {
    const popover = host as HTMLElement & { showPopover?: () => void; hidePopover?: () => void };
    try {
      if (host.matches(':popover-open')) popover.hidePopover?.();
      popover.showPopover?.();
    } catch {
      // No popover support: the fixed-position host still works outside fullscreen.
    }
  };
  showOnTop();
  doc.addEventListener('fullscreenchange', showOnTop);

  const saved: OverlayLayout = {};
  const persist = () => layout.save(saved);

  // ---- HUD ----
  const wrap = doc.createElement('div');
  wrap.className = 'hud-wrap';
  const picker = doc.createElement('div');
  picker.className = 'panel picker';
  picker.hidden = true;
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Choose the video to sync');
  const toast = doc.createElement('div');
  toast.className = 'panel toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  const hud = doc.createElement('div');
  hud.className = 'panel hud';
  hud.setAttribute('role', 'toolbar');
  hud.setAttribute('aria-label', 'CoWatch');

  const dot = doc.createElement('span');
  dot.className = 'live-dot';
  const status = doc.createElement('div');
  status.className = 'hud-status';
  const participants = doc.createElement('span');
  participants.className = 'participants';
  const control = doc.createElement('span');
  control.className = 'control';
  status.append(participants, control);

  const controls = doc.createElement('div');
  controls.className = 'controls';
  const mic = iconButton(doc, ICONS.mic, 'Microphone');
  const camera = iconButton(doc, ICONS.camera, 'Camera');
  const callToggle = iconButton(doc, ICONS.call, 'Show video chat');
  const pickerButton = iconButton(doc, ICONS.picker, 'Choose video');
  const link = iconButton(doc, ICONS.link, 'Copy invite link');
  const leave = iconButton(doc, ICONS.leave, 'Leave room', 'destructive');
  for (const button of [mic, camera]) {
    button.setAttribute('aria-pressed', 'false');
    button.disabled = true;
  }
  callToggle.setAttribute('aria-expanded', 'true');
  pickerButton.setAttribute('aria-haspopup', 'dialog');
  link.hidden = true;
  controls.append(mic, camera, callToggle, pickerButton, link, leave);
  const separator = doc.createElement('span');
  separator.className = 'separator';
  const collapse = iconButton(doc, ICONS.collapse, 'Minimize');
  hud.append(dot, status, separator, controls, collapse);
  wrap.append(picker, toast, hud);

  // ---- Call card ----
  const card = doc.createElement('section');
  card.className = 'panel call-card';
  card.setAttribute('aria-label', 'Video chat');
  const header = doc.createElement('div');
  header.className = 'call-header';
  const title = doc.createElement('span');
  title.className = 'call-title';
  title.textContent = 'Video chat';
  const callState = doc.createElement('span');
  callState.className = 'call-state';
  const hideCard = iconButton(doc, ICONS.collapse, 'Hide video chat');
  header.append(title, callState, hideCard);
  const body = doc.createElement('div');
  body.className = 'call-body';
  const slot = doc.createElement('div');
  slot.className = 'call-slot';
  const message = doc.createElement('div');
  message.className = 'call-message';
  body.append(slot, message);
  card.append(header, body);

  shadow.append(card, wrap);

  // ---- Behaviour ----
  mic.addEventListener('click', actions.toggleMic);
  camera.addEventListener('click', actions.toggleCamera);
  link.addEventListener('click', actions.copyLink);
  leave.addEventListener('click', actions.leave);
  pickerButton.addEventListener('click', () => {
    if (picker.hidden) actions.openPicker();
    else hidePicker();
  });
  const setCardCollapsed = (collapsed: boolean) => {
    card.classList.toggle('collapsed', collapsed);
    callToggle.setAttribute('aria-expanded', String(!collapsed));
    callToggle.title = collapsed ? 'Show video chat' : 'Hide video chat';
    saved.cardCollapsed = collapsed;
  };
  callToggle.addEventListener('click', () => {
    setCardCollapsed(!card.classList.contains('collapsed'));
    persist();
  });
  hideCard.addEventListener('click', () => {
    setCardCollapsed(true);
    persist();
  });
  collapse.addEventListener('click', () => {
    const collapsed = !hud.classList.contains('collapsed');
    hud.classList.toggle('collapsed', collapsed);
    collapse.replaceChildren(svg(doc, collapsed ? ICONS.expand : ICONS.collapse));
    collapse.title = collapsed ? 'Expand' : 'Minimize';
    collapse.setAttribute('aria-label', collapse.title);
    if (collapsed) hidePicker();
  });
  makeDraggable(hud, wrap, (position) => {
    saved.hud = position;
    persist();
  });
  makeDraggable(header, card, (position) => {
    saved.card = { ...saved.card, ...position };
    persist();
  });
  const View = doc.defaultView as unknown as { ResizeObserver?: typeof ResizeObserver };
  const sizes = View.ResizeObserver
    ? new View.ResizeObserver(() => {
        if (!card.style.width && !card.style.height) return;
        const rect = card.getBoundingClientRect();
        saved.card = { x: rect.left, y: rect.top, ...saved.card, width: rect.width, height: rect.height };
        persist();
      })
    : null;
  sizes?.observe(card);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !picker.hidden) hidePicker();
  };
  doc.addEventListener('keydown', onKey, true);

  void layout.load().then((stored) => {
    if (!stored) return;
    Object.assign(saved, stored);
    place(wrap, stored.hud);
    place(card, stored.card);
    if (stored.card?.width) card.style.width = `${stored.card.width}px`;
    if (stored.card?.height) card.style.height = `${stored.card.height}px`;
    if (stored.cardCollapsed) setCardCollapsed(true);
  }).catch(() => undefined);

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function hidePicker(): void {
    picker.hidden = true;
    pickerButton.setAttribute('aria-expanded', 'false');
  }

  // `connecting` covers the call area with a spinner; `failed` covers it
  // with recovery buttons; `waiting` is a bar along the bottom that leaves
  // the Jitsi screen above it usable (e.g. its moderator sign-in).
  function showCallMessage(text: string, state: Exclude<CallState, 'joined'>): void {
    message.replaceChildren();
    message.hidden = false;
    message.classList.toggle('waiting', state === 'waiting');
    if (state === 'connecting') {
      const spinner = doc.createElement('div');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      message.append(spinner);
    }
    const paragraph = doc.createElement('p');
    paragraph.textContent = text;
    message.append(paragraph);
    if (state !== 'connecting') {
      const buttons = doc.createElement('div');
      buttons.className = 'call-actions';
      if (state === 'failed') buttons.append(pushButton(doc, 'Try Again', true, actions.retryCall));
      buttons.append(pushButton(doc, 'Open in Window', false, actions.openCallWindow));
      message.append(buttons);
    }
  }

  let destroyed = false;
  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    if (toastTimer) clearTimeout(toastTimer);
    sizes?.disconnect();
    doc.removeEventListener('fullscreenchange', showOnTop);
    doc.removeEventListener('keydown', onKey, true);
    host.remove();
  }

  return {
    callSlot: slot,
    setParticipants(text) {
      participants.textContent = text;
    },
    setControl(text, isHost) {
      control.textContent = text;
      link.hidden = isHost !== true;
    },
    setCall(state: CallState, text?: string) {
      const joined = state === 'joined';
      mic.disabled = !joined;
      camera.disabled = !joined;
      callState.textContent = CALL_STATE_LABELS[state];
      dot.classList.toggle('offline', state === 'failed' || state === 'waiting');
      if (joined) {
        message.hidden = true;
      } else {
        // Without a call there is nothing to be on; never show a lit button.
        mic.setAttribute('aria-pressed', 'false');
        camera.setAttribute('aria-pressed', 'false');
        showCallMessage(state === 'connecting' ? 'Connecting to video chat…' : text ?? 'Video chat unavailable', state);
      }
    },
    setMuted(kind, muted) {
      const button = kind === 'audio' ? mic : camera;
      button.setAttribute('aria-pressed', String(!muted));
      const name = kind === 'audio' ? 'microphone' : 'camera';
      button.title = muted ? `Turn ${name} on` : `Turn ${name} off`;
    },
    showToast(text, durationMs = 3000) {
      toast.textContent = text;
      toast.classList.add('visible');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('visible');
        toastTimer = setTimeout(() => {
          toast.textContent = '';
        }, 200);
      }, durationMs);
    },
    showPicker(tabStatus: VideoTabStatus) {
      picker.replaceChildren();
      const heading = doc.createElement('div');
      heading.className = 'picker-title';
      const label = doc.createElement('span');
      label.textContent = 'Sync which video?';
      const close = iconButton(doc, ICONS.close, 'Close');
      close.addEventListener('click', hidePicker);
      heading.append(label, close);
      const list = doc.createElement('div');
      list.className = 'picker-list';
      list.setAttribute('role', 'radiogroup');
      const item = (name: string, detail: string, checked: boolean, onPick: () => void) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'picker-item';
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(checked));
        button.append(svg(doc, ICONS.check));
        const text = doc.createElement('span');
        const strong = doc.createElement('span');
        strong.className = 'picker-name';
        strong.textContent = name;
        const small = doc.createElement('span');
        small.className = 'picker-detail';
        small.textContent = detail;
        text.append(strong, small);
        button.append(text);
        button.addEventListener('click', onPick);
        list.append(button);
      };
      item('Automatic', 'The largest visible video', !tabStatus.manual, actions.autoSelectVideo);
      const divider = doc.createElement('div');
      divider.className = 'picker-divider';
      list.append(divider);
      if (tabStatus.candidates.length === 0) {
        const empty = doc.createElement('div');
        empty.className = 'picker-empty';
        empty.textContent = 'No videos found on this page.';
        list.append(empty);
      }
      tabStatus.candidates.forEach((candidate) => {
        const { name, detail } = describe(candidate);
        const selected = Boolean(tabStatus.manual)
          && tabStatus.selected?.frameId === candidate.frameId
          && tabStatus.selected?.candidateId === candidate.candidateId;
        item(name, detail, selected, () => actions.selectVideo({
          frameId: candidate.frameId,
          candidateId: candidate.candidateId,
        }));
      });
      picker.append(heading, list);
      picker.hidden = false;
      pickerButton.setAttribute('aria-expanded', 'true');
      (list.querySelector('[aria-checked="true"]') as HTMLElement | null)?.focus();
    },
    hidePicker,
    showEnded(text) {
      card.remove();
      wrap.replaceChildren();
      const notice = doc.createElement('div');
      notice.className = 'panel ended';
      notice.setAttribute('role', 'status');
      notice.textContent = text;
      wrap.append(notice);
      setTimeout(destroy, 5000);
    },
    destroy,
  };
}
