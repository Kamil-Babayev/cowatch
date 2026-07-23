import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  landingMatchPattern,
  loadBuildConfig,
  normalizeServerBaseURL,
} from '../build-config.mjs';

test('public server URL retains its port while the Firefox match omits it', () => {
  const config = loadBuildConfig({
    SERVER_BASE_URL: 'http://203.0.113.10:8080/',
    JITSI_DOMAIN: 'meet.jit.si',
  });
  assert.equal(config.serverBaseURL, 'http://203.0.113.10:8080');
  assert.equal(config.landingMatch, 'http://203.0.113.10/join-page/*');
});

test('landingMatchPattern supports HTTPS hostnames', () => {
  assert.equal(
    landingMatchPattern('https://cowatch.example'),
    'https://cowatch.example/join-page/*',
  );
});

test('server URL validation rejects unsafe or ambiguous values', () => {
  for (const value of [
    '203.0.113.10:8080',
    'ftp://203.0.113.10',
    'http://user:secret@203.0.113.10',
    'http://203.0.113.10/base',
    'http://203.0.113.10?x=1',
    'http://203.0.113.10#fragment',
  ]) {
    assert.throws(() => normalizeServerBaseURL(value), /SERVER_BASE_URL/);
  }
});

test('Jitsi configuration accepts only a hostname and optional port', () => {
  assert.throws(
    () => loadBuildConfig({ JITSI_DOMAIN: 'https://meet.jit.si/path' }),
    /JITSI_DOMAIN/,
  );
});
