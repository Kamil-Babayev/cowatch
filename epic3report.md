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
