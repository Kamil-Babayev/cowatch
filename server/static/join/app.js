// Plain JS, no build step — this is server-static content (served by the
// Go server's embed.FS, see US-1.5), not part of the extension's esbuild
// bundle, so it deliberately has no dependency on the extension's tooling.
(function () {
  var STATES = [
    'state-loading',
    'state-valid',
    'state-expired',
    'state-not-found',
    'state-no-extension',
    'state-error',
  ];

  function showState(id) {
    STATES.forEach(function (s) {
      document.getElementById(s).hidden = s !== id;
    });
  }

  function detectExtension(timeoutMs) {
    return new Promise(function (resolve) {
      var settled = false;
      function onDetected() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.removeEventListener('cowatch:extension-detected', onDetected);
        resolve(true);
      }
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        window.removeEventListener('cowatch:extension-detected', onDetected);
        resolve(false);
      }, timeoutMs);
      window.addEventListener('cowatch:extension-detected', onDetected);
      window.dispatchEvent(new CustomEvent('cowatch:extension-check'));
    });
  }

  async function resolveToken(token) {
    var res = await fetch('/join/' + encodeURIComponent(token));
    var body = {};
    try {
      body = await res.json();
    } catch (e) {
      // A malformed server response is handled as a retryable error below.
    }
    return { status: res.status, body: body };
  }

  async function main() {
    var token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      showState('state-not-found');
      return;
    }

    var resolveResult = await resolveToken(token);

    if (resolveResult.status === 200) {
      var roomId = resolveResult.body.roomId;
      var videoUrl = resolveResult.body.videoUrl;
      var destination;
      try {
        destination = new URL(videoUrl);
      } catch (e) {
        showState('state-error');
        return;
      }
      var hasExtension = await detectExtension(1000);
      if (!hasExtension) {
        showState('state-no-extension');
        return;
      }
      document.getElementById('destination-domain').textContent = destination.hostname;
      showState('state-valid');
      document.getElementById('continue-btn').addEventListener('click', function onContinue() {
        var button = document.getElementById('continue-btn');
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.textContent = 'Joining…';
        button.removeEventListener('click', onContinue);
        window.dispatchEvent(new CustomEvent('cowatch:join-requested', { detail: { roomId: roomId, videoUrl: videoUrl } }));
      });
      return;
    }

    if (resolveResult.status === 410) {
      showState('state-expired');
      return;
    }

    if (resolveResult.status === 404) {
      showState('state-not-found');
      return;
    }

    showState('state-error');
  }

  main().catch(function (err) {
    console.error('[CoWatch] landing page error:', err);
    showState('state-error');
  });

  document.getElementById('retry-btn').addEventListener('click', function () {
    showState('state-loading');
    main().catch(function () {
      showState('state-error');
    });
  });
})();
