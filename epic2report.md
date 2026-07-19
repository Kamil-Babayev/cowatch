# Epic 2 — Extension: Implementation Report

Covers US-2.1 through US-2.14. Written the same way as `epic-1-report.md`: what was built, why, real bugs found along the way, then an honest split between what's actually verified and what needs a real Firefox to check.

**This report's own honesty claim is stronger than Epic 1's.** Unlike the server (Go was never available to compile), this sandbox has real Node/npm — every piece of pure logic below was actually typechecked, built, and unit-tested, not just written and reasoned through. The exceptions are called out explicitly in §3.

---

## 1. What was built, and why

### Test tooling (before any story code)
Node 22's `--experimental-strip-types` runs `.ts` test files directly — no `ts-node`/`tsx`/Jest dependency needed, consistent with the project's "avoid unneeded dependencies" pattern (YAML, Fiber, etc. in Epic 1). Two real constraints this surfaced, now documented in code comments so they don't get rediscovered the hard way:
- It's **type-erasure only** — it can strip annotations but can't transform syntax. TS constructor parameter-property shorthand (`constructor(private x: T)`) isn't just annotations, it's sugar that expands into real assignment statements, so it throws. Fixed everywhere by declaring fields explicitly instead — a project-wide rule now, not a one-off patch.
- Relative imports need explicit `.ts` extensions for Node's native ESM loader to resolve them at all (esbuild doesn't care either way, so this is safe project-wide). Required adding `allowImportingTsExtensions` to `tsconfig.json`, which is itself only legal alongside `noEmit` — which the project already had.

`jsdom` and `ws` added as devDependencies, for DOM-dependent tests and for spinning up a real mock WebSocket server in-process respectively.

### US-2.1: Extension skeleton
Manifest V3, Firefox. `browser_specific_settings.gecko.id` set to a fixed value now rather than left to Firefox's per-profile random default — cheap now, meaningful before any real AMO submission. `host_permissions` includes both `localhost:8080` (dev) and a placeholder `cowatch.app` (prod) from the start, so switching servers later isn't a manifest rework.

**Real bug found and fixed:** the config value (`SERVER_BASE_URL`) was first read as `process.env.SERVER_BASE_URL`. This built fine (esbuild's `define` doesn't check types) but failed `tsc --noEmit` outright — there's no real Node `process` in a browser extension, and silencing the error with `@types/node` would've let the rest of `src/` type-check against Node-only APIs that don't exist at runtime. Fixed with a custom `__SERVER_BASE_URL__` global and its own ambient declaration (`globals.d.ts`), so `tsc` and esbuild agree on what it actually is.

`web-ext lint` against the built output: 0 errors, 0 warnings. One forward-looking notice (`MISSING_DATA_COLLECTION_PERMISSIONS`) — Firefox will require this field eventually, not yet; noted rather than guessed at.

### US-2.2: Background WebSocket client
`connectToRoom(roomId, hostToken?, onMessage?)` — the `onMessage` handler parameter was added at this stage specifically so US-2.6 onward wouldn't need to change this function's signature after callers existed. Verified against a real `ws`-backed mock server (not just typechecked): correct connect path (`/rooms/:id/connect`), `hostToken` correctly appended as a query param (browsers can't set custom headers on a WS upgrade request), presence parsing, and clean disconnect.

### US-2.3: Video detection + candidate list
`pickLargestVisible` (pure) and `VideoDetector` (the stateful `MutationObserver` wrapper) are deliberately separate — the pure function is trivially testable, the class only adds observation/override state on top. The manual-override path (`selectOverride`/`clearOverride`) exists now, not just auto-pick, because Epic 3's US-3.4 "select the video" UI is specified to call into this exact logic rather than invent its own. Also handles the override target being removed from the DOM (falls back to auto-pick rather than holding a dangling reference).

### US-2.4: Local playback event capture
Deliberately has zero networking — DOM-in, callback-out. **Real bug found:** jsdom's `dispatchEvent` rejects `Event` instances from any realm but its own; Node's built-in global `Event` is a same-named but different class, and dispatching one throws `"parameter 1 is not of type 'Event'"` despite looking correct. Fixed by assigning jsdom's own `Event` class to the test's `global.Event`, same pattern already used for `document`/`MutationObserver`.

### US-2.5, 2.12, 2.13: Popup
Split into `api-client.ts` (pure `fetch` calls — fully unit-tested with a fake `fetch`, no real server needed) and `index.ts` (DOM wiring — untested glue, see §3). Host auto-connects to its own room immediately after creation (sends `connectRoom` to background right after the REST call succeeds) — it never goes through the landing-page/join flow, since the host is already on the right tab. `hostToken`/`roomId`/`joinUrl` are persisted to `browser.storage.session` keyed by tab ID, so reopening the popup after creating a room shows the existing link instead of a fresh "Create Room" button. "Copy Link" always mints a new token via US-1.4's endpoint rather than re-copying the existing `joinUrl` — matches the project plan's "old tokens aren't revoked, they just age out," so re-minting is always safe.

### US-2.6, 2.7, 2.8: `RoomManager` — the core relay
Ties together WS connect, local→remote and remote→local event relay, drift correction, and join-time state sync. **Real bug found:** the initial version sent `stateRequest` synchronously right after `connectToRoom` returned — but the socket is still `CONNECTING` at that point, and sending on it throws. Fixed by moving the initial `stateRequest` into the socket's own `open` handler. Caught immediately by the test suite, not by inspection.

Drift correction and join-seek math (`shouldCorrectDrift`, `computeJoinSeekTarget`) live in `shared/sync-math.ts` as pure functions, tested with zero DOM/WS involved — the same "separate pure logic from I/O" pattern used everywhere else in this build.

### `message-router.ts`
The content↔background↔popup protocol (`ToBackgroundMessage`/`ToContentMessage` in `shared/runtime-messages.ts`) is routed through a function that takes `TabsAPI`/`SessionStorageAPI` as **injected** dependencies rather than importing the real `browser.tabs`/`browser.storage.session` directly. This is what makes 100% of the routing logic testable with fakes in Node — `background/index.ts` is the only file that ever touches the real `browser` global, and it's a thin adapter, nothing more.

**Real design gap found and fixed mid-build:** content scripts have no synchronous way to learn their own tab ID (`browser.tabs.getCurrent()` isn't available there) — but the join-handoff (US-2.11) needs exactly that to look up `pendingRoomId:<tabId>` in storage. Fixed by adding a `checkPendingJoin` round-trip: content script asks, background answers using `sender.tab.id` (which it *does* have), and clears the stored key once read so a stale leftover can't cause an unrelated later page load to auto-join the same room.

**Second gap found and fixed:** the Jitsi room name (US-2.14) needs to match on both sides of a call, but only the *joiner* path naturally learns its own `roomId` (via `pendingJoinResult`) — the *host's* content script never would have, since the popup talks to background directly. Fixed by adding a `roomConnected` message that background sends on **both** paths right after a connection is established, so `content/index.ts` always has a `roomId` to derive a matching Jitsi room name from, regardless of how it got there.

### US-2.9, 2.10, 2.11: Landing page + landing-bridge
The landing page itself is **plain JS, not part of the extension bundle** — it's server-static content (per US-1.5, served from the same origin as the API), so it deliberately has no dependency on the extension's TypeScript/esbuild tooling. It races two things on load: resolving the token (`fetch('/join/' + token)`, relative — no config needed since it's same-origin by design) and a 400ms window to detect the extension. Extension detection works via `CustomEvent`s on `window`: the landing-bridge content script (matched *only* to the landing-page domain, not `<all_urls>`) dispatches `cowatch:extension-detected` on load; the page listens for it, and falls back to an install prompt if it never arrives in time. Clicking "Continue" dispatches `cowatch:join-requested` with `{roomId, videoUrl}`, which the bridge script relays to background as `joinRequested`.

### US-2.14: Jitsi embed
Cannot be verified in this sandbox at all — no network path to `meet.jit.si`, no real `getUserMedia`. Written to match Jitsi's documented IFrame API shape. The Jitsi room name is derived via SHA-256 of `roomId` (not the raw `roomId` itself) — `roomId` is "an identifier, not a secret" per `idgen.ts`'s own design, but a Jitsi room name is effectively public on Jitsi's own infrastructure (anyone who has it can join directly through Jitsi's own UI, bypassing our server entirely), so keeping the two values unlinkable is cheap defense in depth.

**Gap found in this review pass, now fixed:** US-2.14's actual acceptance criteria calls for "unstyled mute/camera-toggle **buttons**" — the first pass only built `JitsiHandle`'s `toggleAudio`/`toggleVideo` methods, with nothing in the DOM ever calling them. Fixed by rendering two bare, unstyled `<button>` elements once Jitsi injection succeeds; Epic 3's US-3.2 replaces this whole element with the real overlay.

---

## 2. Status against `cowatch-implementation-sequence.md`

| Story | Status | Verification |
|---|---|---|
| US-2.1 Extension skeleton | **Done** | Typecheck, build, `web-ext lint` all pass |
| US-2.2 Background WS client | **Done** | Real mock-server tests |
| US-2.3 Video detection + candidates | **Done** | 8 jsdom tests |
| US-2.4 Local playback event capture | **Done** | 4 jsdom tests |
| US-2.5 Popup create/leave | **Done** | API logic tested; DOM wiring is untested glue |
| US-2.6 End-to-end relay wiring | **Done** | Real mock-server tests, one real bug fixed |
| US-2.7 Drift correction | **Done** | Pure-function tests |
| US-2.8 New-joiner state sync | **Done** | Pure-function tests + RoomManager integration tests |
| US-2.9 Landing page skeleton | **Done** | Written, **not tested** — plain JS, no test harness built for it (see §3) |
| US-2.10 Extension-detection bridge | **Done** | Written, **not tested** — needs real content-script/page interaction |
| US-2.11 Join handoff | **Done** | Router logic tested with fakes; the actual `browser.tabs.update`/navigation is untested glue |
| US-2.12 Fresh-link wiring | **Done** | API logic tested |
| US-2.13 Host-only control wiring | **Done** | Routed through already-tested `message-router.ts` |
| US-2.14 Jitsi embed | **Done** | **Cannot be verified in this sandbox at all** |

**Epic 2 is functionally complete.** 43 automated tests, 98.79% line coverage on every module that has real logic in it.

---

## 3. What's tested vs. what needs real Firefox

**Fully unit-tested (43 tests, listed by file):**
`video-detector.ts`, `playback-events.ts`, `sync-math.ts`, `ws-client.ts` (against a real mock WS server), `room-manager.ts` (against a real mock WS server, including timing-sensitive drift/state-sync behavior), `message-router.ts` (100% coverage via fakes), `api-client.ts` (fetch mocked).

**Cannot be tested here, need manual verification in actual Firefox:**
- `background/index.ts`, `content/index.ts`, `popup/index.ts`, `landing-bridge/index.ts` — all depend on real `browser.*` APIs (`runtime`, `tabs`, `storage.session`) that don't exist outside an actual extension context. Their *logic* is tested (via `message-router.ts` and `api-client.ts`); their *wiring* to real browser APIs is not.
- `jitsi.ts` in full — no network access to `meet.jit.si`, no real `getUserMedia`.
- The landing page (`server-static-join/app.js`) — plain JS with no test harness built for it. The extension-detection race (400ms timeout vs. the `cowatch:extension-detected` event) is exactly the kind of timing-dependent logic worth checking by hand rather than assuming it's right.
- The full join-handoff round trip end-to-end (landing page → bridge → background → tab navigation → content script → `checkPendingJoin` → `connectRoom`) — each *link* in this chain is tested individually, but never as one continuous path through a real browser.

---

## 4. Tech debt

1. **No real Firefox has run any of this.** Everything in §3's second list is unverified beyond "it typechecks and the logic underneath it is tested." This is the single most important open item, same shape as Epic 1's "nothing has been compiled" caveat.
2. **`jsdom`'s cross-realm `Event`/`MutationObserver`/`HTMLVideoElement` assignment pattern is repeated in three test files** rather than factored into one shared test-setup helper. Harmless today, but worth consolidating before a fourth test file needs the same boilerplate.
3. **`RoomManager`'s periodic `timeSync` (host-only, every 5s) is never actually exercised by a test** — `room-manager.test.ts`'s host-session test only confirms construction/teardown don't throw, explicitly avoiding waiting out the real interval. The heartbeat's *content* (does it send the right payload on the right cadence) is unverified.
4. **The landing page's 400ms extension-detection timeout is an arbitrary number**, untested under real network/extension-load latency. Too short risks false "install prompt" for a legitimately-installed extension that's just slow to inject; too long makes every visit to the landing page feel sluggish. Worth tuning empirically once this runs for real.
5. **No coverage number is enforced anywhere** (no CI, no minimum threshold) — 98.79% today could silently regress with no automated signal.
6. **`RoomManager`'s uncovered lines (83-87, 98-99, 144) and `ws-client.ts`'s (50-52, 69) are error-handling/edge-case branches** — worth a look before Epic 3 builds UI on top of assumptions about how these fail.
7. **The Makefile additions live only in `extension/Makefile`**, a standalone file — not merged into whatever root Makefile already exists from US-0. Needs a manual merge; see the delivered file for exact targets (`test`, `test-coverage`, `test-race-note`).
8. **`server-static-join/` (the landing page) was written outside the actual server tree** (it doesn't live in your real `server/static/join/`) since this sandbox has no access to your actual repo — needs to be copied over by hand, replacing US-1.5's placeholder.

---

## 5. Inconsistencies with `cowatch-project-plan.md` and `cowatch-implementation-sequence.md`

| # | Doc | Section | What it says | What's actually true now |
|---|---|---|---|---|
| A | `cowatch-implementation-sequence.md` | US-2.9–2.11 | Describes the landing page and bridge at a high level | The actual extension-detection mechanism (`CustomEvent`s + a 400ms race) and the `checkPendingJoin`/`roomConnected` message round-trips aren't documented anywhere but this report and inline code comments |
| B | `cowatch-project-plan.md` | §3.4 (message schema table) | Lists only the WS wire-protocol message types | The much larger internal `ToBackgroundMessage`/`ToContentMessage` protocol (content↔background↔popup) is a different, undocumented layer on top of it |
| C | `cowatch-implementation-sequence.md` | US-2.14 | "Unstyled mute/camera-toggle buttons call the IFrame API's commands" | First pass built the methods but not the buttons — fixed in this pass, but worth double-checking the story's wording against what actually shipped |
| D | Neither doc | — | Never specifies where `hostToken`/session state lives client-side | Implemented as `browser.storage.session`, keyed by tab ID — a real decision that should be written down somewhere before Epic 3 builds on top of the assumption |

Recommend syncing rows A–D into the docs before starting Epic 3, same as Epic 1's report recommended for its own drift — US-3.2 and US-3.4 specifically build on the exact mechanisms in row A and D.
