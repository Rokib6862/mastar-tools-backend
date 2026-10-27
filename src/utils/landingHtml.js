// ============================================================
// MEGA TOOLS — LANDING PAGE HTML GENERATOR (Server-side) v5.0
// - Dynamic API base (no localhost fallback in production)
// - Single Session Pipeline — session_init only
// - FingerprintJS + localStorage hybrid (survives redirect)
// - Offline only on real unload (NOT on tab switch / visibility)
// - Auto-redirect cancelled on user interaction (form fill / submit)
// - Memory leak prevention (timer + socket cleanup)
// FIX-1: sessionStorage → localStorage for VID (survives navigation)
// FIX-2: visibilitychange no longer sends Offline (only real unload)
// FIX-3: autoRedirectTimer cancelled on user input / form submit
// FIX-4: pagehide only sends Offline when event.persisted === false
// ============================================================

const CONFIG = require('../config');

// Resolve API base for visitor landing pages
function resolveApiBase(req) {
  // 1. Explicit apiBase passed by caller (highest priority)
  // 2. Production: derive from request host (reverse proxy on same origin)
  // 3. Dev: fall back to CONFIG.CLIENT_URL or localhost:5000
  try {
    if (CONFIG.IS_PRODUCTION && req) {
      const host = req.get && req.get('host');
      if (host) {
        const proto = req.protocol || 'https';
        return `${proto}://${host}`;
      }
    }
  } catch {}
  return CONFIG.CLIENT_URL || 'http://localhost:5000';
}

function generateLandingPage({ baseUrl, trackingCode, slug, apiBase, delay = 15000, heartbeatInterval = 15000, chainData = null, req = null }) {
  const finalApiBase = (apiBase || resolveApiBase(req)).replace(/\/$/, '');
  const finalDelay = delay || 15000;
  const finalHeartbeat = heartbeatInterval || 15000;
  const pollingInterval = 2000;

  let chainScript = '';
  if (chainData?.isChain) {
    const safeChainId = String(chainData.chainId || '').replace(/'/g, "\\'");
    const safeChainStepName = String(chainData.chainStepName || '').replace(/'/g, "\\'");
    chainScript = `
    var chainId = '${safeChainId}';
    var chainStep = ${Number(chainData.chainStep) || 0};
    var chainStepName = '${safeChainStepName}';
    socket.on('chain_update', function(d) {
      if (d && d.targetUrl) {
        clearAllTimers();
        cleanupSocket();
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
  <title>Mega Tools — Redirecting...</title>
  <meta name="description" content="Mega Tools — Enterprise Visitor Management System">
  <meta property="og:title" content="Mega Tools — Enterprise Visitor Management">
  <meta property="og:description" content="Track, manage, and redirect your visitors in real-time with enterprise-grade inbox.">
  <meta property="og:image" content="https://res.cloudinary.com/shakilv875/image/upload/v1784334960/hjhjmh_bshbbh.png">
  <meta property="og:type" content="website">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Mega Tools — Enterprise Visitor Management">
  <meta name="twitter:description" content="Track, manage, and redirect your visitors in real-time.">
  <meta name="twitter:image" content="https://res.cloudinary.com/shakilv875/image/upload/v1784334960/hjhjmh_bshbbh.png">
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
      var TK = ${JSON.stringify(trackingCode || slug || 'default_tracking')};
      var TARGET = ${JSON.stringify(baseUrl || 'about:blank')};
      var API = ${JSON.stringify(finalApiBase)};
      var HEARTBEAT_INTERVAL = ${Number(finalHeartbeat) || 15000};
      var POLLING_INTERVAL = ${Number(pollingInterval) || 2000};
      var REDIRECT_DELAY = ${Number(finalDelay) || 15000};

      // FIX-1: use localStorage so VID survives navigation/redirect (sessionStorage is wiped)
      var VID = null;
      try { VID = localStorage.getItem('_mvid') || localStorage.getItem('_vid'); } catch(e) {}
      var redirectTimer = null;
      var autoRedirectTimer = null;
      var pollingTimer = null;
      var heartbeatTimer = null;
      var lastSeq = 0;
      var commandReceived = false;
      var socket = null;
      var isPageUnloading = false;
      var userInteracted = false;
      var offlineSent = false;

      function clearAllTimers() {
        if (redirectTimer) { clearTimeout(redirectTimer); redirectTimer = null; }
        if (autoRedirectTimer) { clearTimeout(autoRedirectTimer); autoRedirectTimer = null; }
        if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      }
      function stopPolling() { if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; } }
      function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

      function cleanupSocket() {
        if (socket) {
          try { socket.off(); socket.disconnect(); } catch(e) {}
          socket = null;
        }
      }

      function executeRedirect(url) {
        if (commandReceived) return;
        if (isPageUnloading) return;
        if (!url || url === 'about:blank') return;
        commandReceived = true;
        isPageUnloading = true;
        clearAllTimers();
        cleanupSocket();
        try {
          // Best-effort: mark offline before leaving (do NOT block redirect)
          var payload = JSON.stringify({ visitorId: VID, trackingCode: TK, status: 'Offline' });
          if (navigator.sendBeacon) navigator.sendBeacon(API + '/api/data/heartbeat', payload);
        } catch(e) {}
        window.location.href = url;
      }

      if (!VID) {
        try {
          var fp = await FingerprintJS.load();
          var result = await fp.get();
          VID = 'fp_' + result.visitorId;
        } catch(e) {
          VID = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        }
        try {
          localStorage.setItem('_mvid', VID);
          localStorage.setItem('_vid', VID);
        } catch(e) {}
      }

      function startPolling() {
        if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
        pollingTimer = setInterval(function() {
          if (commandReceived || isPageUnloading) { stopPolling(); return; }
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
        }, POLLING_INTERVAL);
      }

      function startHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        heartbeatTimer = setInterval(function() {
          if (isPageUnloading) { stopHeartbeat(); return; }
          fetch(API + '/api/data/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitorId: VID, trackingCode: TK, status: 'Active' })
          }).catch(function() {});
        }, HEARTBEAT_INTERVAL);
      }

      // FIX-2 & FIX-4: only send Offline on real unload (not tab-switch, not bfcache)
      function sendOffline(reason) {
        if (offlineSent) return;
        if (isPageUnloading && reason !== 'unload') return;
        offlineSent = true;
        var payload = JSON.stringify({ visitorId: VID, trackingCode: TK, status: 'Offline' });
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon(API + '/api/data/heartbeat', payload);
          } else {
            fetch(API + '/api/data/heartbeat', {
              method: 'POST', keepalive: true,
              headers: { 'Content-Type': 'application/json' },
              body: payload
            }).catch(function() {});
          }
        } catch(e) {}
      }

      // FIX-3: cancel auto-redirect as soon as the visitor interacts with the page
      function markInteraction() {
        if (userInteracted) return;
        userInteracted = true;
        if (autoRedirectTimer) { clearTimeout(autoRedirectTimer); autoRedirectTimer = null; }
      }
      ['click', 'keydown', 'touchstart', 'input', 'change', 'submit', 'focusin'].forEach(function(evt) {
        try { document.addEventListener(evt, markInteraction, { passive: true, once: false }); } catch(e) {}
      });

      startPolling();

      var s = document.createElement('script');
      s.src = API + '/socket.io/socket.io.js';
      s.onload = function() {
        socket = io(API, { transports: ['websocket', 'polling'], reconnection: true, timeout: 10000 });

        socket.on('connect', function() {
          socket.emit('session_init', { visitorId: VID, trackingCode: TK });
          socket.emit('joinRoom', TK);
          startHeartbeat();
        });

        socket.on('session_command', function(cmd) {
          if (!cmd || commandReceived || isPageUnloading) return;
          if (cmd.visitorId && cmd.visitorId !== VID) return;
          if (cmd.seq && cmd.seq <= lastSeq) return;
          if (cmd.seq) lastSeq = cmd.seq;
          if (cmd.url && (cmd.action === 'navigate' || cmd.action === 'navigate+message')) {
            executeRedirect(cmd.url);
          }
        });

        socket.on('global_command', function(cmd) {
          if (!cmd || commandReceived || isPageUnloading) return;
          if (cmd.visitorId && cmd.visitorId !== VID) return;
          if (cmd.seq && cmd.seq <= lastSeq) return;
          if (cmd.seq) lastSeq = cmd.seq;
          if (cmd.url && (cmd.action === 'navigate' || cmd.action === 'navigate+message')) {
            executeRedirect(cmd.url);
          }
        });

        socket.on('nav_update', function(d) { if (d && d.targetUrl) executeRedirect(d.targetUrl); });
        socket.on('redirect', function(d) { if (d && d.url) executeRedirect(d.url); });
        socket.on('msg_push', function(d) { if (d && d.targetUrl) executeRedirect(d.targetUrl); });
        socket.on('connect_error', function() {});
        socket.on('disconnect', function() {});
        ${chainScript}

        // FIX-3: auto-redirect ONLY if no interaction (user is not filling form)
        autoRedirectTimer = setTimeout(function() {
          if (commandReceived || isPageUnloading || userInteracted) return;
          executeRedirect(TARGET);
        }, REDIRECT_DELAY);
      };

      s.onerror = function() {
        startHeartbeat();
        // FIX-3: also honor userInteracted here
        autoRedirectTimer = setTimeout(function() {
          if (commandReceived || isPageUnloading || userInteracted) return;
          executeRedirect(TARGET);
        }, REDIRECT_DELAY);
      };

      document.head.appendChild(s);

      // Real unload only
      window.addEventListener('beforeunload', function() {
        sendOffline('unload');
        clearAllTimers();
        cleanupSocket();
      });

      // FIX-4: pagehide only when NOT persisted (bfcache restore should keep session alive)
      window.addEventListener('pagehide', function(ev) {
        if (ev && ev.persisted) return; // bfcache — do not go offline
        sendOffline('pagehide');
        clearAllTimers();
        cleanupSocket();
      });

      // FIX-2: do NOT send Offline on visibilitychange — visitor may come back
      document.addEventListener('visibilitychange', function() {
        if (!document.hidden && !isPageUnloading && !commandReceived) {
          // came back — ensure heartbeat running
          startHeartbeat();
        }
      });

      window.addEventListener('unload', function() {
        clearAllTimers();
        cleanupSocket();
      });
    })();
  </script>
</body>
</html>`;
}

module.exports = { generateLandingPage };