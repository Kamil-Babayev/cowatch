const DEFAULT_SERVER_BASE_URL = 'http://localhost:8080';
const DEFAULT_JITSI_DOMAIN = 'meet.jit.si';

export function normalizeServerBaseURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SERVER_BASE_URL must be an absolute http(s) URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('SERVER_BASE_URL must use http or https');
  }
  if (
    url.username
    || url.password
    || (url.pathname !== '' && url.pathname !== '/')
    || url.search
    || url.hash
  ) {
    throw new Error(
      'SERVER_BASE_URL must be an origin without credentials, path, query, or fragment',
    );
  }
  return url.origin;
}

export function landingMatchPattern(serverBaseURL) {
  const url = new URL(serverBaseURL);
  // Firefox match patterns cannot contain a port. Omitting it matches the
  // hostname on every port while the compiled API URL keeps the real port.
  return `${url.protocol}//${url.hostname}/join-page/*`;
}

export function loadBuildConfig(env = process.env) {
  const serverBaseURL = normalizeServerBaseURL(
    env.SERVER_BASE_URL ?? DEFAULT_SERVER_BASE_URL,
  );
  const jitsiDomain = env.JITSI_DOMAIN ?? DEFAULT_JITSI_DOMAIN;
  if (!/^[a-z0-9.-]+(?::\d+)?$/i.test(jitsiDomain)) {
    throw new Error('JITSI_DOMAIN must be a hostname with an optional port');
  }
  return {
    serverBaseURL,
    jitsiDomain,
    landingMatch: landingMatchPattern(serverBaseURL),
  };
}
