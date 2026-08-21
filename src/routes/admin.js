// ============================================================
// MEGA TOOLS — ADMIN ROUTES (v3.0 Production Hardened)
// ============================================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../database');
const User = require('../models/User');
const { ROLES } = require('../models/roles');
const { authenticate, isOwner } = require('../middleware/auth');
const { toStringId, generateTrackingCode, paginate } = require('../utils/helpers');
const CONFIG = require('../config');

function emitMenuEvent(io, groupId, action) {
  if (io) {
    io.emit('menuUpdated', {
      groupId: groupId || 'all',
      action: action || 'updated',
      timestamp: new Date().toISOString(),
    });
  }
}

function setAuthCookie(res, token) {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  if (CONFIG.IS_PRODUCTION) {
    res.setHeader('Set-Cookie', `auth_token=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge / 1000}`);
  } else {
    res.cookie('auth_token', token, { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge });
  }
}

// ============================================================
// CLEAN DATABASE — Owner-only emergency cleanup
// ============================================================

router.post('/clean-db', authenticate, isOwner, async (req, res) => {
  try {
    const sessions = await db.sessions.read();
    const logs = await db.webhook_logs.read();
    const routeLogs = await db.routeLogs.read();

    await db.sessions.write([]);
    await db.webhook_logs.write([]);
    await db.routeLogs.write([]);

    res.json({
      success: true,
      message: 'Database cleaned!',
      removed: {
        sessions: Array.isArray(sessions) ? sessions.length : 0,
        webhook_logs: Array.isArray(logs) ? logs.length : 0,
        routeLogs: Array.isArray(routeLogs) ? routeLogs.length : 0
      }
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Clean DB error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// USER LIST (Owner sees all)
// ============================================================

router.get('/users', authenticate, isOwner, async (req, res) => {
  try {
    const { search, role, status, page, limit } = req.query;
    const allUsers = await db.users.read();

    let users = allUsers;

    if (search) {
      const q = search.toLowerCase();
      users = users.filter(u =>
        (u.name || '').toLowerCase().includes(q) ||
        (u.fullName || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        (u.trackingCode || '').toLowerCase().includes(q)
      );
    }

    if (role && role !== 'all') users = users.filter(u => u.role === role);
    if (status && status !== 'all') users = users.filter(u => u.status === status);

    users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || CONFIG.USERS_PER_PAGE;
    const result = paginate(users, pageNum, limitNum);

    res.json({
      users: result.data.map(User.sanitize),
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Get users error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// PENDING USERS
// ============================================================

router.get('/users/pending', authenticate, isOwner, async (req, res) => {
  try {
    const pending = await User.findMany({ status: 'pending' });
    res.json(pending);
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Pending users error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// USER COUNT (for a specific parent)
// ============================================================

router.get('/users/count/:id', authenticate, isOwner, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const count = allUsers.filter(u => u.parentId === req.params.id).length;
    res.json({ count, parentId: req.params.id });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] User count error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// APPROVE USER
// ============================================================

router.put('/users/:id/approve', authenticate, isOwner, async (req, res) => {
  try {
    const code = generateTrackingCode();
    const user = await User.update(req.params.id, { status: 'active', trackingCode: code }, true);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User approved', user });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Approve error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// REJECT/DELETE USER
// ============================================================

router.delete('/users/:id/reject', authenticate, isOwner, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot reject yourself' });
    }
    const deleted = await User.remove(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User rejected and deleted' });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Reject error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// IMPERSONATE (Owner only)
// ============================================================

router.post('/impersonate/:id', authenticate, isOwner, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot impersonate yourself' });
    }

    const allUsers = await db.users.read();
    const targetUser = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    if (targetUser.role === ROLES.OWNER) {
      return res.status(403).json({ message: 'Cannot impersonate owner' });
    }

    const token = jwt.sign(
      { id: toStringId(targetUser._id) },
      CONFIG.JWT_SECRET,
      { expiresIn: CONFIG.JWT_EXPIRY }
    );

    setAuthCookie(res, token);

    res.json({
      message: `Switched to ${targetUser.name || targetUser.username}`,
      user: User.sanitize(targetUser),
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Impersonate error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// BLOCK / UNBLOCK (Owner only)
// ============================================================

router.patch('/users/:id/block', authenticate, isOwner, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot block yourself' });
    }
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === ROLES.OWNER) {
      return res.status(403).json({ message: 'Cannot block the Owner' });
    }
    const updated = await User.update(req.params.id, { status: 'blocked' }, true);
    res.json({ message: 'User blocked', user: updated });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Block error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/users/:id/unblock', authenticate, isOwner, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot unblock yourself' });
    }
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const updated = await User.update(req.params.id, { status: 'active' }, true);
    res.json({ message: 'User unblocked', user: updated });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Unblock error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// CREATE USER (Owner only, User role only)
// ============================================================

router.post('/users', authenticate, isOwner, async (req, res) => {
  try {
    const { name, email, password, phone, facebook } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const username = email.split('@')[0];
    const allUsers = await db.users.read();
    if (allUsers.find(u => u.email === email.toLowerCase().trim())) {
      return res.status(400).json({ message: 'Email already exists' });
    }
    if (allUsers.find(u => u.username === username)) {
      return res.status(400).json({ message: 'Username already exists' });
    }

    const newUser = await User.create({
      name, fullName: name,
      username,
      email, password,
      phone: phone || '', facebook: facebook || '',
      role: ROLES.USER, status: 'active',
      parentId: toStringId(req.user._id),
      parentUsername: req.user.username,
      createdBy: toStringId(req.user._id),
    });

    res.status(201).json({ message: 'User created', user: newUser });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Create user error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ============================================================
// UPDATE USER (Owner only)
// ============================================================

router.put('/users/:id', authenticate, isOwner, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const updated = await User.update(req.params.id, req.body, true);
    res.json({ message: 'User updated', user: updated });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Update user error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ============================================================
// DELETE USER (Owner only)
// ============================================================

router.delete('/users/:id', authenticate, isOwner, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot delete yourself' });
    }

    const allUsers = await db.users.read();
    const targetUser = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    if (targetUser.role === ROLES.OWNER) {
      return res.status(403).json({ message: 'Cannot delete Owner account' });
    }

    await User.remove(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Delete user error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// STATS (Owner + User counts only)
// ============================================================

router.get('/stats', authenticate, isOwner, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    res.json({
      total: allUsers.length,
      active: allUsers.filter(u => u.status === 'active').length,
      pending: allUsers.filter(u => u.status === 'pending').length,
      blocked: allUsers.filter(u => u.status === 'blocked').length,
      owners: allUsers.filter(u => u.role === ROLES.OWNER).length,
      users: allUsers.filter(u => u.role === ROLES.USER).length,
      newThisWeek: allUsers.filter(u => new Date(u.created_at) > sevenDaysAgo).length,
      activeToday: allUsers.filter(u => u.lastLogin && new Date(u.lastLogin) > new Date(now.getTime() - 24 * 60 * 60 * 1000)).length,
    });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// MENU ITEMS (Owner only)
// ============================================================

router.get('/menu-items', authenticate, isOwner, async (req, res) => {
  try {
    const items = await db.menuItems.read();
    res.json(items);
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Menu items error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/menu-items', authenticate, isOwner, async (req, res) => {
  try {
    const item = {
      _id: 'mi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      ...req.body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const items = await db.menuItems.read();
    items.push(item);
    await db.menuItems.write(items);
    emitMenuEvent(req.app.get('io'), req.body.groupId, 'created');
    res.status(201).json(item);
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Create menu error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/menu-items/:id', authenticate, isOwner, async (req, res) => {
  try {
    const item = await db.menuItems.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Menu item not found' });
    const updated = await db.menuItems.findByIdAndUpdate(req.params.id, req.body);
    emitMenuEvent(req.app.get('io'), req.body.groupId || item.groupId, 'updated');
    res.json(updated);
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Update menu error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/menu-items/:id', authenticate, isOwner, async (req, res) => {
  try {
    const item = await db.menuItems.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Menu item not found' });
    await db.menuItems.findByIdAndDelete(req.params.id);
    emitMenuEvent(req.app.get('io'), item.groupId, 'deleted');
    res.json({ message: 'Menu item deleted' });
  } catch (err) {
    if (!CONFIG.IS_PRODUCTION) console.error('[Admin] Delete menu error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;