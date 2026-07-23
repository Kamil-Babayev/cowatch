import { readFile } from 'node:fs/promises';
import { loadBuildConfig } from './build-config.mjs';

const { serverBaseURL, landingMatch } = loadBuildConfig();
const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const landingBridge = manifest.content_scripts.find((entry) =>
  entry.js?.includes('landing-bridge/index.js'),
);
if (!landingBridge || landingBridge.matches.length !== 1) {
  throw new Error('built manifest must contain exactly one landing bridge match');
}
if (landingBridge.matches[0] !== landingMatch) {
  throw new Error(
    `built landing match ${landingBridge.matches[0]} does not match ${landingMatch}`,
  );
}

const backgroundBundle = await readFile('dist/background/index.js', 'utf8');
const popupBundle = await readFile('dist/popup/index.js', 'utf8');
if (
  !backgroundBundle.includes(serverBaseURL)
  || !popupBundle.includes(serverBaseURL)
) {
  throw new Error('built extension does not contain the configured server URL');
}

console.log(
  `verified build: server=${serverBaseURL}, landing match=${landingMatch}`,
);
