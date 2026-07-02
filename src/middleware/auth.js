// ============================================================
// MEGA TOOLS — AUTHENTICATION & AUTHORIZATION MIDDLEWARE
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
// TRIAL EXPIRY CHECK
// ============================================================

async function checkTrialExpiry(user) {
  if (!user) return user;

  if (user.isTrial && user.trialExpiry && user.status !== 'trial_expired') {
    if (new Date(user.trialExpiry) < new Date()) {
      const allUsers = await db.users.read();
      const index = allUsers.findIndex(u => toStringId(u._id) === toStringId(user._id));
      if (index !== -1) {
        allUsers[index].status = 'trial_expired';
        allUsers[index].updated_at = new Date().toISOString();
        await db.users.write(allUsers);
        user.status = 'trial_expired';
      }
    }
  }
  return user;
}

// ============================================================
// MAIN AUTHENTICATE MIDDLEWARE
// ============================================================

async function authenticate(req, res, next) {
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
    let user = allUsers.find(u => toStringId(u._id) === decoded.id);

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

    // 5. Trial expiry check
    user = await checkTrialExpiry(user);

    if (user.status === 'trial_expired') {
      const path = req.originalUrl || '';
      const allowedPaths = ['/api/auth', '/api/support', '/api/upload', '/api/health'];
      const isAllowed = allowedPaths.some(p => path.startsWith(p));

      if (!isAllowed) {
        return res.status(403).json({
          success: false,
          message: 'Your free trial has expired. Please verify with a referral code.',
          code: 'TRIAL_EXPIRED',
        });
      }
    }

    // 6. Attach user to request
    req.user = user;
    req.userId = toStringId(user._id);

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
// ROLE-BASED MIDDLEWARE
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
const isAdmin = requireRole(ROLES.OWNER, ROLES.ADMIN);
const isTeamManager = requireRole(ROLES.OWNER, ROLES.ADMIN, ROLES.TEAM_MANAGER);
const isAdminOrTeamManager = requireRole(ROLES.OWNER, ROLES.ADMIN, ROLES.TEAM_MANAGER);
const isAdminOrSelf = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  const requestedId = toStringId(req.params.id || req.params.userId || req.body.userId);
  const isSelf = toStringId(req.user._id) === requestedId;
  const isAllowedRole = [ROLES.OWNER, ROLES.ADMIN].includes(req.user.role);

  if (isSelf || isAllowedRole) return next();

  return res.status(403).json({ success: false, message: 'Access denied.' });
};

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
// EXPORT
// ============================================================

module.exports = {
  authenticate,
  optionalAuth,
  isOwner,
  isAdmin,
  isTeamManager,
  isAdminOrTeamManager,
  isAdminOrSelf,
  requireRole,
  verifyToken,
  checkTrialExpiry,
};