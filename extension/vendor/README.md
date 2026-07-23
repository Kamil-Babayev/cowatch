# Vendored Jitsi IFrame API

`jitsi-external-api.js` is the official minified IFrame API wrapper retrieved
from `https://meet.jit.si/external_api.js` on 2026-07-23 and packaged locally
so the Firefox MV3 extension does not execute remote JavaScript.

- Upstream release tracked at retrieval: `2.0.11031`
- Upstream SHA-256: `829471e42ce216cdef5aa04dadd855a7a08b73c3aaf2119d3528628ede79343c`
- Upstream: https://github.com/jitsi/jitsi-meet
- License: Apache License 2.0 (see `JITSI-LICENSE.txt`)

The build copies this exact upstream file and replaces three unreachable
Node/global-discovery `Function` constructor fallbacks with browser-native
`globalThis`/`undefined`. These small deterministic substitutions make the
packaged MV3 script pass Firefox remote-code/CSP validation without changing
the IFrame API surface. The build fails if the pinned wrapper no longer has
the expected shape.

Updates must replace the file intentionally, record the new retrieval date and
checksum here, and rerun the complete Firefox/Jitsi manual verification.
