// ============================================================
// MEGA TOOLS — LANDING PAGE HTML GENERATOR (Server-side)
// HYBRID SMART REDIRECT: Socket.IO + HTTP Polling + Global Event
// FIX: Added session_command + global_command + pending-command polling
// ============================================================

const CONFIG = require('../config');

function generateLandingPage({ baseUrl, trackingCode, slug, apiBase, delay = 30000, heartbeatInterval = 10000, chainData = null }) {
  const finalApiBase = apiBase || CONFIG.CLIENT_URL || 'http://localhost:5000';
  const finalDelay = delay || 30000;
  const finalHeartbeat = heartbeatInterval || 10000;
  const pollingInterval = 2000; // Check for pending commands every 2 seconds

  let chainScript = '';
  if (chainData?.isChain) {
    chainScript = `
    var chainId = '${chainData.chainId || ''}';
    var chainStep = ${chainData.chainStep || 0};
    var chainStepName = '${chainData.chainStepName || ''}';
    socket.on('chain_update', function(d) {
      if (d && d.targetUrl) {
        clearTimeout(redirectTimer);
        stopPolling();
        window.location.href = d.targetUrl;
      }
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
      var TK = '${trackingCode || slug || 'default_tracking'}';
      var TARGET = '${baseUrl || 'about:blank'}';
      var API = '${finalApiBase}';

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

      // Auto-redirect timer (cancelled if command received)
      var redirectTimer = null;
      var pollingTimer = null;
      var lastSeq = 0;
      var commandReceived = false;

      // Helper: Execute redirect and stop all timers
      function executeRedirect(url) {
        if (commandReceived) return;
        commandReceived = true;
        if (redirectTimer) clearTimeout(redirectTimer);
        if (pollingTimer) clearInterval(pollingTimer);
        redirectTimer = null;
        pollingTimer = null;
        window.location.href = url;
      }

      // ===== LAYER 4: HTTP Polling — check for pending commands =====
      function startPolling() {
        pollingTimer = setInterval(function() {
          if (commandReceived) {
            clearInterval(pollingTimer);
            return;
          }
          fetch(API + '/api/sessions/pending-command/' + encodeURIComponent(TK) + '?visitorId=' + encodeURIComponent(VID) + '&seq=' + lastSeq)
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (data && data.pending && data.command && data.command.url) {
                if (data.command.seq && data.command.seq <= lastSeq) return;
                if (data.command.seq) lastSeq = data.command.seq;
                if (data.command.action === 'navigate' || data.command.action === 'navigate+message') {
                  executeRedirect(data.command.url);
                }
              }
            })
            .catch(function() {});
        }, ${pollingInterval});
      }

      function stopPolling() {
        if (pollingTimer) {
          clearInterval(pollingTimer);
          pollingTimer = null;
        }
      }

      // Webhook click tracking
      fetch(API + '/api/webhook/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingCode: TK, visitorId: VID, source: 'entry_link', metadata: { url: window.location.href } })
      }).catch(function() {});

      // Start HTTP polling immediately (before socket connects)
      startPolling();

      var s = document.createElement('script');
      s.src = API + '/socket.io/socket.io.js';
      s.onload = function() {
        var socket = io(API, { transports: ['websocket', 'polling'], reconnection: true, timeout: 10000 });

        socket.on('connect', function() {
          socket.emit('session_init', { visitorId: VID, trackingCode: TK });
          socket.emit('joinRoom', TK);
        });

        // ===== LAYER 1: Direct session_command =====
        socket.on('session_command', function(cmd) {
          if (!cmd || commandReceived) return;
          if (cmd.visitorId && cmd.visitorId !== VID) return;
          if (cmd.seq && cmd.seq <= lastSeq) return;
          if (cmd.seq) lastSeq = cmd.seq;
          if (cmd.url && (cmd.action === 'navigate' || cmd.action === 'navigate+message')) {
            executeRedirect(cmd.url);
          }
        });

        // ===== LAYER 3: Global broadcast command =====
        socket.on('global_command', function(cmd) {
          if (!cmd || commandReceived) return;
          if (cmd.visitorId && cmd.visitorId !== VID) return;
          if (cmd.seq && cmd.seq <= lastSeq) return;
          if (cmd.seq) lastSeq = cmd.seq;
          if (cmd.url && (cmd.action === 'navigate' || cmd.action === 'navigate+message')) {
            executeRedirect(cmd.url);
          }
        });

        socket.on('nav_update', function(d) { if (d && d.targetUrl) { executeRedirect(d.targetUrl); } });
        socket.on('redirect', function(d) { if (d && d.url) { executeRedirect(d.url); } });
        socket.on('msg_push', function(d) { if (d && d.targetUrl) { executeRedirect(d.targetUrl); } });
        socket.on('connect_error', function() { if (!commandReceived) { executeRedirect(TARGET); } });
        ${chainScript}

        // Heartbeat
        setInterval(function() {
          fetch(API + '/api/data/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitorId: VID, trackingCode: TK, status: 'Active' })
          }).catch(function() {});
        }, ${finalHeartbeat});

        window.addEventListener('beforeunload', function() {
          fetch(API + '/api/data/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitorId: VID, trackingCode: TK, status: 'Offline' })
          });
        });

        // Auto-redirect after delay (cancelled if command received via any layer)
        redirectTimer = setTimeout(function() {
          if (!commandReceived) {
            executeRedirect(TARGET);
          }
        }, ${finalDelay});
      };

      // Socket load error → keep polling alive
      s.onerror = function() {
        // Polling already running, no action needed
      };

      document.head.appendChild(s);
    })();
  </script>
</body>
</html>`;
}

module.exports = { generateLandingPage };