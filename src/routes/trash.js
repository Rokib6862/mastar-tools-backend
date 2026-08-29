// ============================================================
// MEGA TOOLS — TRASH ROUTES (v4.1 FIXED)
// FIXED v4.1: format variable defined + CONFIG.SESSIONS_PER_PAGE fallback
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { ROLES } = require('../models/roles');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { toStringId, now, paginate } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// HELPERS
// ============================================================

const SESSIONS_PER_PAGE = CONFIG.SESSIONS_PER_PAGE || 20;

function isSessionForAnyCode(session, codes) {
  if (!session || !codes || codes.length === 0) return false;
  const tc = session.trackingCode || '';
  return codes.some(code => tc === code || tc.startsWith(code + '_'));
}

async function getAccessibleTrackingCodes(user) {
  const allUsers = await db.users.read();
  const uid = toStringId(user._id);
  const codes = [user.trackingCode].filter(Boolean);
  if (user.role === ROLES.OWNER) {
    allUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
  }
  return [...new Set(codes)];
}

function emitToUserRoom(io, user, event, data) {
  if (!io || !user) return;
  const uid = toStringId(user._id);
  io.to('user_' + uid).emit(event, data);
  if (user.trackingCode) {
    io.to('room_' + user.trackingCode).emit(event, data);
  }
}

// ============================================================
// GET TRASH
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    const allTrash = await db.trash.read();
    const userId = toStringId(req.user._id);
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || SESSIONS_PER_PAGE;

    let userTrash;
    if (req.user.role === ROLES.OWNER) {
      userTrash = allTrash.filter(t => !t.permanentlyDeleted);
    } else {
      const accessibleCodes = await getAccessibleTrackingCodes(req.user);
      userTrash = allTrash.filter(t => {
        if (t.permanentlyDeleted) return false;
        if (t.deletedBy === userId) return true;
        const tc = t.trackingCode || '';
        return accessibleCodes.some(code => tc === code || tc.startsWith(code + '_'));
      });
    }

    userTrash.sort((a, b) => new Date(b.deletedAt || b.timestamp) - new Date(a.deletedAt || a.timestamp));
    const result = paginate(userTrash, pageNum, limitNum);

    res.json({
      sessions: result.data,
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
    });
  } catch (err) {
    console.error('[Trash] GET error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// TRASH STATS
// ============================================================

router.get('/stats', authenticate, async (req, res) => {
  try {
    const allTrash = await db.trash.read();
    const userId = toStringId(req.user._id);

    let userTrash;
    if (req.user.role === ROLES.OWNER) {
      userTrash = allTrash.filter(t => !t.permanentlyDeleted);
    } else {
      const accessibleCodes = await getAccessibleTrackingCodes(req.user);
      userTrash = allTrash.filter(t => {
        if (t.permanentlyDeleted) return false;
        if (t.deletedBy === userId) return true;
        const tc = t.trackingCode || '';
        return accessibleCodes.some(code => tc === code || tc.startsWith(code + '_'));
      });
    }

    res.json({
      total: userTrash.length,
      uniqueSessions: userTrash.length,
      uniqueSubmissions: 0,
    });
  } catch (err) {
    console.error('[Trash] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// RESTORE SESSION
// ============================================================

router.post('/restore/:id', authenticate, async (req, res) => {
  try {
    const allTrash = await db.trash.read();
    const sessionId = req.params.id;
    const userId = toStringId(req.user._id);

    const trashIndex = allTrash.findIndex(t => {
      const tid = t._id?.toString?.() || t._id;
      return tid === sessionId || t.originalId === sessionId;
    });

    if (trashIndex === -1) {
      return res.status(404).json({ message: 'Session not found in trash' });
    }

    const trashItem = allTrash[trashIndex];

    if (req.user.role !== ROLES.OWNER && trashItem.deletedBy !== userId) {
      return res.status(403).json({ message: 'Access denied' });
    }

    allTrash.splice(trashIndex, 1);
    await db.trash.write(allTrash);

    const allSessions = await db.sessions.read();
    const sessionToRestore = { ...trashItem };
    delete sessionToRestore.deletedBy;
    delete sessionToRestore.deletedAt;
    delete sessionToRestore.originalId;
    delete sessionToRestore.permanentlyDeleted;
    sessionToRestore.hiddenFor = sessionToRestore.hiddenFor || [];
    sessionToRestore.hiddenFor = sessionToRestore.hiddenFor.filter(h => h !== userId);
    sessionToRestore.hiddenForAll = false;
    sessionToRestore.isLive = false;
    sessionToRestore.status = 'Offline';
    sessionToRestore.updated_at = now();

    const existingIndex = allSessions.findIndex(s => {
      const sid = s._id?.toString?.() || s._id;
      return sid === sessionId;
    });

    if (existingIndex >= 0) {
      allSessions[existingIndex] = sessionToRestore;
    } else {
      allSessions.unshift(sessionToRestore);
    }

    await db.sessions.write(allSessions);

    const io = req.app.get('io');
    if (io) {
      emitToUserRoom(io, req.user, 'sessionRestored', { sessionId, restoredBy: userId });
    }

    res.json({ success: true, message: 'Session restored to inbox' });
  } catch (err) {
    console.error('[Trash] Restore error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// PERMANENT DELETE — Only Owner
// ============================================================

router.delete('/permanent/:id', authenticate, async (req, res) => {
  try {
    if (req.user.role !== ROLES.OWNER) {
      return res.status(403).json({ message: 'Only Owner can permanently delete' });
    }

    const allTrash = await db.trash.read();
    const sessionId = req.params.id;

    const index = allTrash.findIndex(t => {
      const tid = t._id?.toString?.() || t._id;
      return tid === sessionId || t.originalId === sessionId;
    });

    if (index === -1) {
      return res.status(404).json({ message: 'Session not found in trash' });
    }

    allTrash.splice(index, 1);
    await db.trash.write(allTrash);

    const allSessions = await db.sessions.read();
    const sessionIndex = allSessions.findIndex(s => {
      const sid = s._id?.toString?.() || s._id;
      return sid === sessionId;
    });
    if (sessionIndex >= 0) {
      allSessions.splice(sessionIndex, 1);
      await db.sessions.write(allSessions);
    }

    const io = req.app.get('io');
    if (io) {
      emitToUserRoom(io, req.user, 'trashUpdated', { sessionId, permanentlyDeleted: true });
    }

    res.json({ success: true, message: 'Session permanently deleted' });
  } catch (err) {
    console.error('[Trash] Permanent delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EMPTY TRASH
// ============================================================

router.post('/empty', authenticate, async (req, res) => {
  try {
    const allTrash = await db.trash.read();
    const userId = toStringId(req.user._id);
    let removedCount = 0;

    if (req.user.role === ROLES.OWNER) {
      removedCount = allTrash.length;
      await db.trash.write([]);
    } else {
      const remaining = [];
      for (const t of allTrash) {
        if (t.deletedBy === userId) {
          removedCount++;
        } else {
          remaining.push(t);
        }
      }
      await db.trash.write(remaining);
    }

    const io = req.app.get('io');
    if (io) {
      emitToUserRoom(io, req.user, 'trashEmptied', { emptiedBy: userId, count: removedCount });
    }

    res.json({ success: true, message: 'Trash emptied', count: removedCount });
  } catch (err) {
    console.error('[Trash] Empty error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT TRASH
// ============================================================

router.get('/export', authenticate, async (req, res) => {
  try {
    const allTrash = await db.trash.read();
    const userId = toStringId(req.user._id);

    let userTrash;
    if (req.user.role === ROLES.OWNER) {
      userTrash = allTrash.filter(t => !t.permanentlyDeleted);
    } else {
      const accessibleCodes = await getAccessibleTrackingCodes(req.user);
      userTrash = allTrash.filter(t => {
        if (t.permanentlyDeleted) return false;
        if (t.deletedBy === userId) return true;
        const tc = t.trackingCode || '';
        return accessibleCodes.some(code => tc === code || tc.startsWith(code + '_'));
      });
    }

    const format = req.query.format || 'csv';

    if (format === 'json') {
      return res.json({ success: true, count: userTrash.length, data: userTrash, timestamp: now() });
    }

    const headers = ['Session ID', 'Visitor ID', 'Tracking Code', 'IP', 'Device', 'Browser', 'Status', 'Clicks', 'Submissions', 'Deleted At', 'Deleted By'];
    let csv = headers.join(',') + '\n';
    userTrash.forEach(s => {
      const row = [
        s._id || '', s.visitorId || '', s.trackingCode || '', s.ip || '',
        s.deviceType || '', (s.browser || '').replace(/,/g, ';'),
        s.status || '', s.clicks || 0, s.submissions?.length || 0,
        s.deletedAt || '', s.deletedBy || '',
      ];
      csv += row.join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=trash_export_${Date.now()}.csv`);
    res.send(csv);
  } catch (err) {
    console.error('[Trash] Export error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;