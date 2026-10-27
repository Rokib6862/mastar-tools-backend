const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database');
const User = require('../models/User');
const { ROLES, CREATE_PERMISSIONS, REFERRAL_ROLE_MAP, getReferralRole } = require('../models/roles');
const { authenticate, isOwner } = require('../middleware/auth');
const { sendEmail, passwordResetTemplate } = require('../services/emailService');
const { toStringId, generateReferralLink, generateRandomPassword, hashPassword, comparePassword, pickFields, resolvePublicSiteUrl } = require('../utils/helpers');
const CONFIG = require('../config');

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

async function checkLoginAttempts(key) {
  const attempts = await loadLoginAttempts();
  const entry = attempts[key];
  if (!entry) return true;
  if (entry.count >= CONFIG.LOGIN_ATTEMPTS_MAX) {
    const elapsed = Date.now() - entry.firstAttempt;
    if (elapsed < CONFIG.LOGIN_ATTEMPTS_WINDOW_MS) return false;
    delete attempts[key];
    await saveLoginAttempts(attempts);
  }
  return true;
}

async function trackLoginAttempt(key) {
  const attempts = await loadLoginAttempts();
  if (!attempts[key]) attempts[key] = { count: 1, firstAttempt: Date.now() };
  else attempts[key].count++;
  await saveLoginAttempts(attempts);
}

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

router.post('/signup', async (req, res) => {
  try {
    const { name, fullName, username, email, password, phone, facebook, profilePic, referralToken } = req.body;
    const finalName = name || fullName || username || (email ? email.split('@')[0] : 'User');

    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    if (!referralToken) return res.status(400).json({ message: 'Referral link is required' });

    const finalToken = referralToken.trim().toUpperCase();
    const referrals = await getCachedReferrals(true);
    const ref = referrals.find(r => r.token === finalToken && !r.used);
    if (!ref) return res.status(400).json({ message: 'Invalid or already used referral link' });

    const allUsers = await getCachedUsers(true);
    if (allUsers.find(u => u.username === (username || email.split('@')[0]))) {
      return res.status(400).json({ message: 'Username already exists' });
    }
    if (allUsers.find(u => u.email && u.email.toLowerCase().trim() === email.toLowerCase().trim())) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    const newUserId = 'u_' + Date.now();
    const parentId = toStringId(ref.createdBy);
    let parentUsername = null;
    const createdBy = toStringId(ref.createdBy);

    if (parentId) {
      const parent = allUsers.find(u => toStringId(u._id) === parentId);
      if (parent) parentUsername = parent.username || null;
    }

    ref.used = true;
    ref.usedBy = newUserId;
    ref.usedAt = new Date().toISOString();
    await db.writeJSON('referrals', referrals);
    clearAuthCache();

    const newUser = await User.create({
      name: finalName,
      fullName: fullName || name || finalName,
      username: username || email.split('@')[0],
      email, password,
      phone: phone || '',
      facebook: facebook || '',
      profilePic: profilePic || '',
      referralToken: finalToken,
      role: ROLES.USER,
      status: 'active',
      parentId, parentUsername, createdBy
    });
    clearAuthCache();
    res.status(201).json({ message: 'Account created and verified successfully!', user: newUser });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

    const key = email.toLowerCase().trim();
    const allowed = await checkLoginAttempts(key);
    if (!allowed) {
      const attempts = await loadLoginAttempts();
      const elapsed = Date.now() - attempts[key].firstAttempt;
      const remaining = Math.ceil((CONFIG.LOGIN_ATTEMPTS_WINDOW_MS - elapsed) / 60000);
      return res.status(429).json({ message: `Too many attempts. Try again in ${remaining} min.` });
    }

    const allUsers = await getCachedUsers(true);
    const user = allUsers.find(u => u.email && u.email.toLowerCase().trim() === key);

    if (!user) { await trackLoginAttempt(key); return res.status(400).json({ message: 'Invalid credentials' }); }
    if (user.status === 'pending') return res.status(403).json({ message: 'Account pending approval' });
    if (user.status === 'blocked') return res.status(403).json({ message: 'Account blocked. Contact support.' });

    const match = await comparePassword(password, user.password);
    if (!match) { await trackLoginAttempt(key); return res.status(400).json({ message: 'Invalid credentials' }); }

    await clearLoginAttempts(key);
    const userId = toStringId(user._id);
    const token = jwt.sign({ id: userId }, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRY });

    setAuthCookie(res, token);
    await User.updateLastLogin(user._id);
    clearAuthCache();
    res.json({ user: User.sanitize(user) });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
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

router.post('/generate-referral-link', authenticate, isOwner, async (req, res) => {
  try {
    const { count = 1 } = req.body;
    const referrals = await getCachedReferrals(true);
    const existingTokens = referrals.filter(r => r.token).map(r => r.token);
    const links = [];
    const countNum = Math.min(parseInt(count) || 1, 10);

    for (let i = 0; i < countNum; i++) {
      const { token, link } = generateReferralLink('REF', existingTokens);
      existingTokens.push(token);
      links.push({ token, link });
      referrals.push({
        token, link, used: false, usedBy: null, usedAt: null,
        createdBy: toStringId(req.user._id),
        created_at: new Date().toISOString()
      });
    }

    await db.writeJSON('referrals', referrals);
    clearAuthCache();
    res.json({ success: true, links, message: `${links.length} referral link(s) generated` });
  } catch (err) {
    console.error('[Auth] Generate referral link error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/referrals', authenticate, async (req, res) => {
  try {
    let referrals = await getCachedReferrals();
    referrals = referrals.filter(r => r.token);
    if (req.user.role !== ROLES.OWNER) {
      referrals = referrals.filter(r => r.createdBy === toStringId(req.user._id));
    }
    referrals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Always recompute link from current public site URL
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

router.patch('/block/:id', authenticate, isOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);
    const targetId = toStringId(req.params.id);
    const userIndex = allUsers.findIndex(u => toStringId(u._id) === targetId);
    if (userIndex === -1) return res.status(404).json({ message: 'User not found' });
    if (allUsers[userIndex].role === ROLES.OWNER) return res.status(403).json({ message: 'Cannot block Owner' });

    allUsers[userIndex].status = 'blocked';
    allUsers[userIndex].updated_at = new Date().toISOString();
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

router.patch('/unblock/:id', authenticate, isOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);
    const targetId = toStringId(req.params.id);
    const userIndex = allUsers.findIndex(u => toStringId(u._id) === targetId);
    if (userIndex === -1) return res.status(404).json({ message: 'User not found' });

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

router.delete('/user/:id', authenticate, isOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);
    const targetId = toStringId(req.params.id);
    const userIndex = allUsers.findIndex(u => toStringId(u._id) === targetId);
    if (userIndex === -1) return res.status(404).json({ message: 'User not found' });
    if (allUsers[userIndex].role === ROLES.OWNER) return res.status(403).json({ message: 'Cannot delete Owner' });

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

    const token = jwt.sign(
      { id: targetId, impersonatedBy: toStringId(req.user._id) },
      CONFIG.JWT_SECRET,
      { expiresIn: '1h' }
    );
    res.json({ success: true, token, user: User.sanitize(targetUser) });
  } catch (err) {
    console.error('[Auth] Impersonate error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/users-list', authenticate, isOwner, async (req, res) => {
  try {
    const allUsers = await getCachedUsers(true);

    const byId = new Map();
    for (const u of allUsers) byId.set(toStringId(u._id), u);

    const users = allUsers.map(u => {
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