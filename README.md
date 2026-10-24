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
SERVER_BASE_URL=https://localhost:8443 npm --prefix extension run build
```

Load a production build manually from Firefox:

1. Run `make build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on**.
4. Select `extension/dist/manifest.json`.

## Video chat: self-hosted Jitsi

The overlay embeds a Jitsi call. Development builds use a local Jitsi at
`localhost:8443` (see below). Public `meet.jit.si`, the fallback for release
builds without a configured domain, limits meetings embedded in other sites to
a short demo and requires the first participant to sign in as moderator (the
overlay shows Jitsi's sign-in screen for that). For real use, run your own Jitsi Meet
([docker-jitsi-meet](https://github.com/jitsi/docker-jitsi-meet)) on a public
HTTPS hostname and configure it to:

- allow anonymous rooms (`ENABLE_AUTH=0`, which is the default);
- disable the lobby and the pre-join page (the extension also asks the call
  to skip pre-join);
- allow being framed by other sites: do not send `X-Frame-Options` or a
  restrictive `frame-ancestors` CSP from its web server.

Then build the extension against it:

```sh
JITSI_DOMAIN=meet.example.com npm --prefix extension run build
```

The call starts with camera and microphone off. If Jitsi needs something from
the viewer (a moderator sign-in) or the call hasn't joined after 20 seconds,
for example because a site's own security policy blocks the embedded call,
the overlay leaves the Jitsi screen visible and offers **Open in Window**,
which opens the same room on the Jitsi server in its own window.

### Local Jitsi for development

A local [docker-jitsi-meet](https://github.com/jitsi/docker-jitsi-meet) is
enough to test the call with two Firefox profiles on one machine:

1. Download a release (for example `stable-11248-2`) and unpack it outside
   this repository. Copy `env.example` to `.env` and run `./gen-passwords.sh`.
2. In `.env`, set:

   ```sh
   CONFIG=C:/Users/you/.jitsi-meet-cfg   # an absolute path; ~ is not expanded on Windows
   PUBLIC_URL=https://localhost:8443
   JVB_ADVERTISE_IPS=127.0.0.1,YOUR_LAN_IP
   JVB_COLIBRI_PORT=8081                 # keep 8080 free for the CoWatch server
   ```

3. Create the `CONFIG` folders (`web`, `transcripts`, `prosody/config`,
   `prosody/prosody-plugins-custom`, `jicofo`, `jvb`, `jigasi`, `jibri`) and run
   `docker compose up -d`.
4. Open `https://localhost:8443` once in **each** Firefox profile and accept
   the self-signed certificate; until then the embedded call cannot load.

`make build` and `make dev` point at `localhost:8443` by default. To test
from another machine on your network, build with
`JITSI_DOMAIN=YOUR_LAN_IP:8443` instead, because `localhost` means each
viewer's own computer.

## Hosted Render deployment

The hosted server is available at
`https://cowatch-2uvm.onrender.com`. Configure its Render Web Service with:

- Root directory: `server`
- Dockerfile path: `./Dockerfile`
- Docker build context: `.`
- Health check path: `/healthz`
- `ADDR=:10000`
- `JOIN_BASE_URL=https://cowatch-2uvm.onrender.com`
- `TRUST_PROXY=true` (Render's proxy terminates connections; without it every
  user shares the proxy's address and its room-creation rate limit)

After deploying or changing an environment variable, verify the public health
endpoint:

```sh
curl -i https://cowatch-2uvm.onrender.com/healthz
```

`JOIN_BASE_URL` and the extension's compiled `SERVER_BASE_URL` must be the
same origin. Render terminates HTTPS, and the extension automatically uses
`wss://` for room WebSockets. The health response must include:

```text
X-CoWatch-Join-Base-URL: https://cowatch-2uvm.onrender.com
```

### Package a tagged Firefox release

Pushing a version tag matching `v*` runs the **Release Firefox extension**
GitHub Actions workflow. The workflow tests the extension, builds it for the
hosted Render origin, runs Firefox linting, and attaches the unsigned ZIP to
a GitHub prerelease. Generated ZIP files remain outside Git history.

The tag without its leading `v` must exactly match the `version` in both
`extension/manifest.json` and `extension/package.json`. For the current
`0.2.0` version:

```sh
git push origin master
git tag v0.2.0
git push origin v0.2.0
```

Before the first release, set the repository variable `JITSI_DOMAIN`
(**Settings → Secrets and variables → Actions → Variables**) to your
self-hosted Jitsi domain; without it the build falls back to `meet.jit.si`,
which only works as a short demo when embedded.

`0.2.0` changed the room protocol. Deploy the server and hand out the
matching extension together: a 0.1.x extension does not stay in sync with a
0.2.0 server.

When the workflow succeeds:

1. Open the repository's **Releases** page and select the matching prerelease.
2. Download the attached CoWatch ZIP.
3. In Firefox 140+, open `about:debugging#/runtime/this-firefox`.
4. Choose **Load Temporary Add-on** and select the downloaded ZIP.

The ZIP is unsigned, so Firefox removes the temporary installation when the
browser restarts. Release builds have debug logging off; build locally
with `COWATCH_DEBUG=1` to get `[CoWatch debug]` logs. Permanent
distribution requires Mozilla signing. If the
server origin changes, update `JOIN_BASE_URL` on the server and
`SERVER_BASE_URL` in `.github/workflows/package-extension.yml`, increment both
extension version fields, and push a new matching tag.

The extension canonicalizes returned and cached invite links against its
compiled `SERVER_BASE_URL`. This prevents a stale server hostname from being
copied, but Render's `JOIN_BASE_URL` must still be correct for every API
client and should be confirmed through `/healthz`.

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
docker pull kbabayev/cowatch-server:latest
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

1. Build a local package with the public IP compiled into the extension:

   ```sh
   SERVER_BASE_URL=http://PUBLIC_IP:8080 \
     JITSI_DOMAIN=meet.example.com \
     npm --prefix extension run package
   ```

2. Send the ZIP from `extension/artifacts/` to the other participant.
3. In Firefox 140+, open `about:debugging#/runtime/this-firefox`, choose
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

1. Open a page containing a video, including a player embedded in a
   cross-origin iframe, and choose the CoWatch toolbar button.
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
  re-detects candidates across accessible frames but cannot bypass site or
  browser restrictions.
- `meet.jit.si` is only the release fallback. Jitsi does not recommend the
  public instance as the backend for production applications.

## Manual release checklist

- Test open and host-only rooms in two clean Firefox profiles.
- Verify create, join, fresh-link, expired, unknown, missing-token, extension
  missing, and server/network-error landing states.
- Verify top-page and cross-origin iframe video detection, multiple-video
  selection, hidden-frame rejection, and return-to-auto.
- Verify play, pause, seek, drift correction, autoplay failure, and host
  departure.
- Verify fullscreen overlay movement and background session recovery.
- Verify Jitsi against the configured domain: join, mic/camera toggles showing
  their state, entering and leaving fullscreen without the call reloading,
  a forced failure showing Try Again / Open in Window.
- Verify page reload and next-episode navigation on both sides resume sync
  without user action, and that an idle joiner stays connected for several
  minutes (watch the background page in `about:debugging`).
- Verify a streaming site (YouTube) and a plain mp4 page, play/pause/seek from
  both host and joiner in an open room.
- Verify keyboard navigation, narrow screens, and reduced-motion preference.
- Run `make go-test-race`, `make verify`, and inspect the Firefox lint output.
- Review `PRIVACY.md`, the pinned Jitsi checksum, version number, and release
  notes before packaging.

Mozilla signing and AMO submission remain outside v1 completion.
