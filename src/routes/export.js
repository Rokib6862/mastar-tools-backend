// ============================================================
// MEGA TOOLS — EXPORT ROUTES (v3.1 SIMPLIFIED)
// isAdmin/isTeamManager → isOwner (Admin/TM roles eliminated)
// FIX-EX1 (v3.1): CSV fields now properly quoted/escaped (RFC 4180)
//                 so commas, quotes, and newlines inside browser /
//                 URL fields do not break the CSV.
// FIX-EX2 (v3.1): `parseInt(offset)` / `parseInt(limit)` guarded —
//                 NaN inputs fall back to 0 / EXPORT_MAX_ROWS.
// FIX-EX3 (v3.1): sessions sorted by `lastActivity || timestamp` so
//                 the export order matches the inbox.
// FIX-EX4 (v3.1): `formatDate` guards against invalid ISO strings
//                 (returns '' instead of "Invalid Date").
// FIX-EX5 (v3.1): /stats now filters by user access (uses
//                 getFilteredSessions) instead of returning global
//                 stats to any owner-only caller — actually isOwner
//                 only so behavior unchanged, but consistent with
//                 sessions export scope.
// FIX-EX6 (v3.1): CSV Content-Type includes charset=utf-8 and a
//                 BOM (U+FEFF) so Excel opens it with correct
//                 encoding for Bangla/Unicode content.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { ROLES } = require('../models/roles');
const User = require('../models/User');
const { authenticate, isOwner } = require('../middleware/auth');
const { toStringId, paginate } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// HELPERS
// ============================================================

function formatDate(date) {
  if (!date) return '';
  const t = new Date(date).getTime();
  if (!Number.isFinite(t)) return ''; // FIX-EX4
  return new Date(t).toISOString().replace('T', ' ').substring(0, 19);
}

function csvEscape(value) {
  // FIX-EX1: RFC-4180 quote-escaped
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

async function getFilteredSessions(user) {
  const allSessions = await db.sessions.read();
  const userRole = user.role;
  const userId = toStringId(user._id);

  if (userRole === ROLES.OWNER) return allSessions;

  const codes = await User.getTrackingCodesForUser(user._id);
  return allSessions.filter(s => {
    const tc = s.trackingCode || '';
    return codes.some(c => tc === c || tc.startsWith(c + '_'));
  });
}

// ============================================================
// EXPORT SESSIONS
// ============================================================

router.get('/sessions', authenticate, isOwner, async (req, res) => {
  try {
    const { format = 'json' } = req.query;

    // FIX-EX2: safe parse
    let limitNum = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limitNum) || limitNum <= 0) limitNum = CONFIG.EXPORT_MAX_ROWS;
    if (limitNum > CONFIG.EXPORT_MAX_ROWS) limitNum = CONFIG.EXPORT_MAX_ROWS;

    let offsetNum = parseInt(req.query.offset, 10);
    if (!Number.isFinite(offsetNum) || offsetNum < 0) offsetNum = 0;

    let sessions = await getFilteredSessions(req.user);

    // FIX-EX3: stable sort by lastActivity || timestamp
    sessions.sort((a, b) => {
      const ta = new Date(a.lastActivity || a.timestamp || 0).getTime() || 0;
      const tb = new Date(b.lastActivity || b.timestamp || 0).getTime() || 0;
      return tb - ta;
    });

    const paginated = sessions.slice(offsetNum, offsetNum + limitNum);
    const total = sessions.length;

    if (format === 'json') {
      return res.json({
        success: true,
        total,
        exported: paginated.length,
        data: paginated,
        timestamp: new Date().toISOString(),
      });
    }

    if (format === 'csv') {
      const headers = [
        'ID', 'Visitor ID', 'Tracking Code', 'IP', 'Device',
        'Browser', 'Entry URL', 'Current URL', 'Status',
        'Clicks', 'Submissions', 'First Seen', 'Last Activity',
      ];

      // FIX-EX6: BOM for Excel UTF-8
      let csv = '\uFEFF' + headers.map(csvEscape).join(',') + '\r\n';
      paginated.forEach(s => {
        const row = [
          csvEscape(s._id || ''),
          csvEscape(s.visitorId || ''),
          csvEscape(s.trackingCode || ''),
          csvEscape(s.ip || ''),
          csvEscape(s.deviceType || ''),
          csvEscape(s.browser || ''),
          csvEscape(s.entryUrl || ''),
          csvEscape(s.currentUrl || ''),
          csvEscape(s.isLive ? 'Live' : 'Offline'),
          csvEscape(s.clicks || 0),
          csvEscape(s.submissions ? s.submissions.length : 0),
          csvEscape(formatDate(s.timestamp)),
          csvEscape(formatDate(s.lastActivity)),
        ];
        csv += row.join(',') + '\r\n';
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=sessions_${Date.now()}.csv`);
      return res.send(csv);
    }

    if (format === 'xlsx') {
      const excelData = paginated.map(s => ({
        ID: s._id || '',
        'Visitor ID': s.visitorId || '',
        'Tracking Code': s.trackingCode || '',
        IP: s.ip || '',
        Device: s.deviceType || '',
        Browser: s.browser || '',
        'Entry URL': s.entryUrl || '',
        'Current URL': s.currentUrl || '',
        Status: s.isLive ? 'Live' : 'Offline',
        Clicks: s.clicks || 0,
        Submissions: s.submissions ? s.submissions.length : 0,
        'First Seen': formatDate(s.timestamp),
        'Last Activity': formatDate(s.lastActivity),
      }));

      return res.json({
        success: true, format: 'xlsx', total,
        exported: paginated.length, data: excelData,
        timestamp: new Date().toISOString(),
      });
    }

    res.status(400).json({ success: false, message: 'Invalid format. Use: json, csv, xlsx' });
  } catch (err) {
    console.error('[Export] Sessions error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT STATS
// ============================================================

router.get('/stats', authenticate, isOwner, async (req, res) => {
  try {
    // FIX-EX5: consistent scope with sessions export
    const sessions = await getFilteredSessions(req.user);

    res.json({
      totalSessions: sessions.length,
      liveSessions: sessions.filter(s => s.isLive).length,
      mobileSessions: sessions.filter(s => s.deviceType === 'Mobile').length,
      desktopSessions: sessions.filter(s => s.deviceType === 'Desktop').length,
      totalSubmissions: sessions.reduce((sum, s) => sum + (s.submissions?.length || 0), 0),
      uniqueVisitors: new Set(sessions.map(s => s.visitorId || s.ip)).size,
      lastExport: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Export] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;