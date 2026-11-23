// ============================================================
// MEGA TOOLS — REDIRECT ROUTES (ENTERPRISE v2.3)
// FIXED: Null session guard for invalid trackingCode
// ENTERPRISE: Room-based emit
//
// FIX-RT1 (v2.1 — SINGLE-SESSION IDENTITY NORMALIZATION): retained.
// FIX-RT2 (v2.2 — REDIRECT = SILENT, NO sessionDelta EMIT): retained.
//
// FIX-S47 (v2.3 — VISITOR ISOLATION IN REDIRECT PATH):
//   Root cause (production screenshot evidence):
//     • normalizeVisitorId() was called with `ip: clientIp` in
//       this route, so visitors without a vid fell back to
//       `ip_<addr>` — same-IP visitors collapsed into one
//       session row and one socket channel.
//   Changes in this file:
//     • FIX-S47 — normalizeVisitorId call: `ip: null`,
//       `trackingCode` fallback ONLY when vid is absent.
//       This mirrors data.js (FIX-S44) and webhook.js
//       (FIX-S48). vid-bearing callers are now strictly
//       scoped to their own session.
//   Preserved:
//     • FIX-RT2 silent redirect (no sessionDelta emit).
//     • session_command emit to visitor socket + owner room.
//     • Response shape, link click counter, error handlers.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const Link = require('../models/Link');
const Session = require('../models/Session');
const { getSessionSockets } = require('../services/sessionManager');
// FIX-RT1: canonical identity normalizer
const { normalizeVisitorId, ownerCodeOf } = require('../utils/identity');

// FIX-RT2: buildSessionDelta kept for backward compatibility
// (may be used by tests / legacy consumers) but is no longer
// emitted from this route.
function buildSessionDelta(session, type) {
  return {
    type, timestamp: new Date().toISOString(),
    session: {
      _id: session._id, visitorId: session.visitorId, trackingCode: session.trackingCode,
      isLive: session.isLive, status: session.status || 'Online', lastActivity: session.lastActivity,
      clicks: session.clicks, submissions: session.submissions, deviceType: session.deviceType,
      deviceClass: session.deviceClass,
      baseCode: session.baseCode, entryUrl: session.entryUrl, currentUrl: session.currentUrl,
      ip: session.ip, browser: session.browser, formData: session.formData,
      redirectHistory: session.redirectHistory || [],
      lastCommand: session.lastCommand, lastCommandUrl: session.lastCommandUrl, commandSeq: session.commandSeq,
    },
  };
}

// Kept for consistency with webhook.js/data.js; unused on this route.
function emitToOwnerRoom(io, trackingCode, event, data) {
  if (!io || !trackingCode) return;
  const ownerCode = trackingCode.includes('_') ? trackingCode.split('_')[0] : trackingCode;
  io.to('room_' + ownerCode).emit(event, data);
}

// ============================================================
// POST /api/redirect
// ============================================================
router.post('/', async (req, res) => {
  try {
    const { trackingCode, redirectCode, visitorId, ip } = req.body;

    if (!trackingCode || !redirectCode) {
      return res.status(400).json({ success: false, message: 'trackingCode and redirectCode are required' });
    }

    const allLinks = await db.links.read();
    const link = allLinks.find(l => l.redirectCode === redirectCode || l.baseCode === redirectCode);

    if (!link) {
      return res.status(404).json({ success: false, message: 'Link not found for this redirect code' });
    }

    const base = (link.baseUrl || 'http://localhost:5174').replace(/\/$/, '');
    const clientIp = ip || req.ip || '';

    // FIX-S47: strict visitor isolation.
    //   - No IP fallback (same-IP visitors must not merge).
    //   - trackingCode fallback ONLY when vid is absent
    //     (legacy callers without vid keep their old behaviour).
    const effectiveVisitorId = normalizeVisitorId({
      visitorId: visitorId || null,
      ip: null,
      trackingCode: visitorId ? null : (trackingCode || null),
    });

    // FIX-RT1: always echo ?vid= so the landing page can persist it
    const vid = effectiveVisitorId || '';
    const targetBase = `${base}/${trackingCode}_${link.redirectCode || link.baseCode}`;
    const targetUrl = vid
      ? `${targetBase}?vid=${encodeURIComponent(vid)}`
      : targetBase;

    let sessionTrackingCode = trackingCode;
    let sessionRejected = false;
    try {
      const result = await Session.upsert({
        visitorId: effectiveVisitorId,
        trackingCode,
        baseCode: link.redirectCode || link.baseCode || '',
        linkId: link._id ? link._id.toString() : null,
        ip: clientIp,
        browser: 'Unknown',
        deviceType: 'Desktop',
        entryUrl: link.redirectCode || link.baseCode || '',
        currentUrl: targetUrl,
        collectedTypes: ['redirect_click'],
      });

      if (!result || !result.session) {
        console.warn('[Redirect] Rejected invalid trackingCode:', trackingCode);
        sessionRejected = true;
      } else {
        const { session } = result;
        sessionTrackingCode = session.trackingCode || trackingCode;

        // FIX-RT2: NO `sessionDelta` emit — redirect must be silent.
        // The DB is updated (Session.upsert above); the FE will
        // receive the new row only via the next /visit or /sessions
        // fetch, and no session sound / notification will fire.
      }
    } catch (err) {
      console.error('[Redirect] Session update error:', err.message);
    }

    if (sessionRejected) {
      return res.status(400).json({ success: false, message: 'Invalid tracking code — session rejected' });
    }

    const io = req.app.get('io');
    const sockets = getSessionSockets();
    const command = {
      action: 'navigate',
      url: targetUrl,
      message: '',
      seq: Date.now(),
      visitorId: effectiveVisitorId || '',
      trackingCode: sessionTrackingCode,
      timestamp: new Date().toISOString(),
    };

    if (io) {
      // FIX-RT1: try multiple keys (exact visitorId, ip_*, tc_*, sid_*)
      const keysToTry = [
        effectiveVisitorId,
        effectiveVisitorId ? String(effectiveVisitorId) : null,
        visitorId || null,
      ].filter(Boolean);
      const delivered = new Set();
      for (const k of keysToTry) {
        const sid = sockets && sockets[k];
        if (sid && !delivered.has(sid)) {
          delivered.add(sid);
          try { io.to(sid).emit('session_command', command); } catch (_) {}
        }
      }
      if (sessionTrackingCode) {
        try { io.to('room_' + sessionTrackingCode).emit('session_command', command); } catch (_) {}
      }
      const ownerCode = ownerCodeOf(sessionTrackingCode);
      if (ownerCode) {
        try { io.to('room_' + ownerCode).emit('session_command', command); } catch (_) {}
      }
    }

    try {
      if (link._id) {
        const linkIndex = allLinks.findIndex(l =>
          (l._id?.toString?.() || l._id) === (link._id?.toString?.() || link._id)
        );
        if (linkIndex !== -1) {
          allLinks[linkIndex].total_clicks = (allLinks[linkIndex].total_clicks || 0) + 1;
          allLinks[linkIndex].last_click = new Date().toISOString();
          await db.links.write(allLinks);
        }
      }
    } catch (err) {
      console.error('[Redirect] Link update error:', err.message);
    }

    res.json({
      success: true,
      redirectUrl: targetUrl,
      linkName: link.name,
      message: 'Redirect URL generated',
    });
  } catch (err) {
    console.error('[Redirect] Error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;