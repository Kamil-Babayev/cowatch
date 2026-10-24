# CoWatch server

The CoWatch server is an in-memory Go service that creates rooms, issues
short-lived join links, serves the landing page, and relays room WebSocket
messages.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADDR` | `:8080` | HTTP listen address |
| `JOIN_BASE_URL` | `http://localhost:8080` | Public absolute HTTP(S) origin used in generated links and origin validation |
| `TRUST_PROXY` | `false` | Rate-limit by the last `X-Forwarded-For` hop. Enable only behind a reverse proxy (Render, nginx); otherwise clients could spoof the header |

`JOIN_BASE_URL` is normalized by removing a trailing slash and must be an
HTTP(S) origin without credentials, path, query, or fragment. Tokens expire
after ten minutes. Room and token data is lost when the process restarts.

## Run and test

```sh
go run .
go test ./...
go test -race ./...
go test -coverprofile=coverage.out ./...
go tool cover -func=coverage.out
```

From the repository root, the equivalent Make targets are `go-run`,
`go-test`, `go-test-race`, and `go-test-cover`.

## HTTP API

The complete machine-readable contract is in [openapi.yaml](openapi.yaml).

- `GET /healthz` returns service health and exposes the configured public
  origin in `X-CoWatch-Join-Base-URL`.
- `POST /rooms` creates a room from `videoUrl` and `controlMode`.
- `GET /join/{token}` resolves a valid token, returning `410` for an expired
  token and `404` for an unknown token.
- `POST /rooms/{roomId}/tokens` issues a fresh join link and requires
  `Authorization: Bearer <hostToken>`.
- `GET /rooms/{roomId}` returns `{roomId,controlMode}` or `404`. Clients that
  keep failing to reconnect use it to tell a closed room from a network
  outage, because a browser WebSocket cannot see its upgrade's status code.
- `GET /join-page/` serves the embedded landing page.
- `GET /rooms/{roomId}/connect` upgrades to WebSocket. A host supplies
  `?hostToken=...`.

JSON request bodies are limited to 1 MiB, reject unknown fields and trailing
values, and HTTP errors use `{ "error": "..." }`.

## WebSocket protocol

Every frame is JSON:

```json
{"type":"playerCommand","payload":{"commandId":"…","action":"play","source":{…},"position":12.5},"timestamp":0}
```

Client timestamps are ignored; the server stamps Unix milliseconds. A
`source` is `{pageUrl,provider,mediaKey}`: `pageUrl` is the page's http(s)
URL; `provider` is `native` (a page `<video>`) or `obrut` (a PlayerJS iframe).
A native `mediaKey` is an opaque key of at most 2048 bytes that the extension
derives from the page. It is never a `blob:` or CDN URL, which differ between
browsers. An obrut `mediaKey` must be an http(s) URL on `obrut.show`.

| Type | Direction | Payload / behavior |
|---|---|---|
| `session` | server → client | `{connectionId,isHost,controlMode}` |
| `presence` | server → clients | `{connections:[{connId,isHost}]}` |
| `playerCommand` | client → server | `{commandId,action,source,position}`, where `action` is `play`, `pause`, `seek` or `replace` (host only). Last writer wins: it always applies and bumps the revision |
| `playerHeartbeat` | host → server | `{baseRevision,source,position,status}`. Applies only when `baseRevision` is current, and keeps the revision. A stale heartbeat is dropped silently, so it can never undo a newer command |
| `playerState` | server → clients | `{revision,source,position,status,commandId?,originConnectionId}`. Commands go to everyone, including the sender, who skips applying its own. Heartbeats go to everyone except the host |
| `stateRequest` | client → server | no payload |
| `stateResponse` | server → requester | `{revision,source,position,status}`; the timestamp is when that state was true. Nothing is sent before the room has a state |
| `clockPing` | client → server | `{t0}` |
| `clockPong` | server → requester | `{t0,serverTime}`; clients estimate their clock offset from the round trip |
| `controlDenied` | server → requester | host-only rejection reason |
| `leaveRoom` | client → server | explicit departure; a host leaving this way closes the room immediately |
| `roomClosed` | server → clients | `{reason:"host-left"|"server-shutdown"}` |

`status` is one of `playing`, `paused`, `buffering` or `ended`. Positions must
be finite and non-negative. Frames are capped at 64 KiB. The server sends
pings every 25 seconds, requires pong/read activity within 60 seconds, and
applies write deadlines.

## Lifecycle and security

Host authority is server-authored in the `session` frame after constant-time
host-token verification. In host-only rooms, joiner playback messages are
rejected and never update cached state. A host that disconnects without
`leaveRoom` has 30 seconds to reconnect before the room closes. When the host leaves, the server sends
`roomClosed` to all joiners, closes their sockets, and removes the room.
Graceful process shutdown uses `server-shutdown` and then stops HTTP within
five seconds.

Room creation is limited to five requests per source IP per minute. WebSocket
origin checks allow the configured join origin and extension origins. Deploy
behind TLS for non-local use and treat host tokens as bearer credentials.

## Docker

```sh
docker build --platform linux/amd64 -t cowatch-server -f server/Dockerfile server
docker run --rm --name cowatch -p 8080:8080 \
  -e ADDR=:8080 \
  -e JOIN_BASE_URL=http://PUBLIC_IP:8080 \
  cowatch-server
```

The image uses the Go version declared by the project, produces a stripped
CGO-free Linux binary, and runs as the distroless `nonroot` user. It contains
no room data or deployment URL; `JOIN_BASE_URL` is always supplied at runtime.

The repository's master-branch workflow publishes amd64 images to
`DOCKERHUB_USERNAME/cowatch-server` after all tests pass. Configure the GitHub
Actions variable `DOCKERHUB_USERNAME` and secret `DOCKERHUB_TOKEN`. Tags are
`latest` and `sha-<commit>`.

For the raw-IP early test, forward TCP 8080 only for the duration of the test
and use the same `http://PUBLIC_IP:8080` value when packaging the extension.
This traffic is unencrypted; use HTTPS/WSS for any continuing deployment.

## Troubleshooting

- **Origin rejected:** make the browser-visible origin match
  `JOIN_BASE_URL`, or connect from the packaged extension.
- **Join link expired:** ask the active host to use **Copy link** again.
- **Room closed:** the host left or the server shut down; create a new room.
- **Camera/microphone unavailable:** use HTTPS or localhost and verify the
  configured Jitsi deployment and Firefox permissions.
- **Autoplay blocked:** interact with the destination page, then retry play.
