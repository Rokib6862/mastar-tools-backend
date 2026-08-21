// ============================================================
// MEGA TOOLS — EXPORT ROUTES (v3.0 Production Hardened)
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
  return new Date(date).toISOString().replace('T', ' ').substring(0, 19);
}

function sanitizeCsvField(value) {
  if (value === null || value === undefined) return '';
  let str = String(value);
  // Prevent CSV formula injection
  if (str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@')) {
    str = "'" + str;
  }
  return str.replace(/,/g, ';').replace(/\n/g, ' ').replace(/\r/g, ' ');
}

async function getFilteredSessions(user) {
  const allSessions = await db.sessions.read();
  const userRole = user.role;

  if (userRole === ROLES.OWNER) return allSessions;

  const codes = await User.getTrackingCodesForUser(user._id);
  return allSessions.filter(s => codes.includes(s.trackingCode));
}

// ============================================================
// EXPORT SESSIONS (Owner only)
// ============================================================

router.get('/sessions', authenticate, isOwner, async (req, res) => {
  try {
    const { format = 'json' } = req.query;
    const limitNum = Math.min(parseInt(req.query.limit) || CONFIG.EXPORT_MAX_ROWS, CONFIG.EXPORT_MAX_ROWS);
    const offsetNum = Math.max(parseInt(req.query.offset) || 0, 0);

    let sessions = await getFilteredSessions(req.user);

    sessions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const start = offsetNum;
    const end = start + limitNum;
    const paginated = sessions.slice(start, end);
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

      let csv = headers.join(',') + '\n';
      paginated.forEach(s => {
        const row = [
          sanitizeCsvField(s._id),
          sanitizeCsvField(s.visitorId),
          sanitizeCsvField(s.trackingCode),
          sanitizeCsvField(s.ip),
          sanitizeCsvField(s.deviceType),
          sanitizeCsvField(s.browser),
          sanitizeCsvField(s.entryUrl),
          sanitizeCsvField(s.currentUrl),
          s.isLive ? 'Live' : 'Offline',
          s.clicks || 0,
          s.submissions ? s.submissions.length : 0,
          formatDate(s.timestamp),
          formatDate(s.lastActivity),
        ];
        csv += row.join(',') + '\n';
      });

      res.setHeader('Content-Type', 'text/csv');
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
    if (!CONFIG.IS_PRODUCTION) console.error('[Export] Sessions error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT STATS (Owner only)
// ============================================================

router.get('/stats', authenticate, isOwner, async (req, res) => {
  try {
    const sessions = await db.sessions.read();

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
    if (!CONFIG.IS_PRODUCTION) console.error('[Export] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;