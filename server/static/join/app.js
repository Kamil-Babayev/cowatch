// Plain JS, no build step — this is server-static content (served by the
// Go server's embed.FS, see US-1.5), not part of the extension's esbuild
// bundle, so it deliberately has no dependency on the extension's tooling.
(function () {
  var STATES = ['state-loading', 'state-valid', 'state-expired', 'state-not-found', 'state-no-extension'];

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
    });
  }

  async function main() {
    var token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      showState('state-not-found');
      return;
    }

    var resolvePromise = fetch('/join/' + encodeURIComponent(token)).then(async function (res) {
      var body = {};
      try {
        body = await res.json();
      } catch (e) {
        // non-JSON error body — fall through with an empty body
      }
      return { status: res.status, body: body };
    });

    var results = await Promise.all([resolvePromise, detectExtension(400)]);
    var resolveResult = results[0];
    var hasExtension = results[1];

    // Extension is a hard requirement regardless of link validity — no
    // point showing "continue" for something that can't actually do
    // anything without the extension installed.
    if (!hasExtension) {
      showState('state-no-extension');
      return;
    }

    if (resolveResult.status === 200) {
      var roomId = resolveResult.body.roomId;
      var videoUrl = resolveResult.body.videoUrl;
      document.getElementById('destination-domain').textContent = new URL(videoUrl).hostname;
      showState('state-valid');
      document.getElementById('continue-btn').addEventListener('click', function () {
        window.dispatchEvent(new CustomEvent('cowatch:join-requested', { detail: { roomId: roomId, videoUrl: videoUrl } }));
      });
      return;
    }

    if (resolveResult.status === 410) {
      showState('state-expired');
      return;
    }

    showState('state-not-found');
  }

  main().catch(function (err) {
    console.error('[CoWatch] landing page error:', err);
    showState('state-not-found');
  });
})();
