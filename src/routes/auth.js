const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../database');
const User = require('../models/User');
const { ROLES, CREATE_PERMISSIONS, REFERRAL_ROLE_MAP, getReferralRole, canCreateRole } = require('../models/roles');
const { authenticate, isOwner, isAdmin, isAdminOrOwner, getDeviceFingerprint } = require('../middleware/auth');
const { sendEmail, passwordResetTemplate } = require('../services/emailService');
const { toStringId, generateReferralLink, generateRandomPassword, hashPassword, comparePassword, pickFields, resolvePublicSiteUrl } = require('../utils/helpers');
const CONFIG = require('../config');

// v4.6 — single-device session helpers + device fingerprint
function newSessionJti() {
  try { return 'sess_' + crypto.randomBytes(12).toString('hex'); }
  catch { return 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
}

let userCache = null;
let userCacheExpiry = 0;
let referralCache = null;
let referralCacheExpiry = 0;
const CACHE_TTL = 30000;

async function getCachedUsers(forceRefresh = false) {
  if (forceRefresh || !userCache || userCacheExpiry < Date.now()) {
    userCache = await db.users.read();
    userCacheExpiry = Date.now() + CACHE_TTL;
  }
  return userCache;
}

async function getCachedReferrals(forceRefresh = false) {
  if (forceRefresh || !referralCache || referralCacheExpiry < Date.now()) {
    referralCache = await db.readJSON('referrals') || [];
    referralCacheExpiry = Date.now() + CACHE_TTL;
  }
  return referralCache;
}

function clearAuthCache() {
  userCache = null;
  userCacheExpiry = 0;
  referralCache = null;
  referralCacheExpiry = 0;
}

function clearReferralCacheOnly() {
  referralCache = null;
  referralCacheExpiry = 0;
}

function emitToAll(io, event, data) {
  if (!io) return;
  try { io.emit(event, data); } catch {}
}
function emitToUserRoom(io, userId, event, data) {
  if (!io || !userId) return;
  try { io.to('user_' + toStringId(userId)).emit(event, data); } catch {}
}

// ============================================================
// REFERRAL LINK — always recompute from current public site
// ============================================================
function buildReferralLinkFromToken(token) {
  if (!token) return '';
  const base = resolvePublicSiteUrl();
  return `${base}/login?ref=${token}`;
}

function hydrateReferralLinks(referrals) {
  if (!Array.isArray(referrals)) return [];
  return referrals.map(r => ({
    ...r,
    link: r.token ? buildReferralLinkFromToken(r.token) : r.link || '',
  }));
}

// ============================================================
// ATOMIC LOCK HELPER (referrals) — Phase 0 safety
// ============================================================

async function _withReferralsLock(fn) {
  try {
    const databaseModule = require('../database');
    if (typeof databaseModule.withWriteLock === 'function') {
      return await databaseModule.withWriteLock('referrals', fn);
    }
  } catch (_) { /* fall through */ }
  return await fn();
}

// ============================================================
// FIX-AUTH-R5 (v4.2 — PENDING-ONLY): strip used referrals
// ============================================================
function stripUsedReferrals(refs) {
  if (!Array.isArray(refs)) return [];
  return refs.filter(r => r && r.token && !r.used);
}

// ============================================================
// COOKIE HELPERS — production-ready (cross-origin safe)
// ============================================================

function buildCookieString(name, value, maxAgeSeconds, extra = '') {
  const isProd = CONFIG.IS_PRODUCTION;
  const sameSite = isProd ? 'None' : 'Lax';
  const secure = isProd ? '; Secure' : '';
  const domain = '';
  const parts = [
    `${name}=${value}`,
    'HttpOnly',
    'Path=/',
    `SameSite=${sameSite}`,
  ];
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (secure) parts.push(secure.replace(/^;\s*/, ''));
  if (domain) parts.push(`Domain=${domain}`);
  if (extra) parts.push(extra);
  return parts.filter(Boolean).join('; ');
}

function setAuthCookie(res, token) {
  const maxAge = 30 * 24 * 60 * 60;
  const cookie = buildCookieString('auth_token', token, maxAge);
  res.setHeader('Set-Cookie', cookie);
}

function clearAuthCookie(res) {
  const cookie = buildCookieString('auth_token', '', 0);
  res.setHeader('Set-Cookie', cookie);
}

let loginAttemptsCache = {};
let loginAttemptsDirty = false;
let loginAttemptsSyncTimer = null;

async function loadLoginAttempts() {
  try {
    if (Object.keys(loginAttemptsCache).length === 0) {
      const data = await db.readJSON('loginAttempts') || {};
      loginAttemptsCache = data;
    }
    return loginAttemptsCache;
  } catch { return {}; }
}

async function saveLoginAttempts(data) {
  try {
    loginAttemptsCache = data;
    loginAttemptsDirty = true;
    if (loginAttemptsSyncTimer) clearTimeout(loginAttemptsSyncTimer);
    loginAttemptsSyncTimer = setTimeout(async () => {
      if (loginAttemptsDirty) {
        await db.writeJSON('loginAttempts', loginAttemptsCache);
        loginAttemptsDirty = false;
      }
    }, 5000);
  } catch (err) {
    console.error('[Auth] Failed to save login attempts:', err.message);
  }
}

// FIX-LOGIN-FAILSAFE: login attempt tracking disabled per spec.
// Correct email+password always succeeds; no brute-force block.
async function checkLoginAttempts(_key) { return true; }
async function trackLoginAttempt(_key) { return; }

async function clearLoginAttempts(key) {
  const attempts = await loadLoginAttempts();
  delete attempts[key];
  await saveLoginAttempts(attempts);
}

router.post('/forgot-password', async (req, res) => {
  try {
    const email = req.body.email;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const allUsers = await getCachedUsers();
    const cleanEmail = email.toLowerCase().trim();
    const user = allUsers.find(u => u.email && u.email.toLowerCase().trim() === cleanEmail);

    if (!user) return res.json({ success: true, message: 'If an account exists, a new password has been sent to your email.' });

    const newPassword = generateRandomPassword();
    user.password = hashPassword(newPassword);
    user.updated_at = new Date().toISOString();
    user.passwordResetAt = new Date().toISOString();
    await db.users.write(allUsers);
    clearAuthCache();

    const userEmail = user.email;
    const userName = user.name || user.fullName || 'User';
    const html = passwordResetTemplate({ name: userName, fullName: userName }, newPassword);

    sendEmail({ to: userEmail, subject: 'Your New Password - Mega Tools', html: html })
      .then(() => console.log('[Auth] EMAIL SENT to ' + userEmail))
      .catch((e) => console.error('[Auth] EMAIL FAILED for ' + userEmail + ': ' + e.message));

    res.json({ success: true, message: 'A new password has been sent to your email. Please check your inbox and spam folder.' });
  } catch (err) {
    console.error('[Auth] Error:', err.message);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ============================================================
// SIGNUP — role from referral prefix, atomic lock, type fallback
// ============================================================

router.post('/signup', async (req, res) => {
  try {
    const { name, fullName, username, email, password, phone, facebook, profilePic, referralToken } = req.body;
    const finalName = name || fullName || username || (email ? email.split('@')[0] : 'User');

    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    if (!referralToken) return res.status(400).json({ message: 'Referral link is required' });

    const finalToken = referralToken.trim().toUpperCase();

    const result = await _withReferralsLock(async () => {
      const referrals = await db.readJSON('referrals') || [];
      const refIndex = referrals.findIndex(r => r.token === finalToken && !r.used);
      if (refIndex === -1) return { error: 'Invalid or already used referral link' };

      const ref = referrals[refIndex];
      const allUsers = await db.users.read();

      if (allUsers.find(u => u.username === (username || email.split('@')[0]))) {
        return { error: 'Username already exists' };
      }
      if (allUsers.find(u => u.email && u.email.toLowerCase().trim() === email.toLowerCase().trim())) {
        return { error: 'Email already exists' };
      }

      const prefixRole = getReferralRole(finalToken);
      const typeFallback = ref.type === 'admin' ? ROLES.ADMIN
                         : ref.type === 'owner' ? ROLES.ADMIN
                         : ROLES.USER;
      const assignedRole = prefixRole || typeFallback;
      const isAdminLike = assignedRole === ROLES.ADMIN;

      const creatorId = toStringId(ref.createdBy);
      const creator = creatorId ? allUsers.find(u => toStringId(u._id) === creatorId) : null;

      if (isAdminLike && creator && creator.role !== ROLES.OWNER) {
        return { error: 'Invalid referral role scope' };
      }

      const newUserId = 'u_' + Date.now();
      const parentId = creatorId;
      const parentUsername = creator ? (creator.username || null) : null;

      referrals.splice(refIndex, 1);
      const cleanedReferrals = referrals.filter(r => r && r.token && !r.used);
      await db.writeJSON('referrals', cleanedReferrals);

      return {
        ok: true,
        newUserId,
        parentId,
        parentUsername,
        createdBy: creatorId,
        assignedRole,
        finalToken
      };
    });

    if (result.error) {
      return res.status(400).json({ message: result.error });
    }

    clearAuthCache();

    const newUser = await User.create({
      name: finalName,
      fullName: fullName || name || finalName,
      username: username || email.split('@')[0],
      email, password,
      phone: phone || '',
      facebook: facebook || '',
      profilePic: profilePic || '',
      referralToken: result.finalToken,
      role: result.assignedRole,
      status: 'active',
      parentId: result.parentId,
      parentUsername: result.parentUsername,
      createdBy: result.createdBy,
    });
    clearAuthCache();
    res.status(201).json({ message: 'Account created and verified successfully!', user: newUser });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ============================================================
// LOGIN — FIX-LOGIN-FAILSAFE
// ============================================================
// Every persistence/cookie step is wrapped in its own try/catch
// so a failing DB write or cookie set can NEVER prevent a
// correct-credentials login from returning 200 + Set-Cookie.
// Invalid credentials still return 400 (as before).
// FIX-AUTH-RT1 (v4.7): response also includes `token` so the
// client can persist it to localStorage as a fallback when
// third-party cookies are blocked in split-deployment mode.
// ============================================================

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

    const key = email.toLowerCase().trim();

    let allUsers = [];
    try { allUsers = await getCachedUsers(true); } catch (e) {
      console.warn('[Auth] getCachedUsers failed, falling back:', e.message);
      try { allUsers = await db.users.read(); } catch (e2) {
        console.error('[Auth] user read failed:', e2.message);
        return res.status(500).json({ message: 'Server error' });
      }
    }

    const user = Array.isArray(allUsers)
      ? allUsers.find(u => u.email && u.email.toLowerCase().trim() === key)
      : null;

    if (!user) return res.status(400).json({ message: 'Invalid credentials' });
    if (user.status === 'pending') return res.status(403).json({ message: 'Account pending approval' });
    if (user.status === 'blocked') return res.status(403).json({ message: 'Account blocked. Contact support.' });

    let match = false;
    try { match = await comparePassword(password, user.password); } catch (e) {
      console.error('[Auth] comparePassword error:', e.message);
    }
    if (!match) return res.status(400).json({ message: 'Invalid credentials' });

    try { await clearLoginAttempts(key); } catch (_) {}

    const userId = toStringId(user._id);
    const jti = newSessionJti();
    const deviceFp = getDeviceFingerprint(req);

    let token;
    try {
      token = jwt.sign({ id: userId, jti }, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRY });
    } catch (e) {
      console.error('[Auth] jwt.sign failed:', e.message);
      return res.status(500).json({ message: 'Server error' });
    }

    // Non-blocking DB writes — never abort login on failure
    try { await User.setActiveSession(user._id, jti); }
    catch (e) { console.warn('[Auth] setActiveSession failed (non-fatal):', e.message); }

    if (deviceFp) {
      try { await User.update(user._id, { activeDeviceFingerprint: deviceFp }); }
      catch (e) { console.warn('[Auth] activeDeviceFingerprint write failed (non-fatal):', e.message); }
    }

    try { await User.updateLastLogin(user._id); }
    catch (e) { console.warn('[Auth] updateLastLogin failed (non-fatal):', e.message); }

    // Cookie MUST go out — cookie set failure never returns error
    try { setAuthCookie(res, token); }
    catch (e) { console.error('[Auth] setAuthCookie failed (fatal):', e.message); return res.status(500).json({ message: 'Server error' }); }

    try { clearAuthCache(); } catch (_) {}

    let sanitized;
    try { sanitized = User.sanitize(user); }
    catch (e) {
      console.error('[Auth] User.sanitize failed:', e.message);
      sanitized = {
        _id: userId,
        email: user.email,
        username: user.username,
        name: user.name,
        role: user.role,
        trackingCode: user.trackingCode,
        status: user.status
      };
    }

    // FIX-AUTH-RT1: token returned in body so client can persist to
    // localStorage (Bearer fallback for blocked third-party cookies).
    return res.json({ user: sanitized, token });
  } catch (err) {
    console.error('[Auth] Login error:', err && (err.stack || err.message || err));
    return res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// LOGOUT
// ============================================================

router.post('/logout', async (req, res) => {
  try {
    const token =
      req.cookies?.auth_token ||
      (req.headers.authorization || '').replace('Bearer ', '');
    if (token) {
      try {
        const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
        if (decoded && decoded.id && decoded.jti) {
          await User.clearActiveSession(decoded.id, decoded.jti);
        }
      } catch (_) { /* stale/expired token — clear cookie anyway */ }
    }
  } catch (err) {
    console.error('[Auth] Logout error:', err.message);
  }
  clearAuthCookie(res);
  res.json({ message: 'Logged out successfully' });
});

router.get('/me', authenticate, (req, res) => {
  res.json(User.sanitize(req.user));
});

router.put('/profile', authenticate, async (req, res) => {
  try {
    const updates = pickFields(req.body, ['name', 'fullName', 'email', 'phone', 'facebook', 'profilePic']);
    if (updates.email) {
      const allUsers = await getCachedUsers(true);
      const existing = allUsers.find(u =>
        u.email && u.email.toLowerCase().trim() === updates.email.toLowerCase().trim() &&
        toStringId(u._id) !== toStringId(req.user._id)
      );
      if (existing) return res.status(400).json({ message: 'Email already in use' });
      updates.email = updates.email.toLowerCase().trim();
    }
    const updated = await User.update(req.user._id, updates);
    if (!updated) return res.status(404).json({ message: 'User not found' });
    clearAuthCache();
    res.json({ message: 'Profile updated', user: updated });
  } catch (err) {
    console.error('[Auth] Profile error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.put('/password', authenticate, async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword) return res.status(400).json({ message: 'New password is required' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

    await User.updatePassword(req.user._id, newPassword);
    clearAuthCache();
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('[Auth] Password error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GENERATE REFERRAL LINK — OWNER→ADMIN, ADMIN→USER
// ============================================================

router.post('/generate-referral-link', authenticate, isAdminOrOwner, async (req, res) => {
  try {
    const { count = 1 } = req.body;
    const countNum = Math.min(parseInt(count) || 1, 10);
    const isOwnerReq = req.user.role === ROLES.OWNER;

    const resolvedTarget = isOwnerReq ? 'admin' : 'user';
    const prefix = resolvedTarget === 'admin' ? 'ADM' : 'REF';

    const links = await _withReferralsLock(async () => {
      const rawReferrals = await db.readJSON('referrals') || [];
      const referrals = stripUsedReferrals(rawReferrals);
      const existingTokens = referrals.map(r => r.token);
      const created = [];

      for (let i = 0; i < countNum; i++) {
        const { token, link } = generateReferralLink(prefix, existingTokens);
        existingTokens.push(token);
        created.push({ token, link });
        referrals.push({
          token,
          link,
          type: resolvedTarget,
          targetRole: resolvedTarget,
          used: false,
          usedBy: null,
          usedAt: null,
          usedByRole: null,
          createdBy: toStringId(req.user._id),
          createdByRole: req.user.role,
          created_at: new Date().toISOString()
        });
      }

      await db.writeJSON('referrals', referrals);
      return created;
    });

    clearReferralCacheOnly();

    res.json({
      success: true,
      links,
      targetRole: resolvedTarget,
      message: `${links.length} ${resolvedTarget} referral link(s) generated`
    });
  } catch (err) {
    console.error('[Auth] Generate referral link error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// LIST REFERRALS
// ============================================================

router.get('/referrals', authenticate, async (req, res) => {
  try {
    const rawReferrals = await db.readJSON('referrals') || [];
    const pendingOnly = stripUsedReferrals(rawReferrals);

    if (pendingOnly.length !== rawReferrals.length) {
      try {
        await _withReferralsLock(async () => {
          const fresh = await db.readJSON('referrals') || [];
          const cleaned = stripUsedReferrals(fresh);
          await db.writeJSON('referrals', cleaned);
        });
        clearReferralCacheOnly();
      } catch (e) {
        console.error('[Auth] Referral auto-cleanup error:', e.message);
      }
    }

    let referrals = pendingOnly;
    if (req.user.role !== ROLES.OWNER) {
      referrals = referrals.filter(r => r.createdBy === toStringId(req.user._id));
    }
    referrals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    referrals = hydrateReferralLinks(referrals);

    res.json(referrals);
  } catch (err) {
    console.error('[Auth] Referrals error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/check-owner/:username', async (req, res) => {
  try {
    const allUsers = await getCachedUsers();
    const user = allUsers.find(u => u.username === req.params.username && u.role === ROLES.OWNER && u.status === 'active');
    if (user) {
      return res.json({
        exists: true,
        ownerName: user.name || user.username,
        ownerUsername: user.username,
        ownerId: toStringId(user._id)
      });
    }
    res.status(404).json({ exists: false });
  } catch (err) {
    console.error('[Auth] Check owner error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// ADMIN SCOPE HELPER
// ============================================================

async function canManageUser(reqUser, targetUser) {
  if (!reqUser || !targetUser) return false;
  const reqId = toStringId(reqUser._id);

  if (reqUser.role === ROLES.OWNER) return true;

  if (reqUser.role === ROLES.ADMIN) {
    if (targetUser.role === ROLES.OWNER) return false;
    if (targetUser.role === ROLES.ADMIN) return false;
    return toStringId(targetUser.parentId) === reqId;
  }

  return false;
}

router.patch('/block/:id', authenticate, isAdminOrOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);
    const targetId = toStringId(req.params.id);
    const userIndex = allUsers.findIndex(u => toStringId(u._id) === targetId);
    if (userIndex === -1) return res.status(404).json({ message: 'User not found' });

    const targetUser = allUsers[userIndex];
    if (targetUser.role === ROLES.OWNER) return res.status(403).json({ message: 'Cannot block Owner' });

    if (!(await canManageUser(req.user, targetUser))) {
      return res.status(403).json({ message: 'You cannot manage this user' });
    }

    allUsers[userIndex].status = 'blocked';
    allUsers[userIndex].updated_at = new Date().toISOString();
    allUsers[userIndex].activeSessionId = null;
    allUsers[userIndex].activeSessionIssuedAt = null;
    allUsers[userIndex].activeDeviceFingerprint = null;
    await db.users.write(allUsers);
    clearAuthCache();

    const io = req.app.get('io');
    emitToAll(io, 'userBlocked', { _id: targetId, status: 'blocked' });

    res.json({ success: true, message: 'User blocked', user: { _id: targetId, status: 'blocked' } });
  } catch (err) {
    console.error('[Auth] Block error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/unblock/:id', authenticate, isAdminOrOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);
    const targetId = toStringId(req.params.id);
    const userIndex = allUsers.findIndex(u => toStringId(u._id) === targetId);
    if (userIndex === -1) return res.status(404).json({ message: 'User not found' });

    const targetUser = allUsers[userIndex];

    if (!(await canManageUser(req.user, targetUser))) {
      return res.status(403).json({ message: 'You cannot manage this user' });
    }

    allUsers[userIndex].status = 'active';
    allUsers[userIndex].updated_at = new Date().toISOString();
    await db.users.write(allUsers);
    clearAuthCache();

    const io = req.app.get('io');
    emitToAll(io, 'userUnblocked', { _id: targetId, status: 'active' });

    res.json({ success: true, message: 'User unblocked', user: { _id: targetId, status: 'active' } });
  } catch (err) {
    console.error('[Auth] Unblock error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/user/:id', authenticate, isAdminOrOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);
    const targetId = toStringId(req.params.id);
    const userIndex = allUsers.findIndex(u => toStringId(u._id) === targetId);
    if (userIndex === -1) return res.status(404).json({ message: 'User not found' });

    const targetUser = allUsers[userIndex];
    if (targetUser.role === ROLES.OWNER) return res.status(403).json({ message: 'Cannot delete Owner' });

    if (!(await canManageUser(req.user, targetUser))) {
      return res.status(403).json({ message: 'You cannot manage this user' });
    }

    const deletedUser = allUsers.splice(userIndex, 1)[0];
    await db.users.write(allUsers);
    clearAuthCache();

    try {
      const tc = deletedUser.trackingCode || '';
      if (tc) {
        const allSessions = await db.sessions.read();
        const filtered = allSessions.filter(s => {
          const sCode = s.trackingCode || '';
          return !(sCode === tc || sCode.startsWith(tc + '_'));
        });
        if (filtered.length !== allSessions.length) {
          await db.sessions.write(filtered);
        }
      }
    } catch (e) {
      console.error('[Auth] Session cleanup on user delete failed:', e.message);
    }

    const io = req.app.get('io');
    emitToAll(io, 'userDeleted', { _id: targetId, email: deletedUser.email });

    res.json({
      success: true,
      message: 'User deleted',
      user: { _id: targetId, email: deletedUser.email }
    });
  } catch (err) {
    console.error('[Auth] Delete user error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/impersonate/:id', authenticate, isOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);
    const targetId = toStringId(req.params.id);
    const targetUser = allUsers.find(u => toStringId(u._id) === targetId);
    if (!targetUser) return res.status(404).json({ message: 'User not found' });
    if (targetUser.status === 'blocked') return res.status(403).json({ message: 'Cannot impersonate blocked user' });

    const jti = newSessionJti();
    const deviceFp = getDeviceFingerprint(req);
    const token = jwt.sign(
      { id: targetId, impersonatedBy: toStringId(req.user._id), jti },
      CONFIG.JWT_SECRET,
      { expiresIn: '1h' }
    );
    await User.setActiveSession(targetUser._id, jti);
    if (deviceFp) {
      try { await User.update(targetUser._id, { activeDeviceFingerprint: deviceFp }); } catch (_) {}
    }
    clearAuthCache();
    res.json({ success: true, token, user: User.sanitize(targetUser) });
  } catch (err) {
    console.error('[Auth] Impersonate error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users-list', authenticate, isAdminOrOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);

    let scopedUsers = allUsers;
    if (req.user.role === ROLES.ADMIN) {
      const reqId = toStringId(req.user._id);
      scopedUsers = allUsers.filter(u => {
        const uid = toStringId(u._id);
        if (uid === reqId) return false;
        if (u.role === ROLES.OWNER || u.role === ROLES.ADMIN) return false;
        return toStringId(u.parentId) === reqId;
      });
    }

    const byId = new Map();
    for (const u of allUsers) byId.set(toStringId(u._id), u);

    const users = scopedUsers.map(u => {
      const creatorId = toStringId(u.createdBy || u.parentId);
      const creator = creatorId ? byId.get(creatorId) : null;
      const createdByName = creator
        ? (creator.name || creator.username || creator.email || '—')
        : (u.parentUsername || '—');

      return {
        _id: toStringId(u._id),
        name: u.name || u.fullName || u.username || 'Unknown',
        fullName: u.fullName || u.name || '',
        username: u.username || '',
        email: u.email || '',
        role: u.role || 'user',
        trackingCode: u.trackingCode || '',
        referralToken: u.referralToken || '',
        phone: u.phone || '',
        facebook: u.facebook || '',
        profilePic: u.profilePic || '',
        parentId: u.parentId || null,
        parentUsername: u.parentUsername || null,
        createdBy: u.createdBy || null,
        createdByName,
        status: u.status || 'active',
        isOnline: !!u.isOnline,
        lastSeen: u.lastSeen || null,
        created_at: u.created_at || '',
        updated_at: u.updated_at || '',
        lastLogin: u.lastLogin || null,
      };
    });
    res.json(users);
  } catch (err) {
    console.error('[Auth] Users list error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users-map', authenticate, async (req, res) => {
  try {
    const allUsers = await getCachedUsers();
    const map = {};
    allUsers.forEach(u => {
      const key = u.trackingCode || toStringId(u._id);
      map[key] = {
        _id: toStringId(u._id),
        name: u.name || u.fullName || u.username || 'Unknown',
        profilePic: u.profilePic || null,
        role: u.role || 'user',
        email: u.email || '',
        status: u.status || 'active',
        createdBy: u.createdBy || null,
        parentId: u.parentId || null,
        created_at: u.created_at || '',
        referralToken: u.referralToken || '',
        trackingCode: u.trackingCode || '',
        username: u.username || '',
        phone: u.phone || '',
        facebook: u.facebook || '',
      };
    });
    res.json(map);
  } catch (err) {
    console.error('[Auth] Users map error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;