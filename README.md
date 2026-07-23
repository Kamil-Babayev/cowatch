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

## Public-IP early test

This is a temporary two-person test setup, not a production deployment.
Using raw HTTP exposes destination URLs, room credentials, and playback
metadata to the networks between each browser and the server. Close the
forwarded port when the test is over.

### 1. Prepare Docker Hub and GitHub

1. Create a public Docker Hub repository named `cowatch-server`.
2. Create a Docker Hub access token with permission to push that repository.
   Do not use your Docker Hub account password.
3. In the GitHub repository, add the Actions variable
   `DOCKERHUB_USERNAME`.
4. Add the Actions secret `DOCKERHUB_TOKEN`.
5. Push to `master`. After both server and extension checks pass, the workflow
   publishes:
   - `DOCKERHUB_USERNAME/cowatch-server:latest`
   - `DOCKERHUB_USERNAME/cowatch-server:sha-<commit>`

The SHA tag provides a rollback target. Publishing an image does not restart
the computer hosting CoWatch.

### 2. Confirm the connection can be forwarded

Compare the router's WAN IPv4 address with the public IPv4 reported by an
external IP-check service. Direct forwarding will not work if the WAN address
is private (`10/8`, `172.16/12`, `192.168/16`) or in the carrier-grade NAT
range `100.64/10`; in that case, ask the ISP for a public IPv4 or use a VPN
overlay instead.

Reserve the Docker host's LAN address, allow inbound TCP 8080 in its firewall,
and forward router TCP 8080 to that host's TCP 8080.

### 3. Run the server

Replace `USERNAME` and `PUBLIC_IP`:

```sh
docker pull USERNAME/cowatch-server:latest
docker run -d \
  --name cowatch \
  --restart unless-stopped \
  -p 8080:8080 \
  -e ADDR=:8080 \
  -e JOIN_BASE_URL=http://PUBLIC_IP:8080 \
  USERNAME/cowatch-server:latest
```

Verify the non-root runtime and health:

```sh
docker inspect --format '{{.Config.User}}' cowatch
curl http://PUBLIC_IP:8080/healthz
```

Test the health URL from another network, such as a phone with Wi-Fi disabled.
Testing only from inside the home network can give a false negative on routers
without NAT loopback.

### 4. Package and install the extension

1. Open GitHub **Actions** → **Package early-test extension**.
2. Choose **Run workflow**.
3. Enter exactly `http://PUBLIC_IP:8080` for `server_base_url`.
4. Keep `meet.jit.si` as `jitsi_domain`.
5. Download the `cowatch-firefox-*` artifact when the workflow completes.
6. Extract GitHub's outer artifact archive and send the inner CoWatch ZIP to
   the other participant.
7. In Firefox 140+, open `about:debugging#/runtime/this-firefox`, choose
   **Load Temporary Add-on**, and select the CoWatch ZIP.

The unsigned extension is removed when Firefox restarts and must then be
loaded again through `about:debugging`. A changed public IP requires both a
new container `JOIN_BASE_URL` and a newly packaged extension using that URL.

### 5. Verify and shut down

Test open and host-only rooms, play/pause/seek, fresh links, multiple-video
selection, Jitsi permissions, and host departure. Then remove the service and
close both firewall and router rules:

```sh
docker rm -f cowatch
```

For continued use, move to a stable hostname with HTTPS/WSS instead of leaving
this HTTP endpoint open.

## Build and test

```sh
make go-build
make go-test
make go-test-race
make go-test-cover
make typecheck
make test-coverage
make build
make package
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
