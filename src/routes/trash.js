// ============================================================
// MEGA TOOLS — TRASH ROUTES (ENTERPRISE v7.0 — OWNER MANUAL DELETE)
// REMOVED: POST /restore/:id (no restore — permanent retention)
// REMOVED: DELETE /permanent/:id (was scheduler-only — now manual via owner)
// REMOVED: POST /empty (was scheduler-only — now manual via owner)
// AUTO-DELETE: DISABLED (FIX-TRASH-1) — trash items permanent
// KEPT: GET /, GET /stats, GET /export (read-only)
// NEW (v7.0 — FIX-TRASH-2):
//   DELETE /:id      — owner-only permanent delete of one item
//   DELETE /         — owner-only empty entire trash
// FIX-T1 (v6.0): 3-tier hierarchy — admin sees own + own children trash
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { ROLES } = require('../models/roles');
const User = require('../models/User');
const { authenticate, isOwner } = require('../middleware/auth');
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

// FIX-T1: 3-tier accessible codes — owner: all, admin: self + children, user: self
async function getAccessibleTrackingCodes(user) {
  const allUsers = await db.users.read();
  const codes = [user.trackingCode].filter(Boolean);
  const uid = toStringId(user._id);

  if (user.role === ROLES.OWNER) {
    allUsers.forEach(u => { if (u.trackingCode) codes.push(u.trackingCode); });
  } else if (user.role === ROLES.ADMIN) {
    allUsers.forEach(u => {
      if (toStringId(u.parentId) === uid && u.trackingCode) {
        codes.push(u.trackingCode);
      }
    });
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

// ============================================================
// FIX-TRASH-2 (v7.0 — OWNER MANUAL DELETE)
//   Auto-delete is DISABLED (FIX-TRASH-1). Trash items are
//   permanent. The owner can explicitly delete via these routes.
//
//   DELETE /api/trash/:id  — permanently delete ONE trash item.
//                             Matches by `_id` (trash_* id) OR
//                             by `originalId` (original session id).
//                             Also removes the mirror entry from
//                             owner_trash.json (if present).
//
//   DELETE /api/trash      — permanently empty the entire trash.
//                             Requires { confirm: "YES" } body.
//                             Removes both trash.json and
//                             owner_trash.json contents.
//
//   Access: owner only (isOwner middleware). Admin / user get 403.
//   Safety:
//     • Uses dedicated write lock via db.writeJSON (atomic file write).
//     • Emits `trashItemDeleted` socket event for UI refresh.
//     • No-op when trash is already empty (returns removed: 0).
// ============================================================

router.delete('/:id', authenticate, isOwner, async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'id required' });

    const allTrash = await db.readJSON('trash') || [];
    const before = allTrash.length;
    const filtered = allTrash.filter(t => {
      if (!t) return false;
      const tid = String(t._id || '');
      const toid = String(t.originalId || '');
      return tid !== id && toid !== id;
    });
    const after = filtered.length;
    const removed = before - after;

    if (removed === 0) {
      return res.status(404).json({ success: false, message: 'Trash item not found', removed: 0 });
    }

    await db.writeJSON('trash', filtered);

    // Mirror cleanup in owner_trash.json
    try {
      const allOwnerTrash = await db.readJSON('owner_trash') || [];
      const filteredOwner = allOwnerTrash.filter(t => {
        if (!t) return false;
        const tid = String(t._id || '');
        const toid = String(t.originalId || '');
        return tid !== id && toid !== id;
      });
      if (filteredOwner.length !== allOwnerTrash.length) {
        await db.writeJSON('owner_trash', filteredOwner);
      }
    } catch (e) {
      console.warn('[Trash] owner_trash mirror cleanup failed:', e.message);
    }

    // Socket: notify all clients to refresh trash UI
    const io = req.app.get('io');
    if (io) {
      try {
        io.emit('trashItemDeleted', {
          id,
          removed,
          all: false,
          timestamp: new Date().toISOString(),
        });
      } catch (_) {}
    }

    res.json({ success: true, message: 'Trash item permanently deleted', removed });
  } catch (err) {
    console.error('[Trash] DELETE one error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/', authenticate, isOwner, async (req, res) => {
  try {
    const confirmBody = String((req.body && req.body.confirm) || '').trim().toUpperCase();
    const confirmQuery = String((req.query && req.query.confirm) || '').trim().toUpperCase();
    if (confirmBody !== 'YES' && confirmQuery !== 'YES') {
      return res.status(400).json({
        success: false,
        message: 'Add ?confirm=YES (or body { "confirm": "YES" }) to authorize full trash clear.',
      });
    }

    const allTrash = await db.readJSON('trash') || [];
    const count = allTrash.length;

    await db.writeJSON('trash', []);
    try { await db.writeJSON('owner_trash', []); } catch (e) {
      console.warn('[Trash] owner_trash clear failed:', e.message);
    }

    const io = req.app.get('io');
    if (io) {
      try {
        io.emit('trashItemDeleted', {
          all: true,
          count,
          timestamp: new Date().toISOString(),
        });
      } catch (_) {}
    }

    res.json({ success: true, message: 'Trash emptied', removed: count });
  } catch (err) {
    console.error('[Trash] DELETE ALL error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;