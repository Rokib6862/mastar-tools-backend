// ============================================================
// MEGA TOOLS — TRASH ROUTES (ENTERPRISE v5.0)
// REMOVED: POST /restore/:id (no restore — 24h auto-permanent-delete)
// REMOVED: DELETE /permanent/:id (only scheduler handles)
// REMOVED: POST /empty (only scheduler handles)
// AUTO: 24h after deletedAt → sessionManager permanently deletes
// KEPT: GET /, GET /stats, GET /export (read-only)
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

function isSessionForAnyCode(session, codes) {
  if (!session || !codes || codes.length === 0) return false;
  const tc = session.trackingCode || '';
  return codes.some(code => tc === code || tc.startsWith(code + '_'));
}

async function getAccessibleTrackingCodes(user) {
  const allUsers = await db.users.read();
  const codes = [user.trackingCode].filter(Boolean);
  if (user.role === ROLES.OWNER) {
    allUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
  }
  return [...new Set(codes)];
}

async function filterTrashForUser(allTrash, user) {
  const userId = toStringId(user._id);
  if (user.role === ROLES.OWNER) {
    return allTrash.filter(t => !t.permanentlyDeleted);
  }
  const accessibleCodes = await getAccessibleTrackingCodes(user);
  return allTrash.filter(t => {
    if (t.permanentlyDeleted) return false;
    if (t.deletedBy === userId) return true;
    const tc = t.trackingCode || '';
    return accessibleCodes.some(code => tc === code || tc.startsWith(code + '_'));
  });
}

function countSubmissions(items) {
  return items.reduce((sum, t) => sum + (Array.isArray(t.submissions) ? t.submissions.length : 0), 0);
}

// ============================================================
// GET TRASH (read-only)
// ============================================================

router.get('/', authenticate, async (req, res) => {
  try {
    const allTrash = await db.readJSON('trash');
    const pageNum = parseInt(req.query.page) || 1;
    const limitNum = parseInt(req.query.limit) || CONFIG.SESSIONS_PER_PAGE;

    let userTrash = await filterTrashForUser(allTrash, req.user);
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
// TRASH STATS (read-only)
// ============================================================

router.get('/stats', authenticate, async (req, res) => {
  try {
    const allTrash = await db.readJSON('trash');
    const userTrash = await filterTrashForUser(allTrash, req.user);

    res.json({
      total: userTrash.length,
      uniqueSessions: userTrash.length,
      uniqueSubmissions: countSubmissions(userTrash),
    });
  } catch (err) {
    console.error('[Trash] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT TRASH (read-only)
// ============================================================

router.get('/export', authenticate, async (req, res) => {
  try {
    const allTrash = await db.readJSON('trash');
    const userTrash = await filterTrashForUser(allTrash, req.user);

    const rawFormat = (req.query.format || 'csv').toString().toLowerCase();
    const format = rawFormat === 'json' ? 'json' : 'csv';

    if (format === 'json') {
      return res.json({
        success: true,
        count: userTrash.length,
        data: userTrash,
        timestamp: now(),
      });
    }

    const headers = ['Session ID', 'Visitor ID', 'Tracking Code', 'IP', 'Device', 'Browser', 'Status', 'Clicks', 'Submissions', 'Deleted At', 'Deleted By'];
    let csv = headers.join(',') + '\n';
    userTrash.forEach(s => {
      const row = [
        s._id || '',
        s.visitorId || '',
        s.trackingCode || '',
        s.ip || '',
        s.deviceType || '',
        (s.browser || '').replace(/,/g, ';'),
        s.status || '',
        s.clicks || 0,
        Array.isArray(s.submissions) ? s.submissions.length : 0,
        s.deletedAt || '',
        s.deletedBy || '',
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