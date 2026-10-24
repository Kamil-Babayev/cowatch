# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is
CoWatch: a Firefox (MV3, Firefox 140+) extension plus an in-memory Go server that syncs playback of any `<video>` (including players in cross-origin iframes) across participants, with an embedded Jitsi call. All three planned epics are complete. A later stabilization pass (`epic3report.md` "Stabilization addendum") reworked the sync protocol, video detection, event-page resilience and the Jitsi lifecycle, and restyled every surface in a macOS Monterey look.

Design intent lives in the planning docs — read the relevant one before changing architecture or behavior rather than re-deriving the design:
- `cowatch-project-plan.md` — architecture, core concepts (room vs. join link, control modes, DRM assumptions).
- `cowatch-implementation-sequence.md` — Epics → stories → subtasks; Appendix A explains ordering decisions.
- `epic1report.md`, `epic2report.md`, `epic3report.md` — what was actually built, deviations from the plan, tech debt. The inconsistency tables (epic1 §4, epic2 §5) list known doc/code drift.
- `README.md` — deployment (Render, Docker, public-IP test), release process, manual release checklist. `server/README.md` + `server/openapi.yaml` — HTTP API and WebSocket protocol.
- `AGENTS.md` — style and commit conventions (shared with other agents).

## Commands
Root `Makefile` wraps everything (`extension/Makefile` is a legacy standalone copy; prefer the root one):

```sh
make install          # npm ci in extension/
make go-run           # server on :8080 (ADDR, JOIN_BASE_URL env vars)
make dev              # esbuild --watch + web-ext run (launches Firefox)
make go-test          # / go-test-race / go-test-cover
make typecheck        # tsc --noEmit
make test             # extension tests; make test-coverage enforces 80% lines
make build            # extension/dist/
make lint             # web-ext lint on dist (run after build)
make package          # build + verify-build.mjs + lint + zip into extension/artifacts/
make verify           # go-test typecheck test-coverage build lint
```

Single tests:
- Go: `cd server && go test ./internal/ws -run TestName -race`
- Extension: `cd extension && node --experimental-strip-types --test src/shared/sync-math.test.ts` (add `--test-name-pattern="..."` to filter). Tests use `node:test`'s `test(...)`.

`npm test` also runs `extension/test/*.test.mjs` and `server/static/join/app.test.mjs` (the landing page's tests live in the server tree but run under the extension's Node toolchain).

CI (`.github/workflows/test.yml`) additionally requires `gofmt -l .` to be empty, `go vet`, and ≥80% aggregate Go statement coverage. Pushing a `v*` tag runs `package-extension.yml`, which fails unless the tag matches `version` in **both** `extension/manifest.json` and `extension/package.json`.

### Build-time configuration
The extension bakes its config in at build time (`extension/build-config.mjs`, `build.mjs`), never at runtime:
- `SERVER_BASE_URL` (default `http://localhost:8080`) — must be a bare origin and must equal the server's `JOIN_BASE_URL`, or join links and origin checks break. `build.mjs` rewrites the landing-bridge content script's `matches` in `dist/manifest.json` from it (the `localhost` value in source `manifest.json` is only a placeholder).
- `JITSI_DOMAIN` (default `localhost:8443`, the local docker-jitsi-meet described in README's "Local Jitsi for development"; the release workflow uses the `JITSI_DOMAIN` repository variable and falls back to `meet.jit.si`, whose embedded calls are time-limited and need a moderator login).
- `COWATCH_DEBUG=1` — enables `debugLog` output (`[CoWatch debug]`) via the `__COWATCH_DEBUG__` define.

`build.mjs` also patches `vendor/jitsi-external-api.js` (removes `Function(...)` eval patterns for AMO lint) and throws if the vendored file's shape changes — update the replacements if you re-vendor Jitsi.

## Architecture

### Server (`server/`)
Go, `net/http` + `gorilla/websocket`, all state in memory (restart wipes rooms/tokens). `internal/api` (REST handlers, origin check, rate limit, bearer host-token auth), `internal/store` (rooms, 10-minute join tokens), `internal/ws` (hub/client per room, ping/pong, relay), `internal/config`, `internal/idgen`. `static/` embeds the join landing page served at `/join-page/`. Host authority is decided server-side (constant-time host-token check, announced in the `session` frame); in host-only rooms joiner playback messages are rejected with `controlDenied`. A host that sends `leaveRoom` (or closes its tab) closes the room at once (`roomClosed`); a host whose connection just drops gets a 30 s grace period to reconnect.

The WS envelope is `{type, payload, timestamp}` (`internal/ws/message.go`); timestamps are server-stamped. Protocol rules worth knowing before touching sync (full table in `server/README.md`): `playerCommand` is last-writer-wins and bumps the revision; `playerHeartbeat` (host only) applies only on the current revision, never bumps it, and is not echoed to its sender; `playerState` carries `originConnectionId` so the sender skips its own; native `mediaKey` is an opaque page-derived key, never a `blob:`/CDN URL; `clockPing`/`clockPong` give clients their clock offset. `GET /rooms/{id}` lets clients detect a closed room. `TRUST_PROXY` makes rate limiting use `X-Forwarded-For`.

### Extension (`extension/src/`), organized by runtime context
- **background/** — the event page owns all room WebSockets. `index.ts` is the only file touching `browser.*`; it injects thin adapters into `message-router.ts` (routes runtime messages, restores sessions from `storage.session` on startup, single `onSelectionChanged` path that re-sends `sessionInfo` + `requestState`), `room-manager.ts` (per-tab socket, clock offset, own-echo skipping, reconnect + room-gone check) and `video-coordinator.ts` (enumerates frames, ranks candidates by effective visible area, sticky selection, serialized/coalesced discovery). Firefox unloads idle event pages, so nothing important may live only in memory: the overlay sends a `keepalive` every 20 s, and `storage.session` (`activeSession:*`, `hostSession:*`, `pendingRoomId:*`) is the source of truth.
- **content/frame-agent.ts** — `FrameAgent` class, bootstrapped by `frame-agent-main.ts` in **every** frame (`all_frames`, `match_about_blank`). Scans the document including shadow roots (`media-scan.ts`), gives candidates per-document ids, probes adapters without blocking status requests, and applies room states through a latest-wins queue. Players are driven through `PlayerAdapter` (`shared/player.ts`): `native-player-adapter.ts` for `<video>`, `playerjs-adapter.ts` for PlayerJS/"obrut" iframes via `postMessage`. Echo suppression is per adapter (`echo-filter.ts`), and the drift policy is in `shared/sync-math.ts`.
- **content/index.ts** — top frame only, bootstrap for `overlay-controller.ts` (room/call lifecycle with generation tokens; no DOM) and `overlay-view.ts` (HUD + call card + picker in a closed shadow root). The view's host is a `popover="manual"` top-layer element, re-shown on `fullscreenchange`; never move it in the DOM, because that reloads the Jitsi iframe. `jitsi.ts` wraps the IFrame API and reports join/error/mute events.
- **popup/** — sends `createRoom` to the background (so closing the popup can't orphan a room), shows host or guest state from `storage.session`.
- **landing-bridge/** — injected only on `<server>/join-page/*`; answers the landing page's `CustomEvent` extension-detection handshake and forwards `joinRequested` to background.
- **shared/** — `runtime-messages.ts` is the internal content↔background↔popup protocol; `messages.ts` mirrors the server WS payloads; `page-key.ts` normalizes page URLs (media identity and "same page" checks); `join-url.ts` canonicalizes invite links against the compiled `SERVER_BASE_URL`.

Changing a WS message type means touching both `server/internal/ws/message.go` and `extension/src/shared/messages.ts` (plus their tests).

## Conventions specific to this repo
- **Pure logic vs. I/O:** anything touching `browser.*`, the DOM, or the network goes in a thin adapter injected as a plain interface (see `TabsAPI`/`SessionStorageAPI` in `message-router.ts`, `FrameTabsAPI`/`WebNavigationAPI` in `video-coordinator.ts`). New code must follow this so it stays testable without a browser. `jsdom` only for genuinely DOM-dependent tests; `ws` for in-process mock WebSocket servers.
- **Node type-stripping constraints** (tests run `.ts` directly with `--experimental-strip-types`): no constructor parameter properties (`constructor(private x: T)`) — declare fields explicitly; relative imports must use explicit `.ts` extensions; avoid other TS-only emitting syntax (`enum`, `namespace`).
- **Tests ≠ works in Firefox.** `background/index.ts`, `content/index.ts`, `content/frame-agent-main.ts`, `popup/index.ts` and `landing-bridge/index.ts` are wiring to real browser APIs, and the top-layer/fullscreen, Jitsi and event-page behaviors can only be verified in Firefox; unit tests cover the injected logic, not that wiring. Verify affected flows manually (README's "Manual release checklist") and say so when you couldn't.
- No site-specific player rules in generic detection; provider-specific behavior belongs in a `PlayerAdapter`.
- **Styling:** the three surfaces (`popup/popup.css`, `content/overlay.css`, `server/static/join/landing.css`) share one Monterey token block, copied identically, because the landing page is served by Go and can't share a file with the extension. Keep them in sync, keep the `[hidden] { display: none !important }` rules (JS toggles `hidden`), and build DOM icons with `createElementNS` rather than `innerHTML` (AMO lint flags it). Fonts: Mac system font first, then the bundled Inter as `'CoWatch Inter'` (`extension/vendor/fonts/`, copied to `server/static/join/`; the overlay registers it via `FontFace` from binary data so page CSP can't block it). The app icon is `extension/icons/cowatch.svg` (copied to `server/static/join/`).
- When implementation and a planning doc disagree, update the doc (or the epic report's inconsistency table) in the same change.
