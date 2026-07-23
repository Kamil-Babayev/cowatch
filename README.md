# CoWatch

CoWatch is a self-hosted Firefox extension and Go server for synchronized
video playback with an embedded Jitsi call. A host creates a short-lived join
link from any supported video page; participants open the link, continue to
the same page, and receive play, pause, seek, presence, and control updates.

## Architecture

- `server/` is an in-memory Go HTTP/WebSocket service. It creates rooms,
  resolves 10-minute join tokens, relays playback messages, and serves the
  join landing page.
- `extension/` is a Firefox Manifest V3 extension. Its background event page
  owns room sockets, content scripts detect and control video, and the popup
  creates or restores room sessions.
- Jitsi's pinned IFrame API wrapper is packaged with the extension. The
  meeting iframe itself is served by the configured remote Jitsi deployment.

Rooms and tokens are intentionally ephemeral: restarting the server removes
them. When the host disconnects, the server closes the room and notifies all
remaining participants.

## Prerequisites

- Go version declared in `server/go.mod`
- Node.js 22 and npm
- Firefox 140 or newer
- GNU Make (optional)
- Docker (optional)

Install extension dependencies with `make install`.

## Local development

Run the server:

```sh
make go-run
```

Build and launch the extension:

```sh
make dev
```

The defaults use `http://localhost:8080`. For realistic camera/microphone
testing, create a trusted localhost certificate with `mkcert`, terminate TLS
in a local reverse proxy, set `JOIN_BASE_URL` to that HTTPS origin, and build
the extension with matching configuration:

```sh
SERVER_BASE_URL=https://localhost:8443 JITSI_DOMAIN=meet.jit.si npm --prefix extension run build
```

Load a production build manually from Firefox:

1. Run `make build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**.
4. Select `extension/dist/manifest.json`.

## Build and test

```sh
make go-build
make go-test
make go-test-race
make go-test-cover
make typecheck
make test-coverage
make build
make lint
```

`make verify` runs the normal local extension and server checks. Pull requests
enforce at least 80% aggregate Go statement coverage and 80% aggregate
extension line coverage in independent jobs.

## End-to-end usage

1. Open a page containing a video and choose the CoWatch toolbar button.
2. Select open or host-only control and create a room.
3. Copy the generated link to a second Firefox profile.
4. Continue from the landing page to the destination video.
5. Use the overlay to view presence/control state, choose among multiple
   videos, copy a fresh link, retry Jitsi, or leave.

Open mode lets every participant control playback. Host-only mode immediately
re-synchronizes a joiner after a rejected local action. Join links expire
after ten minutes; the host can create a fresh link while the room is active.

## Privacy and limitations

See [PRIVACY.md](PRIVACY.md). CoWatch transmits destination URLs and playback
metadata to the configured CoWatch server, and audio/video to the configured
Jitsi service. It does not persist rooms server-side.

Known limitations:

- DRM players and Firefox-restricted pages may prevent video control.
- Autoplay policy can require a participant to interact with the page.
- Site-specific players may replace their `<video>` element; CoWatch
  re-detects candidates but cannot bypass site or browser restrictions.
- `meet.jit.si` is a development default. Jitsi does not recommend the public
  instance as the backend for production applications.

## Manual release checklist

- Test open and host-only rooms in two clean Firefox profiles.
- Verify create, join, fresh-link, expired, unknown, missing-token, extension
  missing, and server/network-error landing states.
- Verify multiple-video selection and return-to-auto.
- Verify play, pause, seek, drift correction, autoplay failure, and host
  departure.
- Verify fullscreen overlay movement and background session recovery.
- Verify Jitsi permissions, mic/camera controls, failure display, and retry.
- Verify keyboard navigation, narrow screens, and reduced-motion preference.
- Run `make go-test-race`, `make verify`, and inspect the Firefox lint output.
- Review `PRIVACY.md`, the pinned Jitsi checksum, version number, and release
  notes before packaging.

Production hosting and AMO submission are deliberately outside v1 completion.
