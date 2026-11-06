// ============================================================
// MEGA TOOLS — AUTHENTICATION & AUTHORIZATION MIDDLEWARE (v4.0)
// 3-TIER: Owner + Admin + User
// Admin can access user-management scope (own children only)
// ============================================================

const jwt = require('jsonwebtoken');
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

    // 5. Attach user to request
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
// ROLE-BASED MIDDLEWARE (3-TIER — v4.0)
// isOwner          → owner only
// isAdmin          → admin only
// isAdminOrOwner   → owner + admin
// requireRole(...) → arbitrary combination
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

// Only Owner has top-level administrative access
const isOwner = requireRole(ROLES.OWNER);

// Only Admin (sub-administrator)
const isAdmin = requireRole(ROLES.ADMIN);

// Both Owner and Admin — for user-management, referral generation, etc.
const isAdminOrOwner = requireRole(ROLES.OWNER, ROLES.ADMIN);

// ============================================================
// OPTIONAL AUTH (for upload endpoints)
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

    const decoded = verifyToken(token);
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === decoded.id);
    req.user = user || null;
    next();
  } catch (err) {
    req.user = null;
    next();
  }
}

// ============================================================
// EXPORT (v4.0 — isOwner + isAdmin + isAdminOrOwner + requireRole)
// ============================================================

module.exports = {
  authenticate,
  optionalAuth,
  isOwner,
  isAdmin,
  isAdminOrOwner,
  requireRole,
  verifyToken,
};