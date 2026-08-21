// ============================================================
// MEGA TOOLS — AUTHENTICATION & AUTHORIZATION MIDDLEWARE
// v3.0 Production Hardened
// ============================================================

const jwt = require('jsonwebtoken');
const db = require('../database');
const { ROLES } = require('../models/roles');
const { toStringId } = require('../utils/helpers');
const CONFIG = require('../config');

function verifyToken(token) {
  try {
    return jwt.verify(token, CONFIG.JWT_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw { status: 401, message: 'Token expired. Please login again.' };
    if (err.name === 'JsonWebTokenError') throw { status: 401, message: 'Invalid token signature.' };
    throw { status: 401, message: 'Authentication failed.' };
  }
}

async function authenticate(req, res, next) {
  if (req._authDone && req.user) return next();
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ success: false, message: 'Authentication required. Please login.' });

    let decoded;
    try { decoded = verifyToken(token); }
    catch (err) { return res.status(err.status || 401).json({ success: false, message: err.message }); }

    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === decoded.id);
    if (!user) return res.status(401).json({ success: false, message: 'User not found.' });

    if (user.status === 'blocked') return res.status(403).json({ success: false, message: 'Your account has been blocked.' });
    if (user.status === 'pending') return res.status(403).json({ success: false, message: 'Your account is pending approval.' });

    req.user = user;
    req.userId = toStringId(user._id);
    req._authDone = true;
    next();
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Auth] Error:', err.message);
    return res.status(401).json({ success: false, message: 'Authentication failed.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required.' });
    if (roles.includes(req.user.role)) return next();
    return res.status(403).json({ success: false, message: 'You do not have permission.' });
  };
}

const isOwner = requireRole(ROLES.OWNER);

const isOwnerOrSelf = (req, res, next) => {
  if (!req.user) return res.status(401).json({ success: false, message: 'Authentication required.' });
  const requestedId = toStringId(req.params.id || req.params.userId || req.body.userId);
  if (toStringId(req.user._id) === requestedId || req.user.role === ROLES.OWNER) return next();
  return res.status(403).json({ success: false, message: 'Access denied.' });
};

async function optionalAuth(req, res, next) {
  try {
    const token = req.cookies?.auth_token || req.headers.authorization?.replace('Bearer ', '');
    if (!token) { req.user = null; return next(); }
    const decoded = verifyToken(token);
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === decoded.id);
    req.user = user || null;
    next();
  } catch (err) { req.user = null; next(); }
}

module.exports = {
  authenticate,
  optionalAuth,
  isOwner,
  isOwnerOrSelf,
  requireRole,
  verifyToken,
};