import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadBuildConfig } from './build-config.mjs';

const watch = process.argv.includes('--watch');

// The one place SERVER_BASE_URL is decided for a given build — swapped via
// env var at build time (`SERVER_BASE_URL=https://cowatch.app npm run build`),
// never hardcoded in logic files. Defaults to local dev.
const { serverBaseURL, jitsiDomain, landingMatch } = loadBuildConfig();

async function copyStatic() {
  await mkdir('dist/popup', { recursive: true });
  await mkdir('dist/vendor', { recursive: true });
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
  const landingBridge = manifest.content_scripts.find((entry) =>
    entry.js?.includes('landing-bridge/index.js'),
  );
  if (!landingBridge) {
    throw new Error('manifest is missing the landing bridge content script');
  }
  landingBridge.matches = [landingMatch];
  await writeFile(
    'dist/manifest.json',
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await cp('src/popup/index.html', 'dist/popup/index.html');
  await cp('src/popup/popup.css', 'dist/popup/popup.css');
  const jitsiSource = await readFile('vendor/jitsi-external-api.js', 'utf8');
  const replacements = [
    ['new Function("return this")()', 'globalThis'],
    ['Function("return this")()', 'globalThis'],
    [`Function('return require("'+t+'")')()`, 'undefined'],
  ];
  let jitsiFirefox = jitsiSource;
  for (const [unsafe, safe] of replacements) {
    const matches = jitsiFirefox.split(unsafe).length - 1;
    if (matches !== 1) {
      throw new Error(`unexpected Jitsi wrapper shape for Firefox-safe replacement: ${unsafe}`);
    }
    jitsiFirefox = jitsiFirefox.replace(unsafe, safe);
  }
  await writeFile('dist/vendor/jitsi-external-api.js', jitsiFirefox);
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
  target: 'firefox140',
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
    '__JITSI_DOMAIN__': JSON.stringify(jitsiDomain),
  },
  loader: {
    // US-3.2: the in-page overlay lives in a shadow root, which manifest
    // content_scripts.css can't reach (shadow DOM blocks page-level
    // stylesheets same as it blocks the host site's own CSS). Importing
    // CSS as a raw string and injecting it as an inline <style> inside
    // the shadow root sidesteps that entirely — no web_accessible_resources
    // needed either, unlike a <link> to a packaged CSS file would.
    '.css': 'text',
  },
};

async function run() {
  await copyStatic();
  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log(
      `watching for changes (SERVER_BASE_URL=${serverBaseURL}, landing match=${landingMatch})...`,
    );
  } else {
    await esbuild.build(buildOptions);
    console.log(
      `build complete (SERVER_BASE_URL=${serverBaseURL}, landing match=${landingMatch}, JITSI_DOMAIN=${jitsiDomain})`,
    );
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
