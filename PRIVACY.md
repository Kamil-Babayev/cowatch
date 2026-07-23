# CoWatch Privacy

CoWatch does not include analytics or advertising. It does transmit data that
is required to provide room synchronization and video chat.

## Data sent to the CoWatch server

- The full destination video URL when a room is created.
- Playback position and playing/paused state while a room is active.
- Random room, join, host, and connection identifiers.
- The connecting IP address as observed by the server. It is used for the
  room-creation rate limit and normal network operation.

Rooms, tokens, and playback state are held in server memory. They are not
written to a database. Join links expire after ten minutes. A room is removed
when its host leaves, its last participant disconnects, or the server shuts
down. Server operators may still retain ordinary infrastructure or process
logs according to their own policy.

## Data sent to Jitsi

Audio, video, display capture, meeting identifiers, and related connection
metadata are sent directly to the Jitsi domain configured at extension build
time. They are not routed through the CoWatch server. The Jitsi operator's
privacy and retention practices apply.

`meet.jit.si` is only the development default and is not recommended by Jitsi
as a production application backend. A production operator should configure a
suitable Jitsi deployment and publish its privacy terms.

## Browser permissions

The extension requests access to visited pages so it can detect video elements
and synchronize playback. It also uses tab, session-storage, and clipboard
permissions for room handoff, recovery, and copying invitation links. Firefox
declares the required `websiteActivity` and `personalCommunications`
transmission categories.

CoWatch cannot read or control videos on Firefox-restricted pages and does not
attempt to bypass DRM, browser security boundaries, or site access controls.
