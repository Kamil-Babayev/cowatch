# CLAUDE.md

Context file for Claude Code (or any agentic coding session) working in this repo.

## What this project is
CoWatch (working title) — a Firefox extension that syncs video playback across any site with a `<video>` element, plus embedded video/voice chat via Jitsi. Full rationale, architecture, and UX flows live in the planning docs below — read them before writing code, don't re-derive the design from scratch.

## Current state
Planning only. No server, extension, or landing-page code exists yet. These two files are the entire repo so far:

- **`cowatch-project-plan.md`** — what we're building and why: architecture, core concepts (room vs. join link, control modes, the DRM/playback-state assumption everything rests on), and the four phases (sync logic → room lifecycle → video chat → UI).
- **`cowatch-implementation-sequence.md`** — how to build it: Epics → User Stories → Subtasks, strictly ordered Setup → Server → Extension → UI. Each story is scoped so the next one needs no new tooling, services, or architecture decisions — only code.

## Working agreement for implementation
- **Follow the sequence in `cowatch-implementation-sequence.md` in order.** Don't jump ahead to a later story or epic even if it looks quick — the ordering is deliberate (see that file's Appendix A for why).
- Start with **US-0** (repo structure, tech stack, local HTTPS, Makefile) before any feature code.
- Epic 1 (server) should be fully working and testable via `curl`/a WebSocket client **before** any extension code is written.
- Epic 2 (extension) delivers working logic with bare/unstyled UI. Epic 3 re-skins it — don't add real styling early or rebuild logic late.
- If a story turns out to need something not yet decided (a new tool, a new service, a changed data shape), stop and flag it rather than quietly improvising — it likely means the sequence has a gap that should be fixed in `cowatch-implementation-sequence.md` first, the same way its own Appendix A documents earlier fixes.

## Tech stack (locked in, see US-0)
- Server: Go, `net/http`, `gorilla/websocket`
- Extension: TypeScript, no framework, bundled with `esbuild`, Manifest V3, Firefox only for v1
- Video chat: Jitsi IFrame API against the public `meet.jit.si` instance

## When these docs and the code disagree
The planning docs are the source of truth for intent, but if implementation reveals a real problem with the plan, update the relevant doc in the same change — don't let code and docs drift apart.