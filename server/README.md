# CoWatch server

The CoWatch server is an in-memory Go service that creates rooms, issues
short-lived join links, serves the landing page, and relays room WebSocket
messages.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ADDR` | `:8080` | HTTP listen address |
| `JOIN_BASE_URL` | `http://localhost:8080` | Public absolute HTTP(S) origin used in generated links and origin validation |

`JOIN_BASE_URL` is normalized by removing a trailing slash and must not contain
a query or fragment. Tokens expire after ten minutes. Room and token data is
lost when the process restarts.

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

- `GET /healthz` returns service health.
- `POST /rooms` creates a room from `videoUrl` and `controlMode`.
- `GET /join/{token}` resolves a valid token, returning `410` for an expired
  token and `404` for an unknown token.
- `POST /rooms/{roomId}/tokens` issues a fresh join link and requires
  `Authorization: Bearer <hostToken>`.
- `GET /join-page/` serves the embedded landing page.
- `GET /rooms/{roomId}/connect` upgrades to WebSocket. A host supplies
  `?hostToken=...`.

JSON request bodies are limited to 1 MiB, reject unknown fields and trailing
values, and HTTP errors use `{ "error": "..." }`.

## WebSocket protocol

Every frame is JSON:

```json
{"type":"play","payload":{"currentTime":12.5,"isPlaying":true},"timestamp":0}
```

Client timestamps are ignored for playback relays; the server stamps Unix
milliseconds. Supported messages:

| Type | Direction | Payload / behavior |
|---|---|---|
| `session` | server → client | `{connectionId,isHost,controlMode}` |
| `presence` | server → clients | `{connections:[{connId,isHost}]}` |
| `play`, `pause`, `seeked`, `timeSync` | client → server → peers | `{currentTime,isPlaying}` |
| `stateRequest` | client → server | no payload |
| `stateResponse` | server → requester | cached `{currentTime,isPlaying}` |
| `controlDenied` | server → requester | host-only rejection reason |
| `roomClosed` | server → clients | `{reason:"host-left"|"server-shutdown"}` |

Playback times must be finite and non-negative. Frames are capped at 64 KiB.
The server sends pings every 25 seconds, requires pong/read activity within 60
seconds, and applies write deadlines. Relays exclude the sender.

## Lifecycle and security

Host authority is server-authored in the `session` frame after constant-time
host-token verification. In host-only rooms, joiner playback messages are
rejected and never update cached state. When the host leaves, the server sends
`roomClosed` to all joiners, closes their sockets, and removes the room.
Graceful process shutdown uses `server-shutdown` and then stops HTTP within
five seconds.

Room creation is limited to five requests per source IP per minute. WebSocket
origin checks allow the configured join origin and extension origins. Deploy
behind TLS for non-local use and treat host tokens as bearer credentials.

## Docker

```sh
docker build -t cowatch-server -f server/Dockerfile server
docker run --rm -p 8080:8080 \
  -e ADDR=:8080 \
  -e JOIN_BASE_URL=https://cowatch.example \
  cowatch-server
```

## Troubleshooting

- **Origin rejected:** make the browser-visible origin match
  `JOIN_BASE_URL`, or connect from the packaged extension.
- **Join link expired:** ask the active host to use **Copy link** again.
- **Room closed:** the host left or the server shut down; create a new room.
- **Camera/microphone unavailable:** use HTTPS or localhost and verify the
  configured Jitsi deployment and Firefox permissions.
- **Autoplay blocked:** interact with the destination page, then retry play.
