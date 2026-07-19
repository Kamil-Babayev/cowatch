# Epic 1 — Server Logic: Implementation Report

Covers all of Epic 1 (US-1.1 – US-1.10), now complete. Written from the actual build conversation, in the order things were built, including the mid-course additions to US-1.8/1.9 and the bugs found along the way.

**Compile/verification status: still unverified.** Go isn't installed in the sandbox this was built in, so nothing here has been run through `go build`, `go vet`, or a test suite. Treat everything below as "written and reasoned through," not "confirmed working" — still the single most important caveat on this whole document.

---

## 1. What was built, and why

### `internal/idgen` — ID and token generation
`crypto/rand` + `base64.RawURLEncoding`, not `google/uuid` — a UUID v4 only has 122 bits of real entropy (6 bits fixed by version/variant) and a dashed format nobody needs here, since `joinToken`/`hostToken` are bearer credentials, not identifiers. Sized by role:
- `RoomID()` — 16 bytes (128 bits), an identifier, not a secret.
- `JoinToken()` — 24 bytes (192 bits), short-lived but travels in a shared URL.
- `HostToken()` — 32 bytes (256 bits), the longest-lived bearer credential.

`RoomID` confirmed never user-facing — users only ever see a link, never a raw ID — so no shorter/typeable format was built.

### `internal/store` — `RoomStore` and `TokenStore`
Two stores, not one: rooms live until presence tracking says everyone's left; tokens always expire in 10 minutes regardless. Three real bugs caught in the first draft, before anything else was built on top:
- **`defer s.mu.Unlock()` inside a `for { select {} }` loop** — defer only fires on function return, not per-iteration, so the mutex stayed locked forever after the first cleanup tick. Fixed to an explicit `Unlock()`.
- **Deleting by the wrong key** — `delete(s.tokens, token.RoomID)` used a struct field instead of the actual map key. Fixed to iterate `key, rec` and delete by `key`.
- **`RoomStore`'s cleanup would've deleted every room almost immediately** — keyed off an `IsActive` bool nothing ever set (Go zero-values it `false`), and "is this room active" isn't knowable by `RoomStore` alone anyway. Fixed by dropping the cleanup goroutine entirely; rooms are deleted later via `Hub.OnRoomEmpty`, an event, not a timer.

`TokenStore.Resolve` returns a typed error (`ErrTokenNotFound` / `ErrTokenExpired`) since US-1.3 needs to distinguish them; `RoomStore.Get` stays `(*Room, bool)` since rooms have no "expired" state to distinguish from "not found."

Extended in US-1.8 with a real `PlaybackState` (`CurrentTime`, `IsPlaying`, `UpdatedAt`) and two methods, `UpdatePlaybackState` and `PlaybackState`, both behind the existing mutex.

### `internal/config` — env-var based config
YAML/JSON considered and rejected for two values — more machinery than needed, and YAML specifically pulls in a non-stdlib dependency for no real gain. Env vars also map directly onto `docker-compose`'s `environment:` block for whenever deployment happens. Centralized into one `config.Load()`.

### Handlers — health, room creation, join resolution, fresh-link minting
- **`GET /healthz`** (US-1.1) — trivial `200`.
- **`POST /rooms`** (US-1.2) — validation pulled forward from US-1.10 deliberately (non-empty `videoUrl`, `controlMode` enum), later replaced with real URL-format validation once US-1.10 arrived (see below).
- **`GET /join/{token}`** (US-1.3) — a fourth case surfaced mid-build beyond the planned three (valid/expired/unknown): a token that's real and unexpired but whose room was already deleted. **Decided to collapse it into "expired"** rather than expose a distinct state — one failure message for the joiner, not two near-identical ones. This is a real, still-unresolved deviation from `cowatch-project-plan.md` §5.2 and the implementation sequence's US-1.3 description (see §4 below).
- **`POST /rooms/{roomId}/tokens`** (US-1.4) — authenticated via `Authorization: Bearer <hostToken>`, checked with `crypto/subtle.ConstantTimeCompare` rather than `==`, since a plain comparison on a bearer credential is a real timing-attack surface. Reused later as a query-param variant (`validHostTokenQuery`) for the WebSocket handshake, since a browser's WS upgrade can't set a custom header.

### Static landing page (US-1.5)
Served via `//go:embed`, compiled into the binary — no `static/` directory to bind-mount once this runs in Docker. Placeholder content only, per spec.

### WebSocket message schema (`internal/ws/message.go`)
One envelope (`{type, payload, timestamp}`), decided before the hub. `Timestamp` is always server-stamped on relay (client clock skew would otherwise corrupt drift correction before Epic 2 gets to build it); `stateResponse` is unicast, everything else broadcast, so `Hub.sendTo` was built in from the start rather than retrofitted.

Extended twice after the initial design:
- **US-1.8**: `PlaybackPayload` gained an `IsPlaying` field — `seeked` alone doesn't tell you whether playback was running before the seek, and the cache needs to know.
- **US-1.9**: `MsgControlDenied` + `ControlDeniedPayload` added, unicast like `stateResponse`, after deciding a blocked host-only action should get explicit feedback rather than a silent drop.

### Hub, connection handler, read/write loops (US-1.6 → US-1.9)
`Hub` tracks `map[roomID]map[*client]struct{}` behind a mutex; `join`/`leave` broadcast `presence` including each connection's `isHost` flag; `broadcast` took an `exclude *client` parameter from the start — used initially just to stop a message echoing to its own sender, later doubling as part of US-1.9's filtering path.

A real bug fixed here: `broadcastPresence` originally called an undefined `connID(c)`. Fixed by giving `client` its own `id` field, set once at connect via `idgen.New(8)`.

`readLoop`'s dispatch grew across three stories, all in the same switch statement:
- **US-1.7** (built as a byproduct of US-1.6's read loop, ahead of its own turn): `play`/`pause`/`seeked`/`timeSync` broadcast verbatim, server-stamped timestamp, sender excluded.
- **US-1.8**: `stateRequest` now answers from `RoomStore.PlaybackState` instead of a no-op; every playback message now also calls `UpdatePlaybackState` before relaying. `client` gained a `rooms *store.RoomStore` field to make this possible.
- **US-1.9**: a guard clause ahead of the update-and-relay logic — if `room.ControlMode == host-only` and the sender isn't host, send `MsgControlDenied` back to them instead (no cache update, no relay).

`Hub.OnRoomEmpty` remains the mechanism behind "rooms have no TTL," wired in `main.go` as `hub.OnRoomEmpty = rooms.Delete`.

### US-1.10 — validation & hardening
Four pieces, closing out Epic 1:
- **`internal/api/validate.go`** — `isValidVideoURL` (real `http(s)` + non-empty host check via `net/url`), replacing the bare non-empty check from US-1.2.
- **`internal/api/ratelimit.go`** — naive per-IP fixed-window limiter (5 rooms/IP/minute), applied only to `POST /rooms`. Self-acknowledged limitation: `requests` never evicts IPs that stop sending traffic — unbounded memory growth under sustained unique-IP load, acceptable for now per the story's own "naive" scoping.
- **`internal/api/middleware.go`** — `RecoverMiddleware`, wrapping the whole mux once at the top rather than per-handler, turning any panic into a `500` instead of crashing the process.
- **`internal/api/origin.go`** — replaces the wide-open `CheckOrigin` on the WS upgrader. Firefox extension origins (`moz-extension://<uuid>`) have a per-*profile* random UUID, not a fixed one tied to the extension's identity, so exact-match whitelisting can't work — the actual achievable check is scheme-based (`moz-extension` allowed, otherwise must match `cfg.JoinBaseURL`; empty `Origin` allowed through for non-browser tooling like `curl`).

While in `rooms_handler.go` anyway, also fixed a previously-flagged inconsistency: `handleCreateRoom` now uses the shared `writeJSON` helper instead of its own manual `Header/WriteHeader/Encode` sequence, matching every other handler.

### Bugs found after the fact
- **`hub` undefined in `main.go`.** A run of incremental diffs (adding recovery middleware, then the origin checker) never re-showed the full file, so `hub`'s own declaration from several messages earlier got dropped from what was visibly in scope. Fixed by re-posting the complete `main.go`.
- **`internal/api/origin.go` referenced `config.Config` without importing `config` at all** — introduced in the same message as the `hub` bug, same root cause (a fragment shown without re-verifying its own imports).
- **`joinUrl` pointed at the wrong endpoint.** Both `POST /rooms` and `POST /rooms/{roomId}/tokens` built `joinUrl` as `{BaseURL}/join/{token}` — the JSON resolve endpoint from US-1.3 — instead of `{BaseURL}/join-page/?token={token}`, the actual landing page. As built, clicking a real invite link would have shown raw JSON in a browser instead of a page. Found during this review pass, fixed in both handlers.

---

## 2. Status against `cowatch-implementation-sequence.md`

| Story | Status | Note |
|---|---|---|
| US-1.1 Health check | **Done** | — |
| US-1.2 Room creation | **Done** | `joinUrl` bug (found this pass) now fixed |
| US-1.3 Join-token resolution | **Done** | Behavior deviates from the docs — see §4 |
| US-1.4 Fresh-link minting | **Done** | Same `joinUrl` bug, same fix |
| US-1.5 Static landing-page route | **Done** | Placeholder content, as specified |
| US-1.6 WebSocket hub + presence | **Done** | — |
| US-1.7 Playback relay | **Done** | Built inside US-1.6's read loop, ahead of its own turn |
| US-1.8 Last-known-state cache | **Done** | Required a schema change (`IsPlaying` field) |
| US-1.9 Host-only control enforcement | **Done** | Grew beyond spec — added `controlDenied`, see §4 |
| US-1.10 Validation & hardening | **Done** | — |

**Epic 1 is functionally complete** — all ten stories done, modulo the unverified-compile caveat and the items below.

---

## 3. Tech debt

1. **Nothing has been compiled or run, still.** Go isn't installed in this sandbox — `go build`, `go vet`, and any test run remain outstanding. First thing to do before trusting anything else on this list.
2. **`go.mod`/`go.sum` never generated** for `gorilla/websocket` — same root cause as #1; the module's actual resolution has never been confirmed.
3. **No automated tests anywhere.** `make test` (US-0) has nothing to run — not even for `store`, which had three real bugs during development that tests would have caught mechanically instead of by inspection.
4. **`rateLimiter.requests` never evicts stale IPs** — unbounded memory growth under sustained unique-IP traffic. Self-flagged as "naive" in scope; a real problem only at real scale.
5. **`ws/handler.go`'s full body was never re-shown after the US-1.10 signature change** (adding the `checkOrigin` parameter and a locally-scoped `upgrader`). The old package-level `var upgrader` from US-1.6 was never explicitly confirmed deleted — same class of risk as the `hub`/`origin.go` bugs above, just not yet confirmed one way or the other. Worth a direct look at the actual file before moving on.
6. **Graceful shutdown's effect on active WebSocket connections is unverified.** `http.Server.Shutdown()` is built for ordinary handlers; WS connections are long-lived hijacked connections, and whether they close cleanly or hang on shutdown hasn't been tested.
7. **`PlaybackState`'s truthfulness depends entirely on client self-reporting.** No plausibility checks exist (e.g. `currentTime` moving backward faster than real time, or `isPlaying: true` from a connection about to disconnect). Flagged as US-1.9/1.10-adjacent at the time, not fixed.
8. **A `controlDenied` client currently has no server-side rate limit of its own** — a misbehaving/malicious client could hammer `play`/`pause` in a host-only room and get a `controlDenied` reply for each one, which is itself a small amount of free work for an attacker to trigger repeatedly. Not addressed; likely fine at hackathon scale, worth a note for later.

**Checked and confirmed not an issue:** CORS. The landing page is served from the same origin as the API by design (US-1.5); extension background/popup contexts aren't subject to page-level CORS the way an ordinary webpage's script is.

---

## 4. Inconsistencies with `cowatch-project-plan.md` and `cowatch-implementation-sequence.md`

None of these break anything today — they're places where the code has moved past what the docs still say, which is exactly the kind of drift that gets confusing later if left alone.

| # | Doc | Section | What it still says | What's actually true now |
|---|---|---|---|---|
| A | `cowatch-project-plan.md` | §5.2 | Implies three join-link outcomes: valid / expired / unknown | A fourth case (token valid, room already gone) is deliberately collapsed into "expired" |
| B | `cowatch-implementation-sequence.md` | US-1.3 | Same three-outcome description | Same collapse as above |
| C | `cowatch-project-plan.md` | §3.4 (sync message types table) | Lists 5 message types | `controlDenied` (added in US-1.9) is missing from the table |
| D | `cowatch-project-plan.md` | §3.2 (control model) | Doesn't say what a blocked action gets back | Blocked actions now receive an explicit `controlDenied` message, not silence |
| E | `cowatch-implementation-sequence.md` | US-1.9 | Acceptance criteria describe only a silent guard clause | An explicit rejection message was added on top |
| F | `cowatch-implementation-sequence.md` | US-3.4 | Only describes rendering the "who has control" indicator | Was agreed to also grow into: disabling controls client-side for non-hosts, and handling `controlDenied` as a fallback/toast |
| G | Both docs | US-1.2 / US-1.5 / §5.1 | Never states what shape `joinUrl` actually takes | Should say explicitly: `joinUrl` points at the landing page (`/join-page/?token=...`), not the JSON resolve endpoint — the ambiguity here is arguably what let the `joinUrl` bug go unnoticed as long as it did |

Recommend a small doc-sync pass (rows A/B/C/D/E/F/G) before starting Epic 2, since US-2.9 and US-3.4 specifically build on top of the very things that drifted.