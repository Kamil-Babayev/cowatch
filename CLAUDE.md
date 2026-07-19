# CLAUDE.md

Context file for Claude Code (or any agentic coding session) working in this repo.

## What this project is
CoWatch (working title) — a Firefox extension that syncs video playback across any site with a `<video>` element, plus embedded video/voice chat via Jitsi. Full rationale, architecture, and UX flows live in the planning docs below — read them before writing code, don't re-derive the design from scratch.

## Current state
**Epic 1 (server) is functionally complete, but unverified.** Epic 2 (extension) and Epic 3 (UI) haven't been started. Four files exist so far:

- **`cowatch-project-plan.md`** — what we're building and why: architecture, core concepts (room vs. join link, control modes, the DRM/playback-state assumption everything rests on), and the four phases (sync logic → room lifecycle → video chat → UI).
- **`cowatch-implementation-sequence.md`** — how to build it: Epics → User Stories → Subtasks, strictly ordered Setup → Server → Extension → UI. Each story is scoped so the next one needs no new tooling, services, or architecture decisions — only code.
- **`epic-1-report.md`** — what actually got built in Epic 1, why, every bug found along the way, and the current tech-debt + doc-drift lists. **Read this before touching the server code** — it documents real deviations from the two docs above that haven't been back-ported yet (§4 of that report).

**Before writing any new server code:** `go build` / `go vet` / any test has never actually been run against this code — it was written and reasoned through, not compiled, in the environment it was built in. Verify it compiles before assuming any of it works.

## Working agreement for implementation
- **Follow the sequence in `cowatch-implementation-sequence.md` in order.** Don't jump ahead to a later story or epic even if it looks quick — the ordering is deliberate (see that file's Appendix A for why).
- Epic 1 (server) is meant to be fully working and testable via `curl`/a WebSocket client **before** any extension code is written — confirm it actually builds first, since that step is still outstanding.
- Epic 2 (extension) delivers working logic with bare/unstyled UI. Epic 3 re-skins it — don't add real styling early or rebuild logic late.
- If a story turns out to need something not yet decided (a new tool, a new service, a changed data shape), stop and flag it rather than quietly improvising — it likely means the sequence has a gap that should be fixed in `cowatch-implementation-sequence.md` first, the same way its own Appendix A documents earlier fixes.
- When code and a planning doc disagree (see `epic-1-report.md` §4 for the current known list), fix the doc in the same change you touch the related code — don't let the list grow further before it's reconciled.

## Tech stack (locked in, see US-0)
- Server: Go, `net/http`, `gorilla/websocket` — dependency not yet fetched/pinned, see `epic-1-report.md` tech debt #2.
- Extension: TypeScript, no framework, bundled with `esbuild`, Manifest V3, Firefox only for v1
- Video chat: Jitsi IFrame API against the public `meet.jit.si` instance

## Known gaps before continuing (see `epic-1-report.md` §3–4 for full detail)
- Server code has never been compiled or tested.
- `ws/handler.go` may still have a leftover, unused package-level `upgrader` var from before US-1.10's refactor — worth a direct look.
- Several small doc/code drifts exist (join-link outcomes, the `controlDenied` message type, `joinUrl`'s actual shape) — see the report's inconsistency table before extending the affected areas (US-1.3, US-1.9, US-2.9, US-3.4).

## When these docs and the code disagree
The planning docs are the source of truth for intent, but if implementation reveals a real problem with the plan, update the relevant doc in the same change — don't let code and docs drift apart. This already happened once in Epic 1 (see `epic-1-report.md` §4) — don't let the list grow past what's tracked there without addressing it.