// __SERVER_BASE_URL__ is replaced with a literal string at build time by
// build.mjs's esbuild `define` — see src/shared/globals.d.ts for its
// ambient type, and build.mjs for why it isn't `process.env.*`.
export const SERVER_BASE_URL =
  typeof __SERVER_BASE_URL__ === 'string'
    ? __SERVER_BASE_URL__
    : 'http://localhost:8080';
export const JITSI_DOMAIN =
  typeof __JITSI_DOMAIN__ === 'string' ? __JITSI_DOMAIN__ : 'meet.jit.si';
