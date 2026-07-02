// ============================================================
// MEGA TOOLS — SESSION MANAGER (Smart 3-State: Online/Away/Offline)
// ============================================================

const db = require('../database');
const CONFIG = require('../config');

// ============================================================
// STATE
// ============================================================

let ioInstance = null;
let sessionSockets = {};
let statusMonitorTimer = null;
let logCleanupTimer = null;
let inboxCleanTimeout = null;
let inboxCleanInterval = null;
let trashPruneTimer = null;
let previousStatusMap = new Map();
let lastCleanDate = null;
const IDLE_TIMEOUT_MS = 30000;
const OFFLINE_CONFIRM_MS = 5000;

// ============================================================
// INIT
// ============================================================

function init(io, sockets) {
  ioInstance = io;
  sessionSockets = sockets || {};
  startStatusMonitor();
  startLogCleanup();
  scheduleInboxClean();
  startTrashPrune();
}

async function safeReadSessions() {
  try { const data = await db.sessions.read(); if (Array.isArray(data)) return data; } catch (err) {}
  try { return await db.readJSON('sessions') || []; } catch (err) {}
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
// SMART STATUS MONITOR — ATOMIC per-session update
// ============================================================

function computeStatus(socketAlive, lastActivityMs, nowMs) {
  if (!socketAlive) return 'Offline';
  if ((nowMs - lastActivityMs) >= IDLE_TIMEOUT_MS) return 'Away';
  return 'Online';
}

async function statusMonitor() {
  try {
    const all = await safeReadSessions();
    if (!all || all.length === 0) return;

    const nowMs = Date.now();
    const changedSessions = [];

    for (const session of all) {
      if (session.status === 'Trashed') continue;
      if (!session._id) continue;

      const sid = session._id.toString();
      const socketAlive = isSocketAlive(session.visitorId, session.trackingCode, session.ip);
      const lastActivityMs = new Date(session.lastActivity || session.timestamp || Date.now()).getTime();
      const newStatus = computeStatus(socketAlive, lastActivityMs, nowMs);

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
      
      if (newStatus === 'Offline' && elapsed < OFFLINE_CONFIRM_MS) continue;
      if (newStatus !== 'Offline' && elapsed < 2000) continue;

      session.status = newStatus;
      session.isLive = newStatus !== 'Offline';
      session.lastActivity = new Date().toISOString();
      changedSessions.push(session);
      previousStatusMap.set(sid, { status: newStatus, changedAt: nowMs });

      try {
        await db.sessions.findByIdAndUpdate(session._id, {
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

    if (changedSessions.length > 0 && ioInstance) {
      ioInstance.emit('sessionStatusDelta', {
        timestamp: new Date().toISOString(),
        sessions: changedSessions.map(s => ({
          _id: s._id, isLive: s.isLive, status: s.status, lastActivity: s.lastActivity
        }))
      });
    }
  } catch (err) {}
}

// ============================================================
// INBOX AUTO-CLEAN — Daily 12PM, Offline 24h → Trash
// ============================================================

async function inboxAutoClean() {
  try {
    const all = await safeReadSessions();
    const nowMs = Date.now();
    const maxAge = CONFIG.INBOX_CLEAN_INTERVAL_MS;
    let cleaned = 0;

    for (const session of all) {
      if (session.status !== 'Offline') continue;
      const lastAct = new Date(session.lastActivity || session.timestamp || Date.now()).getTime();
      if ((nowMs - lastAct) <= maxAge) continue;

      const Session = require('../models/Session');
      const sessionOwnerId = session.trackingCode || 'system';
      await Session.moveToTrash(session._id, sessionOwnerId, 'user', 'System Auto-Clean 24h');
      cleaned++;
    }

    if (cleaned > 0) console.log(`[SessionManager] InboxClean: ${cleaned} → Trash`);
  } catch (err) {}
}

async function trashAutoPrune() {
  try { const Trash = require('../models/Trash'); await Trash.autoPrune(); } catch (err) {}
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
  statusMonitorTimer = setInterval(statusMonitor, CONFIG.HEARTBEAT_INTERVAL_MS);
  setTimeout(statusMonitor, 3000);
}

function startLogCleanup() {
  if (logCleanupTimer) clearInterval(logCleanupTimer);
  logCleanupTimer = setInterval(cleanupWebhookLogs, 6 * 3600000);
  setTimeout(cleanupWebhookLogs, 30000);
}

function scheduleInboxClean() {
  if (inboxCleanTimeout) clearTimeout(inboxCleanTimeout);
  if (inboxCleanInterval) clearInterval(inboxCleanInterval);

  const now = new Date();
  const todayStr = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
  const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);

  if (now >= noon && lastCleanDate !== todayStr) {
    console.log('[SessionManager] 12PM passed, running catch-up clean...');
    inboxAutoClean();
    lastCleanDate = todayStr;
  }

  const nextNoon = new Date(noon);
  if (now >= noon) {
    nextNoon.setDate(nextNoon.getDate() + 1);
  }
  const msUntilNoon = nextNoon.getTime() - now.getTime();

  console.log(`[SessionManager] Next inbox clean: ${nextNoon.toLocaleString()} (in ${Math.round(msUntilNoon / 60000)} min)`);

  inboxCleanTimeout = setTimeout(() => {
    inboxAutoClean();
    lastCleanDate = new Date().getFullYear() + '-' + (new Date().getMonth() + 1) + '-' + new Date().getDate();
    inboxCleanInterval = setInterval(() => {
      inboxAutoClean();
      lastCleanDate = new Date().getFullYear() + '-' + (new Date().getMonth() + 1) + '-' + new Date().getDate();
    }, CONFIG.INBOX_CLEAN_INTERVAL_MS);
  }, msUntilNoon);
}

function startTrashPrune() {
  if (trashPruneTimer) clearInterval(trashPruneTimer);
  trashPruneTimer = setInterval(trashAutoPrune, 3600000);
  setTimeout(trashAutoPrune, 180000);
}

function stop() {
  if (statusMonitorTimer) clearInterval(statusMonitorTimer);
  if (logCleanupTimer) clearInterval(logCleanupTimer);
  if (inboxCleanTimeout) clearTimeout(inboxCleanTimeout);
  if (inboxCleanInterval) clearInterval(inboxCleanInterval);
  if (trashPruneTimer) clearInterval(trashPruneTimer);
  previousStatusMap.clear();
}

function getIO() { return ioInstance; }
function getSessionSockets() { return sessionSockets; }

module.exports = {
  init, stop,
  statusMonitor, inboxAutoClean, trashAutoPrune, cleanupWebhookLogs,
  getIO, getSessionSockets,
};