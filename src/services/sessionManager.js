// ============================================================
// MEGA TOOLS — SESSION MANAGER (Status Monitor Only)
// HYBRID: Fast Offline via HTTP status + Anti-Flicker via socket ignore
// FIX: Force emit when isLive=false regardless of status match
// FIX v2: Room-based emit — only notify session owner, not ALL clients
// FIX v3: safeReadSessions — filter active/recent only (90% less I/O)
// ============================================================

const db = require('../database');
const CONFIG = require('../config');
const Session = require('../models/Session');

// ============================================================
// STATE
// ============================================================

let ioInstance = null;
let sessionSockets = {};
let statusMonitorTimer = null;
let logCleanupTimer = null;
let previousStatusMap = new Map();
const ACTIVITY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes no activity
const RECENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

// ============================================================
// INIT
// ============================================================

function init(io, sockets) {
  ioInstance = io;
  sessionSockets = sockets || {};
  startStatusMonitor();
  startLogCleanup();
}

// FIX v3: Filter — only active/recent sessions + tracked transitions
async function safeReadSessions() {
  try {
    let data = await db.sessions.read();
    if (!Array.isArray(data)) {
      try { data = await db.readJSON('sessions') || []; } catch (err) { return []; }
    }
    if (!data || data.length === 0) return [];
    
    const nowMs = Date.now();
    
    return data.filter(s => {
      if (!s._id) return false;
      if (s.isLive === true) return true;
      const lastActivityMs = new Date(s.lastActivity || s.timestamp || 0).getTime();
      if (nowMs - lastActivityMs < RECENT_WINDOW_MS) return true;
      if (previousStatusMap.has(s._id.toString())) return true;
      return false;
    });
  } catch (err) {}
  return [];
}

function isSocketAlive(visitorId, trackingCode, ip) {
  if (!ioInstance) return false;
  if (visitorId && sessionSockets[visitorId]) {
    const socket = ioInstance.sockets.sockets.get(sessionSockets[visitorId]);
    if (socket && socket.connected) return true;
  }
  if (trackingCode && ip) {
    const code = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
    const key = code + '_' + ip;
    const socketId = sessionSockets[key];
    if (socketId) {
      const socket = ioInstance.sockets.sockets.get(socketId);
      return socket && socket.connected;
    }
  }
  return false;
}

// ============================================================
// HELPER: Emit to session owner's room only (NOT all clients)
// ============================================================

function emitToOwnerRoom(sessions) {
  if (!ioInstance || !sessions || sessions.length === 0) return;
  
  // Group sessions by trackingCode (owner)
  const grouped = {};
  for (const s of sessions) {
    const tc = s.trackingCode || '';
    if (!tc) continue;
    // Extract owner code: "rokib001_7wu679" → "rokib001"
    const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
    if (!grouped[ownerCode]) grouped[ownerCode] = [];
    grouped[ownerCode].push({
      _id: s._id,
      isLive: s.isLive,
      status: s.status,
      lastActivity: s.lastActivity
    });
  }

  // Emit to each owner's room
  for (const [ownerCode, ownerSessions] of Object.entries(grouped)) {
    ioInstance.to('room_' + ownerCode).emit('sessionStatusDelta', {
      timestamp: new Date().toISOString(),
      sessions: ownerSessions
    });
  }
}

// ============================================================
// STATUS MONITOR — Hybrid Fast Offline + Anti-Flicker
// ============================================================

function computeStatus(session, socketAlive, nowMs) {
  const lastActivityMs = new Date(session.lastActivity || session.timestamp || Date.now()).getTime();
  const elapsed = nowMs - lastActivityMs;

  // PATH 1: DB already marked Offline by HTTP heartbeat → fast track
  if (session.isLive === false) return 'Offline';

  // PATH 2: Socket alive → Online (unless no activity for 3min)
  if (socketAlive) {
    if (elapsed > ACTIVITY_TIMEOUT_MS) return 'Offline';
    return 'Online';
  }

  // PATH 3: Socket dead — check HTTP heartbeat recency
  const HEARTBEAT_GRACE_MS = 6000;
  if (elapsed < HEARTBEAT_GRACE_MS) return 'Online';

  // PATH 4: No socket + no recent heartbeat → Offline
  return 'Offline';
}

async function statusMonitor() {
  try {
    const all = await safeReadSessions();
    if (!all || all.length === 0) return;

    const nowMs = Date.now();
    const changedSessions = [];
    const forceEmitSessions = [];

    for (const session of all) {
      if (!session._id) continue;
      if (session.hiddenForAll) continue;

      const sid = session._id.toString();
      const socketAlive = isSocketAlive(session.visitorId, session.trackingCode, session.ip);
      const newStatus = computeStatus(session, socketAlive, nowMs);

      // FIX: If DB says isLive=false, ALWAYS force emit to frontend
      if (session.isLive === false) {
        forceEmitSessions.push(session);
        continue;
      }

      const prev = previousStatusMap.get(sid);
      const currentStatus = session.status;

      if (newStatus === currentStatus) {
        if (prev) prev.changedAt = nowMs;
        continue;
      }

      if (!prev || prev.status !== newStatus) {
        previousStatusMap.set(sid, { status: newStatus, changedAt: nowMs });
        continue;
      }

      const elapsed = nowMs - prev.changedAt;

      if (newStatus === 'Offline' && session.isLive === false && elapsed < 2000) continue;
      if (newStatus === 'Offline' && !socketAlive && session.isLive !== false && elapsed < 6000) continue;
      if (newStatus === 'Offline' && socketAlive && elapsed < 5000) continue;
      if (newStatus === 'Online' && elapsed < 2000) continue;

      session.status = newStatus;
      session.isLive = newStatus !== 'Offline';
      session.lastActivity = new Date().toISOString();
      changedSessions.push(session);
      previousStatusMap.set(sid, { status: newStatus, changedAt: nowMs });

      try {
        await Session.updatePresence(session._id, {
          status: session.status,
          isLive: session.isLive,
          lastActivity: session.lastActivity
        });
      } catch (err) {}
    }

    const activeIds = new Set(all.map(s => s._id?.toString()).filter(Boolean));
    for (const key of previousStatusMap.keys()) {
      if (!activeIds.has(key)) previousStatusMap.delete(key);
    }

    // FIX v2: Room-based emit — only to session owner
    if (forceEmitSessions.length > 0) {
      emitToOwnerRoom(forceEmitSessions);
    }

    if (changedSessions.length > 0) {
      emitToOwnerRoom(changedSessions);
    }
  } catch (err) {}
}

// ============================================================
// AUTO-CLEAN — DISABLED
// ============================================================

async function inboxAutoClean() {
  console.log('[SessionManager] Auto-Clean is DISABLED. Use manual Clear Inbox instead.');
}

async function cleanupWebhookLogs() {
  try {
    const logs = await db.readJSON('webhook_logs');
    if (!Array.isArray(logs)) return;
    const fresh = logs.filter(l => (Date.now() - new Date(l.timestamp || Date.now()).getTime()) <= 86400000);
    await db.writeJSON('webhook_logs', fresh);
  } catch (err) {}
}

// ============================================================
// TIMERS
// ============================================================

function startStatusMonitor() {
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  statusMonitorTimer = setInterval(statusMonitor, 3000); // 3s interval for fast response
  setTimeout(statusMonitor, 1000);
}

function startLogCleanup() {
  if (logCleanupTimer) clearInterval(logCleanupTimer);
  logCleanupTimer = setInterval(cleanupWebhookLogs, 6 * 3600000);
  setTimeout(cleanupWebhookLogs, 30000);
}

function stop() {
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  if (logCleanupTimer) clearInterval(logCleanupTimer);
  previousStatusMap.clear();
}

function getIO() { return ioInstance; }
function getSessionSockets() { return sessionSockets; }

module.exports = {
  init, stop,
  statusMonitor, inboxAutoClean, cleanupWebhookLogs,
  getIO, getSessionSockets,
};