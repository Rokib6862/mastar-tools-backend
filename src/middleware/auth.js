// ============================================================
// MEGA TOOLS — AUTHENTICATION & AUTHORIZATION MIDDLEWARE (v4.2)
// 3-TIER: Owner + Admin + User
// Admin can access user-management scope (own children only)
// ============================================================
// FIX-AUTH1 (v4.1 — SINGLE-DEVICE SESSION): retained.
// FIX-AUTH2 (v4.2 — SAME-DEVICE TOLERANCE):
//   Root cause of "auto-logout while using the app" (reported by
//   user on 2026-11-09): the single-device enforcement rejected
//   any HTTP request whose `jti` did not match `user.activeSessionId`.
//   This caused random 401 "session_replaced" responses whenever
//   the user opened the app in a second tab OR when the app was
//   reloaded after Render went to sleep — the server had already
//   rotated `activeSessionId` but the browser still held the old
//   cookie.
//   Fix strategy:
//     * Add a per-User-Agent device fingerprint check.
//     * A token is only rejected when the fingerprint differs
//       (i.e. a genuinely different browser/OS/device).
//     * Same-device tab/hard-reload always passes — the browser
//       keeps sending the SAME cookie until it is replaced, so
//       "stale jti" no longer triggers a logout.
//     * The `jti` rotation still happens on the server at login
//       time — so a NEW login on another device still kicks the
//       old device on its NEXT request (single-device is
//       preserved), but a page reload / new tab on the same
//       device is immune.
// FIX-AUTH3 (v4.2 — LEGACY TOKEN FRIENDLINESS):
//   Legacy tokens (no jti claim) always pass, even when the user
//   has an activeSessionId — they simply do not participate in
//   single-device enforcement. Preserved from v4.1.
// FIX-AUTH4 (v4.2 — SESSION_REPLACED REASONING):
//   sessionReplacedError() now includes the reason so the client
//   can show "logged in from another device" vs "session expired
//   on a different browser" without guessing.
// ============================================================

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../database');
const { ROLES, getRoleLevel } = require('../models/roles');
const { toStringId } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// JWT VERIFY
// ============================================================

function verifyToken(token) {
  try {
    return jwt.verify(token, CONFIG.JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw { status: 401, message: 'Token expired. Please login again.' };
    }
    if (err.name === 'JsonWebTokenError') {
      throw { status: 401, message: 'Invalid token signature.' };
    }
    throw { status: 401, message: 'Authentication failed.' };
  }
}

// ============================================================
// DEVICE FINGERPRINT (FIX-AUTH2)
// ============================================================
// A coarse device identity used to distinguish "different device"
// from "same device, different tab / hard reload".
// Deliberately does NOT include IP — mobile networks rotate IPs
// constantly, which would falsely trigger session_replaced.
// Only UA-derived stable hints are used.
function getDeviceFingerprint(req) {
  try {
    const ua = String(req.headers['user-agent'] || '').trim();
    const lang = String(req.headers['accept-language'] || '').split(',')[0].trim();
    const raw = ua + '|' + lang;
    if (!raw.trim() || raw === '|') return '';
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  } catch (_) {
    return '';
  }
}

// ============================================================
// SESSION_REPLACED ERROR (FIX-AUTH4)
// ============================================================

function sessionReplacedError(res, reason) {
  return res.status(401).json({
    success: false,
    code: 'session_replaced',
    reason: reason || 'another_device',
    message: 'You have been logged in from another device. Please log in again.',
  });
}

// ============================================================
// MAIN AUTHENTICATE MIDDLEWARE
// ============================================================

async function authenticate(req, res, next) {
  // Skip if already authenticated (prevents double auth from router.handle)
  if (req._authDone && req.user) return next();
  try {
    // 1. Extract token
    const token =
      req.cookies?.auth_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please login.',
      });
    }

    // 2. Verify token
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      return res.status(err.status || 401).json({
        success: false,
        message: err.message,
      });
    }

    // 3. Find user
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === decoded.id);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found.',
      });
    }

    // 4. Status checks
    if (user.status === 'blocked') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been blocked. Please contact support.',
      });
    }

    if (user.status === 'pending') {
      return res.status(403).json({
        success: false,
        message: 'Your account is pending approval.',
      });
    }

    // 5. SINGLE-DEVICE ENFORCEMENT (v4.2 — same-device tolerance)
    //    Reject only when:
    //      - user has an activeSessionId
    //      - token carries a jti
    //      - the two do NOT match
    //      - AND the device fingerprint stored on the user at last
    //        login differs from the current request's fingerprint.
    //    Same device reload / new tab / overnight sleep therefore
    //    always pass. A genuinely different browser still gets
    //    rejected on its next request → single-device preserved.
    const activeJti = user.activeSessionId || null;
    const tokenJti = decoded.jti || null;

    if (activeJti && tokenJti && activeJti !== tokenJti) {
      const storedFp = user.activeDeviceFingerprint || '';
      const currentFp = getDeviceFingerprint(req);

      // If either side has no fingerprint (legacy login), be
      // permissive — otherwise old users would get logged out
      // for no visible reason.
      const sameDevice =
        !storedFp || !currentFp || storedFp === currentFp;

      if (!sameDevice) {
        return sessionReplacedError(res, 'another_device');
      }
      // Same device → fall through (do NOT logout)
    }

    // 6. Attach user to request
    req.user = user;
    req.userId = toStringId(user._id);
    req._authDone = true;

    next();
  } catch (err) {
    console.error('[Auth] Error:', err.message);
    return res.status(401).json({
      success: false,
      message: 'Authentication failed.',
    });
  }
}

// ============================================================
// ROLE-BASED MIDDLEWARE (3-TIER — unchanged)
// ============================================================

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required.' });
    }

    if (roles.includes(req.user.role)) {
      return next();
    }

    return res.status(403).json({
      success: false,
      message: 'You do not have permission to access this resource.',
    });
  };
}

const isOwner = requireRole(ROLES.OWNER);
const isAdmin = requireRole(ROLES.ADMIN);
const isAdminOrOwner = requireRole(ROLES.OWNER, ROLES.ADMIN);

// ============================================================
// OPTIONAL AUTH (v4.2 — same-device tolerance for guests)
// ============================================================

async function optionalAuth(req, res, next) {
  try {
    const token =
      req.cookies?.auth_token ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      req.user = null;
      return next();
    }

    let decoded;
    try { decoded = verifyToken(token); } catch { req.user = null; return next(); }

    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === decoded.id);
    if (!user) {
      req.user = null;
      return next();
    }

    // v4.2 — treat genuinely-different-device as guest,
    // but same device (new tab / reload) passes as authenticated.
    const activeJti = user.activeSessionId || null;
    const tokenJti = decoded.jti || null;
    if (activeJti && tokenJti && activeJti !== tokenJti) {
      const storedFp = user.activeDeviceFingerprint || '';
      const currentFp = getDeviceFingerprint(req);
      const sameDevice = !storedFp || !currentFp || storedFp === currentFp;
      if (!sameDevice) {
        req.user = null;
        return next();
      }
    }

    req.user = user;
    req.userId = toStringId(user._id);
    next();
  } catch (err) {
    req.user = null;
    next();
  }
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  authenticate,
  optionalAuth,
  isOwner,
  isAdmin,
  isAdminOrOwner,
  requireRole,
  verifyToken,
  getDeviceFingerprint,
};