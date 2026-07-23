# CoWatch — Implementation Sequence

Derived from `cowatch-project-plan.md`. Ordered **Setup → Server → Extension → UI**, per your instruction. This is the version *after* three review rounds (Appendix A) — the numbering below is already the fixed version, not the first draft.

**Sequencing rule:** every story assumes only what US-0 locked in and what strictly earlier stories delivered. "No additional setup" means no new tool, no new service, no new architecture decision is needed to start it — extending a file an earlier story already created (e.g. adding a field to an existing handler) is normal incremental work, not a setup gap.

### Epic overview

| Epic | Stories | Depends on |
|---|---|---|
| 0 — Setup | US-0 (1 story, 5 subtasks) | nothing |
| 1 — Server Logic | US-1.1 – US-1.10 | Epic 0 |
| 2 — Extension | US-2.1 – US-2.14 | Epic 1 (a running server to point at) |
| 3 — UI / Frontend | US-3.1 – US-3.6 (US-3.4 includes one small non-UI fix) | Epic 2 (functional logic to skin, and in one place, extend — not rebuild) |

---

## Epic 0 — Setup

### US-0: Project setup
*As a developer, I want the repo, tooling, and key decisions locked in before writing any feature code, so that every later story is purely "add code."*

Subtasks:
1. **Repo structure** — monorepo: `/server` (Go, will also serve the landing page's static files — see US-1.5), `/extension` (WebExtension). `.gitignore`, `LICENSE`, root `README.md` linking to the project plan.
2. **Tech-stack decisions, recorded in-repo:** Go + `net/http` + `gorilla/websocket` for the server; plain TypeScript (no framework) for the extension, bundled with `esbuild`; Jitsi's public `meet.jit.si` instance for v1.
3. **Local HTTPS.** Set up `mkcert` (or equivalent) so `https://localhost:<port>` works for the server from day one. This is easy to skip and only bite later: `getUserMedia` (needed for Jitsi in Epic 2) requires a secure context, so this needs to exist *before* Epic 2 gets there, not be discovered mid-story.
4. **Makefile:** `make dev-server` (runs the Go server with reload), `make dev-ext` (runs `web-ext run` for live-reloading the extension in Firefox), `make build-ext`, `make lint`, `make test`.
5. **Explicitly deferred:** Dockerization/deployment (Cloudflare Tunnel, etc., discussed earlier) is out of scope for this sequence — nothing in Epics 1–3 needs it, and folding it in now would just be setup nobody uses for a while. Worth its own Epic 4 later if you want it planned out too.

---

## Epic 1 — Server Logic

Fully testable standalone via `curl` / a WebSocket CLI client — no extension involved anywhere in this epic.

### US-1.1: HTTP skeleton + health check
*As a developer, I want a server that runs and reports healthy, so every later story has something to attach to.*
- `go run ./server` starts on a configurable port.
- `GET /healthz` → `200`.

### US-1.2: Room creation
*As a host, I want to create a room from a video URL and a control-mode choice, so I get everything needed to invite others and authenticate myself later — all in one response.*
- `POST /rooms` `{videoUrl, controlMode}` → `{roomId, joinToken, joinUrl, hostToken}`.
- `hostToken` is issued **here**, not bolted on later — it's the only thing that will ever prove "I'm the host" over a WebSocket connection in US-1.6/US-1.9, so it needs to exist from the first response, not be retrofitted once control-mode enforcement is designed.
- Subtasks: `Room` struct (id, videoUrl, controlMode, createdAt, hostToken, `lastKnownState` placeholder) · crypto-random ID/token generation, three independent values · in-memory store (map + mutex) · handler + routing.

### US-1.3: Join-token resolution
*As a joiner, I want clicking a link to clearly tell me whether it's still good, so I get a real outcome instead of a silent failure.*
- `GET /join/:token` → `{roomId, videoUrl}` if valid; a distinct "expired" response past the 10-minute TTL; `404` if unknown.
- The three outcomes need genuinely distinct shapes — the landing page (Epic 2) has to branch on them.

### US-1.4: Fresh-link minting
*As a host, I want to generate a new link for a room I already made, so an expired link doesn't mean starting over.*
- `POST /rooms/:roomId/tokens`, authenticated via `hostToken` → new `{joinToken, joinUrl}`. Old tokens aren't revoked — they just age out (matches §3.1 of the project plan).
- Reuses the token-generation logic from US-1.2 rather than duplicating it.

### US-1.5: Static landing-page route
*As a developer, I want the landing page served from the same origin as the API, so Epic 2 never has to stand up a second dev server or deal with CORS just to build the join flow.*
- `GET /join-page/*` serves a static bundle; a placeholder `index.html` is enough for now (real content is Epic 2/3's job).

### US-1.6: WebSocket hub + presence
*As a developer, I want clients to join a per-room group and see who's there — including who's the host — so sync and the "who's in control" indicator both have real data to work from later.*
- `WS /rooms/:roomId/connect`. Each connection tagged with a connection ID and, if a valid `hostToken` is presented, `isHost: true`.
- `presence` broadcasts the full connection list (with `isHost` flags) on every join/leave — this is what Epic 3's "who has control" indicator will render, so the data needs to exist now, not get invented at the UI stage.

### US-1.7: Playback relay
*As a developer, I want play/pause/seek relayed to everyone else, so sync works without the server understanding video semantics yet.*
- Any `play` / `pause` / `seeked` / `timeSync` message is broadcast verbatim to every other connection in the room. No filtering yet — that's US-1.9.

### US-1.8: Last-known-state cache
*As a joiner, I want the room's current state the moment I connect, so I don't start at 0:00 or wait on some other client to answer.*
- Extends US-1.7's relay handler with a side effect: update an in-memory `lastKnownState` on the room for every relayed message.
- `stateRequest` → immediate `stateResponse` **from the server**, not from another client (a client-to-client answer would be a race condition waiting to happen if that client is mid-navigation).

### US-1.9: Host-only control enforcement
*As a host, I want to optionally restrict who can control playback, so a noisy room doesn't turn into everyone fighting over the remote.*
- If `controlMode == "host-only"`: drop (don't relay) playback messages from any connection where `isHost` is false.
- A guard clause added to US-1.7's handler, using the `isHost` flag already established in US-1.6 and the `controlMode` already stored since US-1.2 — no new data needed, purely enforcement logic.

### US-1.10: Validation & hardening
*As a developer, I want bad input rejected cleanly, so Epic 2 debugging is never actually "the server accepted garbage."*
- `videoUrl` must be a well-formed `http(s)` URL or `POST /rooms` 400s. Unknown `roomId` on any route → `404`, never a panic. Naive per-IP rate limit on room creation.
- Deliberately last: earlier stories move faster while shapes are still settling, and nothing before this depends on strict validation existing.

---

## Epic 2 — Extension

Functional logic and minimal/no styling. Epic 3 re-skins this; it doesn't rebuild it.

### US-2.1: Extension skeleton & dev workflow
*As a developer, I want a loadable, auto-reloading skeleton, so every later story is "add code," never "first get anything running."*
- `manifest.json` (MV3, Firefox), background + content scripts that just log on load, loaded via `about:debugging`. `make dev-ext` runs `web-ext run`.
- `host_permissions` includes `<all_urls>` for the content script, plus **both** `localhost` and the intended production landing-page domain (even as a placeholder) — so going to production later isn't a manifest rework. See US-2.9.

### US-2.2: Background WebSocket client
*As a developer, I want the background script able to open/close a WebSocket to a room, so connection logic is proven in isolation before anything depends on it.*
- Given a `roomId` (and optional `hostToken`), opens a WS connection to the Epic 1 server, logs incoming `presence` messages.
- Testable against a room created via `curl` — no content script or popup involved yet.

### US-2.3: Video detection + candidate list
*As a developer, I want the content script to find the right `<video>` element anywhere, so sync has something concrete to attach to — and so a manual override is possible later without new detection logic.*
- `MutationObserver`-based detection; defaults to the largest visible `<video>` when several exist (ad players, thumbnails, background loops).
- Exposes an internal function — callable via devtools console for now — that lists all candidates and force-selects one. This is the exact function Epic 3's "select the video" UI (US-3.4) will call; it needs to exist now, not get invented at the UI stage.

### US-2.4: Local playback event capture
*As a developer, I want local play/pause/seek captured before any networking is involved, so event-capture bugs and networking bugs are never debugged at the same time.*
- Listeners on the element chosen by US-2.3, logged to console only.

### US-2.5: Popup — Create Room & Leave Room
*As a host, I want a button that turns my tab into a room and another that ends it, so I don't need the console to start or stop a watch party.*
- "Create Room" (disabled if US-2.3 found no video) calls US-1.2, stores the returned `hostToken` keyed to this tab/room (not a stray variable — it has to survive the popup closing), and immediately tells the background script (US-2.2) to connect using it.
- The host's own tab connects **immediately on creation** — it never goes through the landing-page/join flow at all, since the host is already on the right page. This needs to be explicit here, or it's easy to assume the host has to "join their own room" like everyone else.
- "Leave Room" closes that connection.

### US-2.6: End-to-end relay wiring
*As a host and a joiner, I want my play/pause/seek to actually show up on the other person's screen — this is the story that proves the whole project's premise.*
- Local event (US-2.4) → background WS (US-2.2) → server relay (US-1.7) → remote background → remote content script applies it.
- Feedback-loop guard: an event applied *from* the network must not re-fire as if it were local.
- Verified across two browser profiles pointed at the same manually-shared `roomId`.

### US-2.7: Drift correction
*As a joiner, I want small timing gaps to self-correct quietly, so I'm not yanked around by every minor network blip.*
- Control-holder sends `timeSync` every ~5s; others correct only past a ~1.5s threshold.

### US-2.8: New-joiner state sync
*As a joiner, I want to start at the right position, not 0:00, so joining mid-movie doesn't mean missing the first half.*
- On connect: send `stateRequest`, receive US-1.8's `stateResponse`, compute elapsed time since its timestamp, seek, then play.

### US-2.9: Landing page skeleton
*As a joiner, I want to see what I'm about to join before anything happens, so I'm never silently redirected.*
- Served from US-1.5's static route. Calls `GET /join/:token`. Renders "valid → shows destination domain + continue," "expired," or "unknown" states.
- Confirms the manifest match list from US-2.1 actually covers wherever this page is being served from during dev.

### US-2.10: Extension-detection bridge
*As a joiner without the extension, I want to be told to install it; as one who has it, I want that friction skipped.*
- A content script matching only the landing-page domain messages the background script directly (US-2.2's existing channel — no `externally_connectable` needed).
- Page shows "extension detected, continue" or "install the extension" accordingly.

### US-2.11: Join handoff
*As a joiner, I want clicking continue to land me already synced, so joining feels like one action, not five.*
- Background navigates the tab to the real `videoUrl`, storing `{pendingRoomId}` in `storage.session` — not a plain variable, since Firefox's MV3 background page is a non-persistent event page that can be suspended.
- On the target page's load, content script checks for the pending join and runs the same connect + state-sync path already proven in US-2.6/US-2.8.

### US-2.12: Fresh-link wiring
*As a host, I want "copy link" to always work, even after the first one expires, so I don't have to explain a dead link to my friends.*
- Popup button calls US-1.4 using the stored `hostToken`.

### US-2.13: Host-only control wiring
*As a host, I want to choose whether everyone or just I can control playback, so I can match the mode to how chaotic the group is.*
- Popup's create-room step (US-2.5) gets a control-mode choice, passed to US-1.2.
- Content script surfaces (internally — Epic 3 renders it) whose connection currently `isHost`, sourced straight from US-1.6's `presence` payload. No new server behavior needed — purely wiring.

### US-2.14: Jitsi embed
*As anyone in the room, I want to see and talk to everyone else, so watching together doesn't mean watching in silence.*
- Jitsi IFrame API embedded; room name derived deterministically from `roomId`; iframe has `allow="camera *; microphone *; display-capture *"`.
- Unstyled mute/camera-toggle buttons call the IFrame API's `toggleAudio`/`toggleVideo`.
- Confirms dev is running over HTTPS/localhost (US-0) before testing — `getUserMedia` fails silently otherwise, and this is the first story where it'd actually bite.

---

## Epic 3 — UI / Frontend Handling

Mostly a visual/UX layer over already-working logic — **with one deliberate exception, US-3.4's local re-sync fix (see below).** This epic is grounded in the actual Epic 2 codebase (per `epic-2-report.md`), not the pre-implementation assumptions the original version of this section made — two of which turned out to be wrong; see Appendix A, Round 4.

### US-3.0 (folded into US-3.1): CSS delivery decision
No new bundler tooling needed for popup/landing page. Plain `.css` files, `<link rel="stylesheet">` in their existing HTML (US-3.1, US-3.5). `build.mjs` copies these into `dist/` alongside the HTML it already copies.

**Corrected while actually building US-3.2** (this section originally said the in-page overlay's CSS would go through manifest's `content_scripts[0].css` array — that's wrong): a shadow DOM root is isolated from page-level stylesheets by design, the same isolation that keeps the host site's CSS out also keeps `content_scripts.css` out. The overlay's CSS is instead imported as a raw string via esbuild's `loader: { '.css': 'text' }` and injected as an inline `<style>` directly inside the shadow root — no manifest changes, no `web_accessible_resources` needed (which a `<link>` to a packaged CSS file would have required instead, since a page-inserted `moz-extension://` reference needs that declared).

### US-3.1: Popup visual redesign
*As a host, I want the popup to look intentional, so the tool feels trustworthy enough to actually share.*
- Styles the **exact existing DOM** from US-2.5/US-2.12/US-2.13 — `#create-view`, `#control-mode`, `#create-room-btn`, `#room-view`, `#join-url`, `#copy-link-btn`, `#expiry-note`, `#leave-room-btn`, `#status`. No new elements, no ID changes — `popup/index.ts`'s existing `document.getElementById` calls must keep working untouched.
- Establishes the CSS delivery pattern (US-3.0) other stories in this epic reuse.

### US-3.2: In-page overlay shell
*As anyone in the room, I want a real control bar on the page itself, not just the toolbar popup, so I don't have to leave the video to manage the call.*
- **Replaces** the bare `#cowatch-jitsi-controls` div `content/index.ts` already injects (US-2.14) — this is a real retrofit, not a clean-slate build. The original version of this story assumed Epic 2 never touched the page's DOM directly; it did.
- Shadow-DOM container (so the host site's CSS can't clobber it) holding: the existing Jitsi iframe (already rendering its own participant video internally — this story sizes/positions that iframe, it does not build separate custom camera tiles), the existing `toggleAudio`/`toggleVideo` buttons re-skinned in place, and **new** Leave/Copy-Link buttons as a second, in-page entry point alongside the popup's — calling the exact same `leaveRoom` message and `mintFreshLink` API-client function already built in US-2.5/US-2.12, not new logic.

### US-3.3: Fullscreen re-parenting
*As a viewer, I want the control bar to survive fullscreen, so I'm not stuck alt-tabbing out just to mute myself.*
- On `fullscreenchange`, re-parent US-3.2's container into the browser's native fullscreen element and back.

### US-3.4: Presence tracking, control indicator, and controlDenied recovery
*As a participant, I want to see who's driving playback, fix a wrong video guess myself, and not end up silently out of sync if my own action gets rejected.*
- **New, small, necessary logic** (not purely visual — flagged explicitly rather than smuggled in under "just rendering"): `content/index.ts` currently only `console.log`s `presenceUpdate` and `controlDenied` — neither is stored anywhere. Add a small state holder (latest presence list, own `isHost`, last `controlDenied` reason) for the UI below to actually render from.
- "Who has control" indicator, rendered from that new state.
- **The local re-sync fix**, this epic's one real exception to "no new functional behavior": in host-only mode, a non-host's native player action (e.g. clicking the site's own pause button) already moves their *local* video — only the broadcast gets blocked server-side (US-1.9). The project deliberately never wraps the site's native controls (§7.2 of the project plan), so "grey out the controls" isn't literally achievable for them. Instead: on receiving `controlDenied`, immediately send a `stateRequest` (reusing US-2.8's already-built path, no new message types) and reapply the authoritative state — so a rejected local action self-corrects within a second or two instead of leaving that participant permanently drifted with no way back in sync except luck.
- "Select the video" overlay, calling the candidate-list function already fully built in US-2.3 (`listCandidates`/`selectOverride`/`clearOverride`) — this part of the original plan held up correctly; no changes needed here.

### US-3.5: Landing page visual design
*As a joiner, I want the landing page to look like part of the same product, so clicking a friend's link feels safe.*
- Styles the **exact existing DOM** from US-2.9/US-2.10/US-2.11 — `#state-loading`, `#state-valid` (+ `#destination-domain`, `#continue-btn`), `#state-expired`, `#state-not-found`, `#state-no-extension`. `app.js`'s state-machine logic (including the 400ms extension-detection race — see `epic-2-report.md` tech debt #4) is untouched.

### US-3.6: Final polish pass
*As anyone using it, I want consistent empty/error states everywhere, so nothing feels half-finished.*
- Sweep popup, overlay, and landing page for missing loading/error states.
- Specifically confirm: the `controlDenied` indicator appears *and* disappears correctly (not just on first trigger), and Jitsi injection failure (`content/index.ts`'s existing `.catch`, currently console-only) gets a visible "video chat unavailable" state in the overlay instead of silently doing nothing.

---

## Appendix A — Review & Revision Log

### Round 1 — structural gaps
1. **No secure-context step before Jitsi/`getUserMedia` work.** Epic 2's Jitsi story would have hit a silent camera/mic failure with no HTTPS in place. → Added to US-0 (subtask 3).
2. **`hostToken` was going to be bolted onto room creation retroactively**, once host-only enforcement got designed. That's a rework of an already-finished story. → Issued upfront in US-1.2; US-1.9 stays purely additive.
3. **Landing page had no defined home during dev**, implying a second ad-hoc dev server. → Added US-1.5 (served from the same origin as the API).
4. **Docker-compose was front-loaded into setup** despite nothing in Epics 1–3 needing it. → Trimmed from US-0; deployment explicitly deferred.
5. **Nothing made explicit that the host's own tab auto-connects immediately** after creating a room — it isn't a "joiner" and shouldn't touch the landing-page flow at all. → Folded into US-2.5.

### Round 2 — subtler issues, after Round 1 fixes
1. **`hostToken` existing as a value isn't the same as it reaching the WebSocket connection.** → Made explicit in US-2.5's acceptance criteria (stored keyed to the tab, used to connect immediately).
2. **Manifest match patterns only covered one domain** — switching from dev to production later would've meant a manifest rework mid-project. → Both domains included from US-2.1 onward.
3. **Checked whether Epic 3's overlay (US-3.2) would need to retrofit some ad-hoc in-page element from Epic 2** — it wouldn't: Epic 2 only ever added a Leave button to the *popup* (US-2.5), never injected anything into the page itself. Confirmed clean, no fix needed.
4. **"Who has control" data would've been invented at the UI stage** (Epic 3) if the server wasn't already broadcasting it. → Pulled into US-1.6's `presence` payload as an `isHost` flag.
5. **"Select the video" override needed its underlying candidate-list logic to already exist**, or Epic 3 would be building detection logic disguised as a UI story. → Made explicit as part of US-2.3's scope from the start.

### Round 3 — final pass
1. Considered moving input validation (US-1.10) earlier, since "validate from day one" is generally good practice. Kept it late deliberately — nothing before it depends on strict validation, and earlier stories move faster while shapes are still settling.
2. Re-confirmed epic boundaries stayed clean: Epic 1 has zero extension code, Epic 2 introduces no new server behavior, Epic 3 introduces no new functional logic anywhere.
3. No further sequencing gaps found.

**Verdict:** stable after Round 3 — every story only needs US-0's decisions plus strictly earlier stories' output. No open inconsistencies in ordering, dependencies, or scope.

### Round 4 — after Epic 2 actually shipped, reviewing Epic 3 against real code
Epic 3 was originally planned before Epic 1 or 2 existed. Two of Round 2's own findings turned out to be wrong once real code existed to check against — worth recording that a "confirmed, no issue" verdict from an earlier round isn't permanent if the thing it was checking hasn't been built yet.

1. **Round 2 explicitly confirmed "Epic 2 never injects anything into the page itself"** — checked against the *plan* for US-2.14, not the code, since the code didn't exist yet. It turned out to be false: `content/index.ts` injects a bare `#cowatch-jitsi-controls` div with real buttons (added during Epic 2 build to satisfy US-2.14's own acceptance criteria, which the first implementation pass had actually missed and had to fix — see `epic-2-report.md` §1). → US-3.2 rewritten to explicitly replace that element, not build fresh.
2. **Round 2 also confirmed "who has control" data reaches the client** (via `presence`'s `isHost` flag) **and treated that as sufficient** — it reaches `content/index.ts`, but is only ever `console.log`'d, never stored anywhere a UI could read it from. → US-3.4 now includes adding that small state holder explicitly, rather than assuming "the data exists" meant "the data is usable."
3. **New gap, not foreseeable before Epic 2 existed:** host-only mode's `controlDenied` (added mid-Epic-1, after this sequence's original Epic 3 section was written) blocks the *broadcast* of a non-host's action, but nothing stops their *local* video from already having moved — and the project's own design never wraps the site's native player controls, so "grey out the controls" (the plan originally discussed) isn't achievable for them. → US-3.4 grew a small, explicitly-flagged non-UI fix: re-request and reapply authoritative state via the already-existing `stateRequest`/`stateResponse` path on every `controlDenied`.
4. Re-confirmed US-3.1, US-3.3, US-3.5, and the "select the video" half of US-3.4 all still hold up exactly as originally planned — the exact DOM they style/wrap was checked directly against the real HTML/TS from Epic 2, not assumed.

**Verdict:** Epic 3 revised and re-stabilized against the real Epic 2 codebase. The lesson worth keeping for Epic 4 or any future epic: a round that "confirms no issue" against a plan for work that hasn't been built yet should be re-checked once that work actually exists, not treated as settled.
## v1 completion status (July 2026)

US-3.4, US-3.5, and US-3.6 are implemented. The final pass also closes
cross-epic defects that the original sequence could not anticipate:

- authority now comes from a server-authored `session` message rather than
  possession of a token in extension state;
- playback snapshots always carry both corrected time and play/pause state;
- host-only denial requests and reapplies authoritative state;
- actual video time is sampled in the content script for immediate and
  five-second host heartbeats;
- video selection, persistent presence/control status, room closure, Jitsi
  retry, accessible landing states, and event-page session restoration are
  included in the completed UI;
- host departure closes the room, and graceful shutdown sends
  `roomClosed` with `server-shutdown`;
- Firefox 140, local Jitsi wrapper packaging, separate 80% coverage gates,
  OpenAPI, privacy documentation, and PR checks are release requirements.

Production deployment and AMO submission remain a later release activity.
