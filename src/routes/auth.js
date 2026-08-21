// ============================================================
// MEGA TOOLS — AUTH ROUTES (v3.0 Production Hardened)
// ============================================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../database');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate, isOwner } = require('../middleware/auth');
const { toStringId, generateReferralLink, comparePassword, pickFields } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// AUTH COOKIE HELPERS
// ============================================================

function setAuthCookie(res, token) {
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
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
// LOGIN ATTEMPT TRACKING (Brute Force Protection)
// ============================================================

async function loadLoginAttempts() {
  try { return await db.loginAttempts.read() || {}; }
  catch { return {}; }
}

async function saveLoginAttempts(data) {
  try { await db.loginAttempts.write(data); }
  catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Auth] Failed to save login attempts:', err.message);
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
  if (!attempts[key]) { attempts[key] = { count: 1, firstAttempt: Date.now() }; }
  else { attempts[key].count++; }
  await saveLoginAttempts(attempts);
}

async function clearLoginAttempts(key) {
  const attempts = await loadLoginAttempts();
  delete attempts[key];
  await saveLoginAttempts(attempts);
}

// ============================================================
// LOGIN
// ============================================================

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

    const allUsers = await db.users.read();
    const user = allUsers.find(u => u.email && u.email.toLowerCase().trim() === key);
    if (!user) { await trackLoginAttempt(key); return res.status(400).json({ message: 'Invalid credentials' }); }
    if (user.status === 'pending') return res.status(403).json({ message: 'Account pending approval' });
    if (user.status === 'blocked') return res.status(403).json({ message: 'Account blocked.' });

    const match = await comparePassword(password, user.password);
    if (!match) { await trackLoginAttempt(key); return res.status(400).json({ message: 'Invalid credentials' }); }

    await clearLoginAttempts(key);

    const userId = toStringId(user._id);
    const token = jwt.sign({ id: userId }, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRY });
    setAuthCookie(res, token);
    await User.updateLastLogin(user._id);
    res.json({ user: User.sanitize(user) });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Auth] Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// LOGOUT
// ============================================================

router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ message: 'Logged out successfully' });
});

// ============================================================
// CURRENT USER
// ============================================================

router.get('/me', authenticate, (req, res) => {
  res.json(User.sanitize(req.user));
});

// ============================================================
// UPDATE PROFILE
// ============================================================

router.put('/profile', authenticate, async (req, res) => {
  try {
    const updates = pickFields(req.body, ['name', 'fullName', 'email', 'phone', 'facebook', 'profilePic']);
    if (updates.email) {
      const allUsers = await db.users.read();
      const existing = allUsers.find(u =>
        u.email && u.email.toLowerCase().trim() === updates.email.toLowerCase().trim() &&
        toStringId(u._id) !== toStringId(req.user._id)
      );
      if (existing) return res.status(400).json({ message: 'Email already in use' });
      updates.email = updates.email.toLowerCase().trim();
    }
    const updated = await User.update(req.user._id, updates);
    if (!updated) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'Profile updated', user: updated });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Auth] Profile error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ============================================================
// CHANGE PASSWORD
// ============================================================

router.put('/password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Both passwords required' });
    if (newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });

    const match = await comparePassword(currentPassword, req.user.password);
    if (!match) return res.status(400).json({ message: 'Current password is incorrect' });

    await User.updatePassword(req.user._id, newPassword);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Auth] Password error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GENERATE REFERRAL LINK (Owner Only)
// ============================================================

router.post('/generate-referral', authenticate, isOwner, async (req, res) => {
  try {
    const countNum = Math.min(parseInt(req.body?.count) || 1, 50);
    const referrals = await db.referrals.read();
    const existingTokens = referrals.map(r => r.token);
    const links = [];

    for (let i = 0; i < countNum; i++) {
      const { token, link } = generateReferralLink('REF', existingTokens);
      existingTokens.push(token);
      links.push({
        token,
        link,
        type: 'user',
        used: false,
        usedBy: null,
        usedAt: null,
        createdBy: toStringId(req.user._id),
        created_at: new Date().toISOString(),
      });
    }

    referrals.push(...links);
    await db.referrals.write(referrals);

    res.json({
      success: true,
      links: links.map(l => ({ token: l.token, link: l.link, used: l.used, created_at: l.created_at })),
      message: `${links.length} referral link(s) generated`,
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Auth] Generate referral error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GET REFERRAL LINKS
// ============================================================

router.get('/referrals', authenticate, async (req, res) => {
  try {
    let referrals = await db.referrals.read();
    if (req.user.role !== ROLES.OWNER) {
      referrals = referrals.filter(r => r.createdBy === toStringId(req.user._id));
    }
    referrals.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(referrals);
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Auth] Referrals error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// USERS MAP (for tracking code lookup)
// ============================================================

router.get('/users-map', authenticate, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const map = {};
    allUsers.forEach(u => {
      if (u.trackingCode) {
        map[u.trackingCode] = {
          name: u.name || u.fullName || u.username || 'Unknown',
          profilePic: u.profilePic || null,
          role: u.role || 'user',
          email: u.email || '',
          status: u.status || 'active',
        };
      }
    });
    res.json(map);
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Auth] Users map error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;