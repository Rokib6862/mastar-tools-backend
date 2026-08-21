// ============================================================
// MEGA TOOLS — SESSION MANAGER (ENTERPRISE Status Monitor)
// v3.0 Production Hardened
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

const ACTIVITY_TIMEOUT_MS = CONFIG.SESSION_TIMEOUT_MS || 5 * 60 * 1000;
const RECENT_WINDOW_MS = Math.max(ACTIVITY_TIMEOUT_MS * 2, 10 * 60 * 1000);
const STATUS_MONITOR_INTERVAL_MS = CONFIG.IS_PRODUCTION ? 2000 : 1000;
const MAX_PREVIOUS_STATUS_MAP = 5000;

// ============================================================
// INIT
// ============================================================

function init(io, sockets) {
  ioInstance = io;
  sessionSockets = sockets || {};
  startStatusMonitor();
  startLogCleanup();
}

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
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) {
      console.error('[SessionManager] safeReadSessions error:', err.message);
    }
  }
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
// HELPER: Emit to session owner's room only
// ============================================================

function emitToOwnerRoom(sessions) {
  if (!ioInstance || !sessions || sessions.length === 0) return;

  const grouped = {};
  for (const s of sessions) {
    const tc = s.trackingCode || '';
    if (!tc) continue;
    const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
    if (!grouped[ownerCode]) grouped[ownerCode] = [];
    grouped[ownerCode].push({
      _id: s._id,
      isLive: s.isLive,
      status: s.status,
      lastActivity: s.lastActivity
    });
  }

  for (const [ownerCode, ownerSessions] of Object.entries(grouped)) {
    ioInstance.to('room_' + ownerCode).emit('sessionStatusDelta', {
      timestamp: new Date().toISOString(),
      sessions: ownerSessions
    });
  }
}

// ============================================================
// STATUS MONITOR — ENTERPRISE: 5min Idle Timeout
// ============================================================

function computeStatus(session, socketAlive, nowMs) {
  const lastActivityMs = new Date(session.lastActivity || session.timestamp || Date.now()).getTime();
  const elapsed = nowMs - lastActivityMs;

  if (session.isLive === false) return 'Offline';

  if (socketAlive) {
    if (elapsed > ACTIVITY_TIMEOUT_MS) return 'Offline';
    return 'Online';
  }

  const HEARTBEAT_GRACE_MS = 1500;
  if (elapsed < HEARTBEAT_GRACE_MS) return 'Online';

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

      if (newStatus === 'Offline' && session.isLive === false && elapsed < 500) continue;
      if (newStatus === 'Offline' && !socketAlive && session.isLive !== false && elapsed < 1000) continue;
      if (newStatus === 'Offline' && socketAlive && elapsed < 800) continue;
      if (newStatus === 'Online' && elapsed < 500) continue;

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

    // Bound previousStatusMap size
    if (previousStatusMap.size > MAX_PREVIOUS_STATUS_MAP) {
      const keys = [...previousStatusMap.keys()].slice(0, previousStatusMap.size - MAX_PREVIOUS_STATUS_MAP);
      keys.forEach(k => previousStatusMap.delete(k));
    }

    if (forceEmitSessions.length > 0) {
      emitToOwnerRoom(forceEmitSessions);
    }

    if (changedSessions.length > 0) {
      emitToOwnerRoom(changedSessions);
    }
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) {
      console.error('[SessionManager] statusMonitor error:', err.message);
    }
  }
}

// ============================================================
// AUTO-CLEAN — DISABLED
// ============================================================

async function inboxAutoClean() {
  if (!CONFIG.IS_PRODUCTION) {
    console.log('[SessionManager] Auto-Clean is DISABLED. Use manual Clear Inbox instead.');
  }
}

async function cleanupWebhookLogs() {
  try {
    const logs = await db.readJSON('webhook_logs');
    if (!Array.isArray(logs)) return;
    const fresh = logs.filter(l => (Date.now() - new Date(l.timestamp || Date.now()).getTime()) <= 86400000);
    await db.writeJSON('webhook_logs', fresh);
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) {
      console.error('[SessionManager] cleanupWebhookLogs error:', err.message);
    }
  }
}

// ============================================================
// TIMERS
// ============================================================

function startStatusMonitor() {
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  statusMonitorTimer = setInterval(statusMonitor, STATUS_MONITOR_INTERVAL_MS);
  setTimeout(statusMonitor, 500);
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