const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../database');
const User = require('../models/User');
const { ROLES, CREATE_PERMISSIONS, REFERRAL_ROLE_MAP, getReferralRole } = require('../models/roles');
const { authenticate, isTeamManager } = require('../middleware/auth');
const { sendEmail, passwordResetTemplate } = require('../services/emailService');
const { toStringId, generateReferralCode, generateRandomPassword, hashPassword, comparePassword, pickFields } = require('../utils/helpers');
const CONFIG = require('../config');

function setAuthCookie(res, token, isTrial) {
  isTrial = isTrial || false;
  const maxAge = isTrial ? CONFIG.TRIAL_DURATION_MS : 7 * 24 * 60 * 60 * 1000;
  if (CONFIG.IS_PRODUCTION) {
    res.setHeader('Set-Cookie', `auth_token=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge / 1000}`);
  } else {
    res.cookie('auth_token', token, { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge });
  }
}

function clearAuthCookie(res) {
  if (CONFIG.IS_PRODUCTION) {
    res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0');
  } else {
    res.clearCookie('auth_token', { path: '/' });
  }
}

// ============================================================
// LOGIN ATTEMPTS TRACKER — Persisted to JSON for Render survival
// ============================================================

async function loadLoginAttempts() {
  try {
    return await db.readJSON('loginAttempts') || {};
  } catch {
    return {};
  }
}

async function saveLoginAttempts(data) {
  try {
    await db.writeJSON('loginAttempts', data);
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
    if (elapsed < CONFIG.LOGIN_ATTEMPTS_WINDOW_MS) {
      return false; // blocked
    }
    // window expired, reset
    delete attempts[key];
    await saveLoginAttempts(attempts);
  }
  return true;
}

async function trackLoginAttempt(key) {
  const attempts = await loadLoginAttempts();
  if (!attempts[key]) {
    attempts[key] = { count: 1, firstAttempt: Date.now() };
  } else {
    attempts[key].count++;
  }
  await saveLoginAttempts(attempts);
}

async function clearLoginAttempts(key) {
  const attempts = await loadLoginAttempts();
  delete attempts[key];
  await saveLoginAttempts(attempts);
}

// ============================================================
// FORGOT PASSWORD — BACKGROUND EMAIL (UI GETS FAST RESPONSE)
// ============================================================
router.post('/forgot-password', async (req, res) => {
  try {
    const email = req.body.email;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const allUsers = await db.users.read();
    const cleanEmail = email.toLowerCase().trim();
    const user = allUsers.find(u => u.email && u.email.toLowerCase().trim() === cleanEmail);

    if (!user) {
      return res.json({ success: true, message: 'If an account exists, a new password has been sent to your email.' });
    }

    const newPassword = generateRandomPassword();
    user.password = hashPassword(newPassword);
    user.updated_at = new Date().toISOString();
    user.passwordResetAt = new Date().toISOString();
    await db.users.write(allUsers);

    const userEmail = user.email;
    const userName = user.name || user.fullName || 'User';
    const html = passwordResetTemplate({ name: userName, fullName: userName }, newPassword);

    res.json({
      success: true,
      message: 'A new password has been sent to your email. Please check your inbox and spam folder.',
    });

    setTimeout(function() {
      sendEmail({ to: userEmail, subject: 'Your New Password - Mega Tools', html: html })
        .then(function(r) { console.log('[Auth] EMAIL SENT to ' + userEmail); })
        .catch(function(e) { console.error('[Auth] EMAIL FAILED for ' + userEmail + ': ' + e.message); });
    }, 1000);

  } catch (err) {
    console.error('[Auth] Error:', err.message);
    return res.status(500).json({ message: 'Server error. Please try again.' });
  }
});

// ============================================================
// SIGNUP
// ============================================================
router.post('/signup', async (req, res) => {
  try {
    const { name, fullName, username, email, password, phone, facebook, profilePic, referralCode, isTrial, trialRole } = req.body;
    const finalName = name || fullName || username || (email ? email.split('@')[0] : 'User');
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required' });
    if (password.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    const finalReferralCode = (referralCode || '').trim().toUpperCase();
    if (!isTrial && !finalReferralCode) return res.status(400).json({ message: 'Referral code is required' });
    const allUsers = await db.users.read();
    if (allUsers.find(u => u.username === (username || email.split('@')[0]))) return res.status(400).json({ message: 'Username already exists' });
    if (allUsers.find(u => u.email && u.email.toLowerCase().trim() === email.toLowerCase().trim())) return res.status(400).json({ message: 'Email already exists' });
    const newUserId = 'u_' + Date.now();
    let role = ROLES.USER, parentId = null, createdBy = null, parentUsername = null;
    if (isTrial) { role = ['admin', 'team_manager', 'user'].includes(trialRole) ? trialRole : ROLES.USER; }
    else {
      const referrals = await db.readJSON('referrals');
      const ref = referrals.find(r => r.code === finalReferralCode && !r.used);
      if (!ref) return res.status(400).json({ message: 'Invalid or already used referral code' });
      const mappedRole = getReferralRole(finalReferralCode);
      if (mappedRole === ROLES.OWNER) return res.status(403).json({ message: 'Owner accounts cannot be created via referral' });
      role = mappedRole || ROLES.USER;
      parentId = toStringId(ref.createdBy); createdBy = toStringId(ref.createdBy);
      if (parentId) { const parent = allUsers.find(u => toStringId(u._id) === parentId); if (parent) { parentUsername = parent.username || null; if (!(CREATE_PERMISSIONS[parent.role] || []).includes(role)) return res.status(403).json({ message: 'Cannot create this role' }); } }
      ref.used = true; ref.usedBy = newUserId; ref.usedAt = new Date().toISOString();
      await db.writeJSON('referrals', referrals);
    }
    const userData = { name: finalName, fullName: fullName || name || finalName, username: username || email.split('@')[0], email, password, phone: phone || '', facebook: facebook || '', profilePic: profilePic || '', referralCode: isTrial ? '' : finalReferralCode, role, status: isTrial ? 'trial' : 'active', parentId, parentUsername, createdBy, isTrial: isTrial || false, trialRole: isTrial ? role : null };
    const newUser = await User.create(userData);
    res.status(201).json({ message: isTrial ? 'Free trial activated!' : 'Account created successfully!', user: newUser });
  } catch (err) { console.error('[Auth] Signup error:', err); res.status(500).json({ message: err.message || 'Server error' }); }
});

// ============================================================
// LOGIN — With persisted attempt tracking
// ============================================================

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

    const key = email.toLowerCase().trim();

    // Check if blocked
    const allowed = await checkLoginAttempts(key);
    if (!allowed) {
      const attempts = await loadLoginAttempts();
      const elapsed = Date.now() - attempts[key].firstAttempt;
      const remaining = Math.ceil((CONFIG.LOGIN_ATTEMPTS_WINDOW_MS - elapsed) / 60000);
      return res.status(429).json({ message: `Too many attempts. Try again in ${remaining} min.` });
    }

    const allUsers = await db.users.read();
    const user = allUsers.find(u => u.email && u.email.toLowerCase().trim() === key);

    if (!user) {
      await trackLoginAttempt(key);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    if (user.status === 'pending') return res.status(403).json({ message: 'Account pending approval' });
    if (user.status === 'blocked') return res.status(403).json({ message: 'Account blocked. Contact support.' });

    const match = await comparePassword(password, user.password);
    if (!match) {
      await trackLoginAttempt(key);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    // Success — clear attempts
    await clearLoginAttempts(key);

    const userId = toStringId(user._id);
    const token = jwt.sign({ id: userId }, CONFIG.JWT_SECRET, { expiresIn: user.isTrial ? CONFIG.JWT_TRIAL_EXPIRY : CONFIG.JWT_EXPIRY });
    setAuthCookie(res, token, user.isTrial);
    await User.updateLastLogin(user._id);
    res.json({ user: User.sanitize(user) });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/logout', (req, res) => { clearAuthCookie(res); res.json({ message: 'Logged out successfully' }); });
router.get('/me', authenticate, (req, res) => { res.json(User.sanitize(req.user)); });
router.put('/profile', authenticate, async (req, res) => { try { const updates = pickFields(req.body, ['name', 'fullName', 'email', 'phone', 'facebook', 'profilePic', 'referralCode']); if (updates.email) { const allUsers = await db.users.read(); const existing = allUsers.find(u => u.email && u.email.toLowerCase().trim() === updates.email.toLowerCase().trim() && toStringId(u._id) !== toStringId(req.user._id)); if (existing) return res.status(400).json({ message: 'Email already in use' }); updates.email = updates.email.toLowerCase().trim(); } const updated = await User.update(req.user._id, updates); if (!updated) return res.status(404).json({ message: 'User not found' }); res.json({ message: 'Profile updated', user: updated }); } catch (err) { console.error('[Auth] Profile error:', err); res.status(500).json({ message: err.message || 'Server error' }); } });
router.put('/password', authenticate, async (req, res) => { try { const { currentPassword, newPassword } = req.body; if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Both passwords required' }); if (newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' }); const match = await comparePassword(currentPassword, req.user.password); if (!match) return res.status(400).json({ message: 'Current password is incorrect' }); await User.updatePassword(req.user._id, newPassword); res.json({ message: 'Password updated successfully' }); } catch (err) { console.error('[Auth] Password error:', err); res.status(500).json({ message: 'Server error' }); } });
router.post('/generate-referral', authenticate, isTeamManager, async (req, res) => { try { const { count, type } = req.body; const userRole = req.user.role; let finalType; if (userRole === ROLES.OWNER) finalType = ['owner', 'admin', 'team_manager', 'user'].includes(type) ? type : 'user'; else if (userRole === ROLES.ADMIN) finalType = ['team_manager', 'user'].includes(type) ? type : 'user'; else finalType = 'user'; const prefix = finalType === 'owner' ? 'OWN-' : finalType === 'admin' ? 'ADM-' : finalType === 'team_manager' ? 'TM-' : 'USR-'; const referrals = await db.readJSON('referrals'); const existingCodes = referrals.map(r => r.code); const codes = []; const countNum = Math.min(parseInt(count) || 1, 50); for (let i = 0; i < countNum; i++) { const code = await generateReferralCode(prefix, existingCodes); codes.push(code); existingCodes.push(code); } codes.forEach(code => { referrals.push({ code, type: finalType, used: false, usedBy: null, usedAt: null, createdBy: toStringId(req.user._id), created_at: new Date().toISOString() }); }); await db.writeJSON('referrals', referrals); res.json({ success: true, codes, message: `${codes.length} referral code(s) generated` }); } catch (err) { console.error('[Auth] Generate referral error:', err); res.status(500).json({ message: 'Server error' }); } });
router.get('/referrals', authenticate, async (req, res) => { try { let referrals = await db.readJSON('referrals'); if (req.user.role !== ROLES.OWNER || req.user.isTrial) { referrals = referrals.filter(r => r.createdBy === toStringId(req.user._id)); } referrals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); res.json(referrals); } catch (err) { console.error('[Auth] Referrals error:', err); res.status(500).json({ message: 'Server error' }); } });
router.get('/users-map', authenticate, async (req, res) => { try { const allUsers = await db.users.read(); const map = {}; allUsers.forEach(u => { if (u.trackingCode) map[u.trackingCode] = { name: u.name || u.fullName || u.username || 'Unknown', profilePic: u.profilePic || null, role: u.role || 'user', email: u.email || '', status: u.status || 'active' }; }); res.json(map); } catch (err) { console.error('[Auth] Users map error:', err); res.status(500).json({ message: 'Server error' }); } });
router.get('/check-moderator/:username', async (req, res) => { try { const allUsers = await db.users.read(); const user = allUsers.find(u => u.username === req.params.username && u.role === ROLES.TEAM_MANAGER && u.status === 'active'); if (user) return res.json({ exists: true, managerName: user.name || user.username, managerUsername: user.username, managerId: toStringId(user._id) }); res.status(404).json({ exists: false }); } catch (err) { console.error('[Auth] Check moderator error:', err); res.status(500).json({ message: 'Server error' }); } });

module.exports = router;