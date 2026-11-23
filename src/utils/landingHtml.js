// ============================================================
// MEGA TOOLS — LANDING PAGE HTML GENERATOR (Server-side) v6.4
// ============================================================
// v5.0 baseline:
//   - Dynamic API base (no localhost fallback in production)
//   - Single Session Pipeline — session_init only
//   - FingerprintJS + localStorage hybrid (survives redirect)
//   - Offline only on real unload (NOT on tab switch / visibility)
//   - Auto-redirect cancelled on user interaction (form fill / submit)
//   - Memory leak prevention (timer + socket cleanup)
// FIX-1: sessionStorage → localStorage for VID (survives navigation)
// FIX-2: visibilitychange no longer sends Offline (only real unload)
// FIX-3: autoRedirectTimer cancelled on user input / form submit
// FIX-4: pagehide only sends Offline when event.persisted === false
//
// v6.1 (FIX-8) — REDIRECT DELIVERY PARITY WITH BACKUP:
//   - Monotonic seq accept (lastSeq=0 → accept)
//   - `msg_push` shows message then redirects
//   - poll + socket share the same gate
//
// v6.2 (FIX-8 continued) — additional parity + msg div
//
// v6.3 (FIX-9) — GLOBAL SID FALLBACK + OFFLINE-SAFE REDIRECT:
//   - persistSid() keeps `_msid_<SLUG>` AND global `_msid` in sync
//   - `_msid` global fallback also read when SLUG is present
//   - sendOffline() skipped when commandReceived === true
//
// v6.4 (FIX-10 — WINDOWS DEVICE CLASS):
//   1. The landing page now sends a normalized `deviceClass`
//      (`'Apple' | 'Android' | 'Windows' | 'Desktop' | 'Unknown'`)
//      on every `/api/data/visit` and `/api/data/heartbeat` POST.
//      This matches the server-side `detectDeviceClass` used by
//      FIX-D17 / FIX-S45 so the visitor's DB row carries a
//      first-class Windows class even when the request body is
//      trusted over the User-Agent header (reverse-proxy or
//      stripped UA edge cases).
//   2. `socket.emit('session_init')` also carries `deviceClass`
//      so server.js can store it immediately without re-parsing.
//   3. `deviceType` remains populated (Apple|Android|Windows|Desktop)
//      for backward-compat consumers — 'Unknown' becomes 'Desktop'.
//   4. No change to redirect, sid persistence, seq gating, auto-
//      redirect guard, offline logic, or polling cadence.
// ============================================================

const CONFIG = require('../config');

function resolveApiBase(req) {
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

function generateLandingPage({ baseUrl, trackingCode, slug, apiBase, delay = 15000, heartbeatInterval = 15000, chainData = null, req = null, sessionId = null }) {
  const finalApiBase = (apiBase || resolveApiBase(req)).replace(/\/$/, '');
  const finalDelay = delay || 15000;
  const finalHeartbeat = heartbeatInterval || 15000;
  const pollingInterval = 2000;
  const initialSessionId = sessionId || '';
  const baseCode = String(slug || '').trim();

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
    .msg { display: none; color: #e2e8f0; font-size: 14px; margin: 10px auto 6px; max-width: 420px; padding: 8px 12px; background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.35); border-radius: 8px; line-height: 1.4; }
    .msg.active { display: block; }
    .footer { position: fixed; bottom: 20px; left: 0; right: 0; text-align: center; color: #475569; font-size: 11px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@4/dist/fp.min.js"></script>
</head>
<body>
  <div style="text-align:center">
    <div class="spinner"></div>
    <div class="loading-text">Please wait...</div>
    <div class="msg" id="msg"></div>
    <div class="brand">Powered by Mega Tools</div>
  </div>
  <div class="footer">&copy; 2026 Mega Tools. All rights reserved.</div>
  <script>
    (async function() {
      var TK = ${JSON.stringify(trackingCode || slug || 'default_tracking')};
      var TARGET = ${JSON.stringify(baseUrl || 'about:blank')};
      var API = ${JSON.stringify(finalApiBase)};
      var SLUG = ${JSON.stringify(baseCode)};
      var HEARTBEAT_INTERVAL = ${Number(finalHeartbeat) || 15000};
      var POLLING_INTERVAL = ${Number(pollingInterval) || 2000};
      var REDIRECT_DELAY = ${Number(finalDelay) || 15000};
      var INITIAL_SID = ${JSON.stringify(initialSessionId)};

      var SID_STORAGE_KEY = SLUG ? ('_msid_' + SLUG) : '_msid';

      // FIX-9: keep per-link AND global _msid in sync.
      function persistSid(value) {
        if (!value) return;
        try { localStorage.setItem(SID_STORAGE_KEY, value); } catch(e) {}
        try { localStorage.setItem('_msid', value); } catch(e) {}
      }

      var SID = null;
      try {
        var _sq = new URLSearchParams(window.location.search).get('sid');
        if (_sq) SID = _sq;
      } catch(e) {}
      if (!SID && INITIAL_SID) SID = INITIAL_SID;
      if (!SID) {
        try { SID = localStorage.getItem(SID_STORAGE_KEY); } catch(e) {}
      }
      // FIX-9: also read global _msid when per-link miss (cross-link restore).
      if (!SID) {
        try { SID = localStorage.getItem('_msid'); } catch(e) {}
      }
      if (SID) {
        persistSid(SID);
      }

      var VID = null;
      try {
        var _vq = new URLSearchParams(window.location.search).get('vid');
        if (_vq) {
          VID = _vq;
          try { localStorage.setItem('_mvid', VID); localStorage.setItem('_vid', VID); } catch(e) {}
        } else {
          VID = localStorage.getItem('_mvid') || localStorage.getItem('_vid');
        }
      } catch(e) {}

      // FIX-10: normalize the visitor's device class once, reuse everywhere.
      function detectDeviceClass(ua) {
        var s = String(ua || '').toLowerCase();
        if (!s) return 'Unknown';
        if (s.indexOf('iphone') !== -1 || s.indexOf('ipad') !== -1 || s.indexOf('ipod') !== -1 ||
            s.indexOf('macintosh') !== -1 || s.indexOf('mac os x') !== -1 || s.indexOf('macos') !== -1) return 'Apple';
        if (s.indexOf('android') !== -1) return 'Android';
        if (s.indexOf('windows nt') !== -1 || s.indexOf('windows phone') !== -1 ||
            s.indexOf('win64') !== -1 || s.indexOf('win32') !== -1 || s.indexOf('windows') !== -1) return 'Windows';
        if (s.indexOf('linux') !== -1 || s.indexOf('cros') !== -1 || s.indexOf('x11') !== -1) return 'Desktop';
        return 'Unknown';
      }
      var DEVICE_CLASS = detectDeviceClass(navigator.userAgent || '');
      var DEVICE_TYPE = DEVICE_CLASS === 'Unknown' ? 'Desktop' : DEVICE_CLASS;

      var redirectTimer = null;
      var autoRedirectTimer = null;
      var pollingTimer = null;
      var heartbeatTimer = null;
      var lastSeq = 0;
      var commandReceived = false;
      var socket = null;
      var socketConnected = false;
      var pageLoadTs = Date.now();
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
          socketConnected = false;
        }
      }

      function isHttpUrl(u) {
        return typeof u === 'string' && /^https?:\\/\\//i.test(u);
      }

      function showMessage(text) {
        if (!text) return;
        try {
          var el = document.getElementById('msg');
          if (el) {
            el.textContent = String(text);
            el.classList.add('active');
          }
        } catch(e) {}
      }

      function executeRedirect(url) {
        if (commandReceived) return;
        if (!url || url === 'about:blank') return;
        if (!isHttpUrl(url)) return;
        commandReceived = true;
        clearAllTimers();
        cleanupSocket();
        window.location.href = url;
      }

      // FIX-8: monotonic seq accept — first command on page always
      // applied, subsequent commands require seq strictly greater than
      // lastSeq. Works for both Date.now() and commandSeq numerics.
      function shouldAcceptSeq(seq) {
        if (!seq) return true;
        if (lastSeq === 0) return true;
        return Number(seq) > Number(lastSeq);
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

      function payload(extra) {
        var p = {
          visitorId: VID,
          trackingCode: TK,
          // FIX-10: first-class deviceClass + backward-compat deviceType
          deviceClass: DEVICE_CLASS,
          device: DEVICE_TYPE,
        };
        if (SLUG) p.baseCode = SLUG;
        if (SID) p.sessionId = SID;
        if (extra) { for (var k in extra) p[k] = extra[k]; }
        return JSON.stringify(p);
      }

      function startPolling() {
        if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
        pollingTimer = setInterval(function() {
          if (commandReceived || isPageUnloading) { stopPolling(); return; }

          if (socketConnected && (Date.now() - pageLoadTs) < 90000) {
            return;
          }

          var url = API + '/api/sessions/pending-command/' + encodeURIComponent(TK) +
                    '?visitorId=' + encodeURIComponent(VID) +
                    '&seq=' + lastSeq +
                    (SID ? ('&sid=' + encodeURIComponent(SID)) : '');
          fetch(url)
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (data && data.pending && data.command && data.command.url) {
                if (!shouldAcceptSeq(data.command.seq)) return;
                if (data.command.seq) lastSeq = data.command.seq;
                if (data.command.sessionId && !SID) {
                  SID = data.command.sessionId;
                  persistSid(SID);
                }
                if (data.command.message) showMessage(data.command.message);
                if (data.command.action === 'navigate' ||
                    data.command.action === 'navigate+message' ||
                    isHttpUrl(data.command.url)) {
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
            body: payload({ status: 'Active' })
          }).catch(function() {});
        }, HEARTBEAT_INTERVAL);
      }

      function sendOffline(reason) {
        if (offlineSent) return;
        // FIX-9: skip Offline heartbeat when redirect is already
        // in progress — the new page will register its own visit.
        if (commandReceived) return;
        offlineSent = true;
        var p = payload({ status: 'Offline', reason: reason || 'unload' });
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon(API + '/api/data/heartbeat', p);
          } else {
            fetch(API + '/api/data/heartbeat', {
              method: 'POST', keepalive: true,
              headers: { 'Content-Type': 'application/json' },
              body: p
            }).catch(function() {});
          }
        } catch(e) {}
      }

      function markInteraction() {
        if (userInteracted) return;
        userInteracted = true;
        if (autoRedirectTimer) { clearTimeout(autoRedirectTimer); autoRedirectTimer = null; }
      }
      ['click', 'keydown', 'touchstart', 'input', 'change', 'submit', 'focusin'].forEach(function(evt) {
        try { document.addEventListener(evt, markInteraction, { passive: true, once: false }); } catch(e) {}
      });

      try {
        fetch(API + '/api/data/visit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload({
            collectedTypes: ['visit'],
            browser: navigator.userAgent.substring(0, 200),
            timestamp: new Date().toISOString()
          }),
          keepalive: true
        }).catch(function() {});
      } catch(e) {}

      startPolling();

      var s = document.createElement('script');
      s.src = API + '/socket.io/socket.io.js';
      s.onload = function() {
        socket = io(API, { transports: ['websocket', 'polling'], reconnection: true, timeout: 10000 });

        socket.on('connect', function() {
          socketConnected = true;
          var initPayload = {
            visitorId: VID,
            trackingCode: TK,
            // FIX-10: pass deviceClass on socket init so server.js can
            // store it immediately without re-parsing the UA.
            deviceClass: DEVICE_CLASS,
            deviceType: DEVICE_TYPE,
          };
          if (SLUG) initPayload.baseCode = SLUG;
          if (SID) initPayload.sessionId = SID;
          socket.emit('session_init', initPayload);
          socket.emit('joinRoom', TK);
          startHeartbeat();
        });

        socket.on('disconnect', function() { socketConnected = false; });
        socket.on('connect_error', function() { socketConnected = false; });

        socket.on('session_command', function(cmd) {
          if (!cmd || commandReceived || isPageUnloading) return;
          if (cmd.visitorId && cmd.visitorId !== VID) return;
          if (cmd.sessionId && SID && cmd.sessionId !== SID) return;
          if (!shouldAcceptSeq(cmd.seq)) return;
          if (cmd.seq) lastSeq = cmd.seq;
          if (cmd.sessionId && !SID) {
            SID = cmd.sessionId;
            persistSid(SID);
          }
          if (cmd.message) showMessage(cmd.message);
          if (cmd.url && (cmd.action === 'navigate' || cmd.action === 'navigate+message' || isHttpUrl(cmd.url))) {
            executeRedirect(cmd.url);
          }
        });

        socket.on('global_command', function(cmd) {
          if (!cmd || commandReceived || isPageUnloading) return;
          if (cmd.visitorId && cmd.visitorId !== VID) return;
          if (!shouldAcceptSeq(cmd.seq)) return;
          if (cmd.seq) lastSeq = cmd.seq;
          if (cmd.url && (cmd.action === 'navigate' || cmd.action === 'navigate+message' || isHttpUrl(cmd.url))) {
            executeRedirect(cmd.url);
          }
        });

        socket.on('nav_update', function(d) { if (d && d.targetUrl) executeRedirect(d.targetUrl); });
        socket.on('redirect', function(d) { if (d && d.url) executeRedirect(d.url); });

        socket.on('msg_push', function(d) {
          if (!d) return;
          if (d.message || d.text) showMessage(d.message || d.text);
          if (d.targetUrl && !commandReceived && !isPageUnloading) {
            executeRedirect(d.targetUrl);
          }
        });
        ${chainScript}

        if (isHttpUrl(TARGET)) {
          autoRedirectTimer = setTimeout(function() {
            if (commandReceived || isPageUnloading || userInteracted) return;
            executeRedirect(TARGET);
          }, REDIRECT_DELAY);
        }
      };

      s.onerror = function() {
        startHeartbeat();
        if (isHttpUrl(TARGET)) {
          autoRedirectTimer = setTimeout(function() {
            if (commandReceived || isPageUnloading || userInteracted) return;
            executeRedirect(TARGET);
          }, REDIRECT_DELAY);
        }
      };

      document.head.appendChild(s);

      window.addEventListener('beforeunload', function() {
        sendOffline('unload');
        clearAllTimers();
        cleanupSocket();
      });

      window.addEventListener('pagehide', function(ev) {
        if (ev && ev.persisted) return;
        sendOffline('pagehide');
        clearAllTimers();
        cleanupSocket();
      });

      document.addEventListener('visibilitychange', function() {
        if (!document.hidden && !isPageUnloading && !commandReceived) {
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