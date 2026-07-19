import * as esbuild from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

// The one place SERVER_BASE_URL is decided for a given build — swapped via
// env var at build time (`SERVER_BASE_URL=https://cowatch.app npm run build`),
// never hardcoded in logic files. Defaults to local dev.
const serverBaseURL = process.env.SERVER_BASE_URL ?? 'http://localhost:8080';

async function copyStatic() {
  await mkdir('dist/popup', { recursive: true });
  await cp('manifest.json', 'dist/manifest.json');
  await cp('src/popup/index.html', 'dist/popup/index.html');
  await cp('src/popup/popup.css', 'dist/popup/popup.css');
}

const buildOptions = {
  entryPoints: {
    'background/index': 'src/background/index.ts',
    'content/index': 'src/content/index.ts',
    'popup/index': 'src/popup/index.ts',
    'landing-bridge/index': 'src/landing-bridge/index.ts',
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife', // classic scripts — matches manifest's non-module background/content_scripts
  target: 'firefox115',
  sourcemap: true,
  logLevel: 'info',
  define: {
    // A custom global, not `process.env.*` — there is no real Node
    // `process` object in a browser/extension runtime, and pretending
    // there is one (via @types/node) would let src/ type-check against
    // Node-only APIs that don't actually exist here. __SERVER_BASE_URL__
    // is declared as an ambient string in src/shared/globals.d.ts so tsc
    // and esbuild agree on what it is.
    '__SERVER_BASE_URL__': JSON.stringify(serverBaseURL),
  },
};

async function run() {
  await copyStatic();
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log(`watching for changes (SERVER_BASE_URL=${serverBaseURL})...`);
  } else {
    await esbuild.build(buildOptions);
    console.log(`build complete (SERVER_BASE_URL=${serverBaseURL})`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
