// __SERVER_BASE_URL__ is replaced with a literal string at build time by
// build.mjs's esbuild `define` — see src/shared/globals.d.ts for its
// ambient type, and build.mjs for why it isn't `process.env.*`.
export const SERVER_BASE_URL = __SERVER_BASE_URL__;
