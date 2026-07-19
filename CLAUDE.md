# CLAUDE.md

Context file for Claude Code (or any agentic coding session) working in this repo.

## What this project is
CoWatch (working title) — a Firefox extension that syncs video playback across any site with a `<video>` element, plus embedded video/voice chat via Jitsi. Full rationale, architecture, and UX flows live in the planning docs below — read them before writing code, don't re-derive the design from scratch.

## Current state
**Epic 1 (server) and Epic 2 (extension) are functionally complete. Epic 3 (UI) hasn't been started.** Six files exist so far:

- **`cowatch-project-plan.md`** — what we're building and why: architecture, core concepts (room vs. join link, control modes, the DRM/playback-state assumption everything rests on), and the four phases (sync logic → room lifecycle → video chat → UI).
- **`cowatch-implementation-sequence.md`** — how to build it: Epics → User Stories → Subtasks, strictly ordered Setup → Server → Extension → UI. Each story is scoped so the next one needs no new tooling, services, or architecture decisions — only code.
- **`epic-1-report.md`** — what actually got built in Epic 1, why, every bug found along the way, and the tech-debt + doc-drift lists. **Read before touching server code** — documents real deviations from the two docs above that haven't been back-ported.
- **`epic-2-report.md`** — same, for the extension. **Read before touching extension code.** Also documents which parts are genuinely test-verified vs. which are typechecked-but-never-run-in-real-Firefox — that split matters a lot here, see below.

**Before writing any new server code:** `go build`/`go vet`/any test has never been run against it — Go was never available in the environment it was built in. Verify it compiles before assuming any of it works.

**Before writing any new extension code:** unlike the server, this one *was* verified where it's possible to — 43 automated tests, 98.79% line coverage, real typecheck/build/`web-ext lint` passes. But nothing has run in an actual Firefox instance. `background/index.ts`, `content/index.ts`, `popup/index.ts`, `landing-bridge/index.ts`, and all of `jitsi.ts` depend on real `browser.*` APIs, a real DOM, or a real network path to Jitsi — none of which exist in the sandbox this was built in. Their *logic* is tested (via dependency-injected fakes, see the pattern below); their *wiring to real browser APIs* is not. Don't treat "the tests pass" as "this works in Firefox" for those files specifically.

## Working agreement for implementation
- **Follow the sequence in `cowatch-implementation-sequence.md` in order.** Don't jump ahead to a later story or epic even if it looks quick — the ordering is deliberate (see that file's Appendix A for why).
- Epic 1 (server) is meant to be fully working and testable via `curl`/a WebSocket client — confirm it actually builds first, since that step is still outstanding.
- Epic 2 (extension) delivers working logic with bare/unstyled UI. Epic 3 re-skins it — don't add real styling early or rebuild logic late.
- **Extension code pattern, established across Epic 2, keep following it:** separate pure logic from I/O. Anything that touches `browser.*` APIs, the DOM, or the network should be a thin adapter injected into a function/class that takes plain interfaces instead (see `message-router.ts`'s `TabsAPI`/`SessionStorageAPI`, or `room-manager.ts` built on top of `ws-client.ts`). This is what makes 98.79% coverage possible without a real browser — new code that skips this pattern will be much harder to test the same way.
- **Two Node/TypeScript constraints specific to this project's test setup, not general TS knowledge:** (1) no constructor parameter-property shorthand anywhere (`constructor(private x: T)`) — Node's `--experimental-strip-types` (how tests run directly, see `extension/package.json`'s `test` script) only erases type annotations, it can't transform that syntax, and it throws. Declare fields explicitly instead. (2) relative imports need explicit `.ts` extensions (Node's native ESM loader requires them; esbuild doesn't care either way, so this is safe everywhere) — `tsconfig.json`'s `allowImportingTsExtensions` is what makes `tsc` accept this.
- If a story turns out to need something not yet decided (a new tool, a new service, a changed data shape), stop and flag it rather than quietly improvising — it likely means the sequence has a gap that should be fixed in `cowatch-implementation-sequence.md` first, the same way its own Appendix A documents earlier fixes.
- When code and a planning doc disagree (see `epic-1-report.md` §4 and `epic-2-report.md` §5 for the current known lists), fix the doc in the same change you touch the related code — don't let the lists grow further before they're reconciled.

## Tech stack (locked in, see US-0; extension tooling added during Epic 2)
- Server: Go, `net/http`, `gorilla/websocket` — dependency not yet fetched/pinned, see `epic-1-report.md` tech debt #2.
- Extension: TypeScript, no framework, bundled with `esbuild`, Manifest V3, Firefox only for v1.
- Extension tests: Node's built-in test runner (`node --test`, run directly against `.ts` via `--experimental-strip-types` — no Jest/ts-node/tsx dependency), `jsdom` for DOM-dependent tests, `ws` for spinning up real mock WebSocket servers in-process. Run with `npm test` / `npm run test:coverage` inside `extension/`, or `make test` / `make test-coverage` (see `extension/Makefile` — not yet merged into the root Makefile, see below).
- Video chat: Jitsi IFrame API against the public `meet.jit.si` instance.

## Known gaps before continuing
**Server** (full detail in `epic-1-report.md` §3–4):
- Server code has never been compiled or tested.
- `ws/handler.go` may still have a leftover, unused package-level `upgrader` var from before US-1.10's refactor — worth a direct look.
- Small doc/code drifts exist (join-link outcomes, the `controlDenied` message type, `joinUrl`'s actual shape) — check the report's inconsistency table before extending US-1.3, US-1.9, US-2.9, or US-3.4.

**Extension** (full detail in `epic-2-report.md` §3–5):
- Nothing has run in real Firefox yet — see "Current state" above.
- `extension/Makefile`'s targets (`test`, `test-coverage`, etc.) were only written as a standalone file — need to be manually merged into whatever root Makefile already exists from US-0.
- The landing page (`server-static-join-DROP-INTO-server-static-join/` in the last delivery) was written outside the actual server tree and needs to be copied by hand into the real `server/static/join/`, replacing US-1.5's placeholder.
- The internal content↔background↔popup message protocol (`ToBackgroundMessage`/`ToContentMessage`) and the `CustomEvent`-based landing-page/extension-detection handshake aren't documented anywhere but `epic-2-report.md` and inline code comments — worth formalizing into the planning docs before Epic 3's US-3.2/US-3.4 build on top of them.
- US-2.14's Jitsi embed is entirely unverified — no sandbox here has network access to `meet.jit.si` or a real `getUserMedia`.

## When these docs and the code disagree
The planning docs are the source of truth for intent, but if implementation reveals a real problem with the plan, update the relevant doc in the same change — don't let code and docs drift apart. This has already happened twice (once per epic — see `epic-1-report.md` §4 and `epic-2-report.md` §5) — don't let either list grow past what's tracked there without addressing it.