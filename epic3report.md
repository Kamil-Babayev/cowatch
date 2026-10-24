# Epic 3 completion report

Status: complete for v1; production deployment and AMO submission are
separate.

## US-3.4

- The overlay keeps presence/control state separate from transient notices.
- Open rooms display “Everyone can control.” Host-only rooms distinguish
  “You control playback” from “Host controls playback.”
- Candidate videos can be explicitly selected and returned to automatic
  largest-visible selection. Detection ignores hidden/offscreen videos and
  reacts to DOM, style, viewport, and layout changes.
- A denied joiner action shows a resync notice, requests authoritative state,
  applies seek and play/pause together, and then clears only the notice.
- Connection, autoplay, and room-closure failures are visible.

## US-3.5

- The staged charcoal/amber/monospace landing design was retained.
- Semantic structure, viewport metadata, live/error regions, keyboard focus,
  disabled/busy states, reduced motion, and narrow-screen behavior were added.
- Tokens resolve before extension installation is suggested.
- Extension detection is a bounded request/response `CustomEvent` handshake.
- Expired, unknown, missing-token, extension-missing, and retryable network
  failures are distinct; Continue cannot be submitted twice.

## US-3.6

- Popup loading and error states distinguish missing video, restricted pages,
  server failures, and inactive rooms; video presence comes from the content
  script instead of URL guessing.
- Active host/joiner descriptors are stored in `storage.session` and stale
  records are removed during normal lifecycle cleanup.
- Jitsi failure remains visible in its slot, disables media controls, and
  offers retry. Its API wrapper is local and pinned by checksum.
- The overlay handles fullscreen, focus visibility, narrow screens, and
  reduced-motion preference.

## Verification

- Go HTTP/store/config/ID/WebSocket tests include real `httptest` WebSocket
  sessions and exceed the 80% aggregate statement gate.
- Extension unit/integration tests exceed the 80% aggregate line gate.
- Pull requests run format, vet, build, race, coverage, typecheck, extension
  build, and Firefox manifest validation in independent jobs.
- The two-profile browser checklist is maintained in the root README and must
  be completed before packaging each release.

## Cross-frame detection addendum

- A lightweight video agent now runs in every accessible frame while the
  overlay, pending-join handoff, and Jitsi coordinator remain top-frame-only.
- Script-populated `about:blank` player frames are included so lazy player
  containers are inspected after initialization.
- Background discovery enumerates live frames, accounts for parent iframe
  visibility, preserves manual selection, and targets sync traffic only to
  the selected frame/document.
- Cross-origin embedded players are supported generically; no site-specific
  player rules were added.

## Stabilization addendum (October 2026)

Testing in real Firefox found the call, video detection and sync unreliable.
Root causes and fixes:

- **Sync never started on streaming sites.** `mediaKey` was `currentSrc`, a
  `blob:` URL the server rejected. Native players are now keyed by
  normalized page URL (`shared/page-key.ts`).
- **The protocol fought itself.** Heartbeats bumped the revision, so user
  commands were rejected and reverted. The host also applied its own echoed
  heartbeats, and drift ignored clock skew. Commands are now last-writer-wins,
  heartbeats keep the revision, states carry `originConnectionId`, and
  `ClockOffset` (`shared/clock.ts`) converts server time.
- **Detection lost the video.**
  - Candidate ids repeated across reloads, so a reloaded page was never
    activated.
  - Auto-selection flipped to previews and ads.
  - Shadow-DOM players were invisible.
  - Probes blocked status requests and were never retried.
  - The back/forward cache killed the agent.
  - `frame-agent.ts` is now a tested `FrameAgent` class, and
    `VideoCoordinator` serializes discovery and keeps selections sticky.
- **Idle joiners lost the room** when Firefox unloaded the event page. Added
  keepalives, restoring sessions on startup, a room-gone check
  (`GET /rooms/{id}`) and dead-socket detection through unanswered clock pings.
- **The call silently failed.**
  - No Jitsi events were watched.
  - Fullscreen reparenting reloaded the iframe.
  - A Leave during injection left a stale handle that blocked every later
    overlay.
  - Room closure never tore the call down.
  - `overlay-controller.ts` now owns the lifecycle with generation tokens.
    The overlay is a top-layer popover. The deployment needs self-hosted
    Jitsi (README).
- **Room flow:**
  - Room creation moved to the background (`createRoom`).
  - A new join link replaces the tab's previous room.
  - Reloads re-send session, presence and state.
  - Following the host's page compares normalized URLs, once per source.
  - The rate limiter can trust a reverse proxy (`TRUST_PROXY`).
- **Removed** the legacy `play`/`pause`/`seeked`/`timeSync` relay and the
  unused `VideoDetector`, `playback-events`, `playback-sync` and
  `overlay-fullscreen` modules.
- **Restyled** the popup, the in-page HUD and the landing page in the macOS
  Monterey style, with automatic light/dark.

Still unverified without real Firefox: the top-layer popover over fullscreen
video, Jitsi against a self-hosted server, and event-page keepalive behavior.
