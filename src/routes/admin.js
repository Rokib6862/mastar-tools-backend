// ============================================================
// MEGA TOOLS — ADMIN ROUTES
// ============================================================

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('../database');
const User = require('../models/User');
const { ROLES, CREATE_PERMISSIONS, REFERRAL_ROLE_MAP, getReferralRole, canCreateRole } = require('../models/roles');
const { authenticate, isAdmin, isTeamManager } = require('../middleware/auth');
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

// ============================================================
// OWNER-ONLY MIDDLEWARE HELPER
// ============================================================

function requireOwner(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }
  if (req.user.role !== ROLES.OWNER || req.user.isTrial) {
    return res.status(403).json({ success: false, message: 'Only the Owner can access this resource.' });
  }
  next();
}

// ============================================================
// CLEAN DATABASE — Owner-only emergency cleanup
// ============================================================

router.post('/clean-db', authenticate, requireOwner, async (req, res) => {
  try {
    const sessions = await db.sessions.read();
    const logs = await db.readJSON('webhook_logs');
    const routeLogs = await db.readJSON('routeLogs');
    
    await db.sessions.write([]);
    await db.writeJSON('webhook_logs', []);
    await db.writeJSON('routeLogs', []);
    
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
    console.error('[Admin] Clean DB error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// USER LIST
// ============================================================

router.get('/users', authenticate, isTeamManager, async (req, res) => {
  try {
    const { search, role, status, isTrial, page, limit } = req.query;
    const allUsers = await db.users.read();
    const userId = toStringId(req.user._id);

    let users;

    if (req.user.role === ROLES.OWNER) {
      users = allUsers;
    } else if (req.user.role === ROLES.ADMIN) {
      const tmIds = allUsers.filter(u => u.parentId === userId).map(u => toStringId(u._id));
      users = allUsers.filter(u =>
        toStringId(u._id) === userId ||
        u.parentId === userId ||
        tmIds.includes(u.parentId)
      );
    } else {
      users = allUsers.filter(u => u.parentId === userId);
    }

    if (search) {
      const q = search.toLowerCase();
      users = users.filter(u =>
        (u.name || '').toLowerCase().includes(q) ||
        (u.fullName || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q) ||
        (u.trackingCode || '').toLowerCase().includes(q) ||
        (u.referralCode || '').toLowerCase().includes(q)
      );
    }

    if (role && role !== 'all') users = users.filter(u => u.role === role);
    if (status && status !== 'all') {
      if (status === 'trial') users = users.filter(u => u.isTrial === true);
      else users = users.filter(u => u.status === status);
    }
    if (isTrial === 'true') users = users.filter(u => u.isTrial === true);
    else if (isTrial === 'false') users = users.filter(u => !u.isTrial);

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
    console.error('[Admin] Get users error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// PENDING USERS
// ============================================================

router.get('/users/pending', authenticate, isAdmin, async (req, res) => {
  try {
    const pending = await User.findMany({ status: 'pending' });
    res.json(pending);
  } catch (err) {
    console.error('[Admin] Pending users error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// USER COUNT
// ============================================================

router.get('/users/count/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const count = allUsers.filter(u => u.parentId === req.params.id).length;
    res.json({ count, managerId: req.params.id });
  } catch (err) {
    console.error('[Admin] User count error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// APPROVE USER
// ============================================================

router.put('/users/:id/approve', authenticate, isAdmin, async (req, res) => {
  try {
    const code = generateTrackingCode();
    const user = await User.update(req.params.id, { status: 'active', trackingCode: code }, true);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User approved', user });
  } catch (err) {
    console.error('[Admin] Approve error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// REJECT/DELETE USER
// ============================================================

router.delete('/users/:id/reject', authenticate, isAdmin, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot reject yourself' });
    }
    const deleted = await User.remove(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User rejected and deleted' });
  } catch (err) {
    console.error('[Admin] Reject error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// IMPERSONATE
// ============================================================

router.post('/impersonate/:id', authenticate, isTeamManager, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot impersonate yourself' });
    }

    const allUsers = await db.users.read();
    const targetUser = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    if (targetUser.role === ROLES.OWNER && !targetUser.isTrial) {
      return res.status(403).json({ message: 'Cannot impersonate owner' });
    }

    const userId = toStringId(req.user._id);

    if (req.user.role === ROLES.ADMIN) {
      if (targetUser.role === ROLES.OWNER || targetUser.role === ROLES.ADMIN) {
        return res.status(403).json({ message: 'Cannot impersonate this user' });
      }
      const tmIds = allUsers.filter(u => u.parentId === userId).map(u => toStringId(u._id));
      const isInNetwork = targetUser.parentId === userId || tmIds.includes(targetUser.parentId);
      if (!isInNetwork) return res.status(403).json({ message: 'Access denied' });
    } else if (req.user.role === ROLES.TEAM_MANAGER) {
      if (targetUser.parentId !== userId) return res.status(403).json({ message: 'Access denied' });
    }

    const token = jwt.sign(
      { id: toStringId(targetUser._id) },
      CONFIG.JWT_SECRET,
      { expiresIn: CONFIG.JWT_EXPIRY }
    );

    res.json({
      message: `Switched to ${targetUser.name || targetUser.username}`,
      token,
      user: User.sanitize(targetUser),
    });
  } catch (err) {
    console.error('[Admin] Impersonate error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// BLOCK / UNBLOCK
// ============================================================

router.patch('/users/:id/block', authenticate, isTeamManager, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot block yourself' });
    }
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN) {
      return res.status(403).json({ message: 'Cannot block this user' });
    }
    if (req.user.role === ROLES.TEAM_MANAGER && user.parentId !== toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const updated = await User.update(req.params.id, { status: 'blocked' }, true);
    res.json({ message: 'User blocked', user: updated });
  } catch (err) {
    console.error('[Admin] Block error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.patch('/users/:id/unblock', authenticate, isTeamManager, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot unblock yourself' });
    }
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role === ROLES.OWNER || user.role === ROLES.ADMIN) {
      return res.status(403).json({ message: 'Cannot unblock this user' });
    }
    if (req.user.role === ROLES.TEAM_MANAGER && user.parentId !== toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const updated = await User.update(req.params.id, { status: 'active' }, true);
    res.json({ message: 'User unblocked', user: updated });
  } catch (err) {
    console.error('[Admin] Unblock error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// VERIFY TRIAL — With trialRole validation
// ============================================================

router.patch('/users/:id/verify-trial', authenticate, async (req, res) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ message: 'Referral code is required' });

    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.isTrial) return res.status(400).json({ message: 'Not a trial user' });

    const trialRole = user.trialRole || 'user';
    const finalCode = referralCode.trim().toUpperCase();
    const referrals = await db.readJSON('referrals');
    const ref = referrals.find(r => r.code === finalCode && !r.used);
    if (!ref) return res.status(400).json({ message: 'Invalid or used referral code' });

    const codeRole = getReferralRole(finalCode);
    if (codeRole === ROLES.OWNER) {
      return res.status(403).json({ message: 'Owner accounts cannot be created via referral' });
    }

    const codePrefix = finalCode.substring(0, finalCode.indexOf('-') + 1);

    if (trialRole === 'admin') {
      if (codePrefix !== 'OWN-') {
        return res.status(403).json({ message: 'Admin trial requires an Owner referral code (OWN-).' });
      }
    } else if (trialRole === 'team_manager') {
      if (codePrefix !== 'ADM-' && codePrefix !== 'OWN-') {
        return res.status(403).json({ message: 'Team Manager trial requires an Admin (ADM-) or Owner (OWN-) referral code.' });
      }
    } else {
      if (codePrefix !== 'ADM-' && codePrefix !== 'TM-' && codePrefix !== 'OWN-') {
        return res.status(403).json({ message: 'User trial requires an Admin (ADM-), TM (TM-), or Owner (OWN-) referral code.' });
      }
    }

    const newRole = codeRole;
    const parentId = toStringId(ref.createdBy);
    let parentUsername = null;
    if (parentId) {
      const parent = allUsers.find(u => toStringId(u._id) === parentId);
      if (parent) {
        parentUsername = parent.username || null;
        const allowed = CREATE_PERMISSIONS[parent.role] || [];
        if (!allowed.includes(newRole)) {
          return res.status(403).json({ message: 'This code cannot create this account type' });
        }
      }
    }

    ref.used = true;
    ref.usedBy = req.params.id;
    ref.usedAt = new Date().toISOString();
    await db.writeJSON('referrals', referrals);

    const updated = await User.update(req.params.id, {
      isTrial: false, trialExpiry: null, role: newRole,
      referralCode: finalCode, status: 'active',
      parentId, parentUsername, createdBy: parentId,
    }, true);

    res.json({ message: 'Trial verified! Account upgraded.', user: updated });
  } catch (err) {
    console.error('[Admin] Verify trial error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// CREATE USER (Admin)
// ============================================================

router.post('/users', authenticate, isTeamManager, async (req, res) => {
  try {
    const { name, email, password, phone, facebook, referralCode, role } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'Name, email and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    const allUsers = await db.users.read();
    if (allUsers.find(u => u.email === email.toLowerCase().trim())) {
      return res.status(400).json({ message: 'Email already exists' });
    }

    let userRole = ROLES.USER;
    const requestedRole = role || 'user';
    if (requestedRole === 'owner') {
      return res.status(403).json({ message: 'Owner accounts cannot be created' });
    }
    if (canCreateRole(req.user.role, requestedRole)) {
      userRole = requestedRole;
    }

    const newUser = await User.create({
      name, fullName: name,
      username: email.split('@')[0],
      email, password,
      phone: phone || '', facebook: facebook || '',
      role: userRole, status: 'active',
      referralCode: referralCode || 'REF-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
      parentId: toStringId(req.user._id),
      parentUsername: req.user.username,
      createdBy: toStringId(req.user._id),
    });

    res.status(201).json({ message: 'User created', user: newUser });
  } catch (err) {
    console.error('[Admin] Create user error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ============================================================
// UPDATE USER
// ============================================================

router.put('/users/:id', authenticate, isTeamManager, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const user = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (req.user.role === ROLES.TEAM_MANAGER && user.parentId !== toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Access denied' });
    }
    const updated = await User.update(req.params.id, req.body, true);
    res.json({ message: 'User updated', user: updated });
  } catch (err) {
    console.error('[Admin] Update user error:', err);
    res.status(500).json({ message: err.message || 'Server error' });
  }
});

// ============================================================
// DELETE USER (Owner/Admin/Team Manager only — Protected)
// ============================================================

router.delete('/users/:id', authenticate, isTeamManager, async (req, res) => {
  try {
    if (req.params.id === toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Cannot delete yourself' });
    }

    const allUsers = await db.users.read();
    const targetUser = allUsers.find(u => toStringId(u._id) === req.params.id);
    if (!targetUser) return res.status(404).json({ message: 'User not found' });

    // Protect Owner and Admin from being deleted
    if (targetUser.role === ROLES.OWNER && !targetUser.isTrial) {
      return res.status(403).json({ message: 'Cannot delete Owner account' });
    }
    if (targetUser.role === ROLES.ADMIN && req.user.role !== ROLES.OWNER) {
      return res.status(403).json({ message: 'Only Owner can delete Admin accounts' });
    }

    // Team Manager can only delete their own subordinate users
    if (req.user.role === ROLES.TEAM_MANAGER && targetUser.parentId !== toStringId(req.user._id)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    await User.remove(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (err) {
    console.error('[Admin] Delete user error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// STATS
// ============================================================

router.get('/stats', authenticate, isAdmin, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    res.json({
      total: allUsers.length,
      active: allUsers.filter(u => u.status === 'active' && !u.isTrial).length,
      pending: allUsers.filter(u => u.status === 'pending').length,
      blocked: allUsers.filter(u => u.status === 'blocked').length,
      trial: allUsers.filter(u => u.isTrial === true).length,
      trialExpired: allUsers.filter(u => u.status === 'trial_expired').length,
      owners: allUsers.filter(u => u.role === ROLES.OWNER && !u.isTrial).length,
      admins: allUsers.filter(u => u.role === ROLES.ADMIN).length,
      teamManagers: allUsers.filter(u => u.role === ROLES.TEAM_MANAGER).length,
      users: allUsers.filter(u => u.role === ROLES.USER).length,
      newThisWeek: allUsers.filter(u => new Date(u.created_at) > sevenDaysAgo).length,
      activeToday: allUsers.filter(u => u.lastLogin && new Date(u.lastLogin) > new Date(now.getTime() - 24 * 60 * 60 * 1000)).length,
    });
  } catch (err) {
    console.error('[Admin] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// MENU ITEMS
// ============================================================

router.get('/menu-items', authenticate, isAdmin, async (req, res) => {
  try {
    const items = await db.menuItems.read();
    res.json(items);
  } catch (err) {
    console.error('[Admin] Menu items error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/menu-items', authenticate, isAdmin, async (req, res) => {
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
    console.error('[Admin] Create menu error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/menu-items/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const item = await db.menuItems.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Menu item not found' });
    const updated = await db.menuItems.findByIdAndUpdate(req.params.id, req.body);
    emitMenuEvent(req.app.get('io'), req.body.groupId || item.groupId, 'updated');
    res.json(updated);
  } catch (err) {
    console.error('[Admin] Update menu error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

router.delete('/menu-items/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const item = await db.menuItems.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Menu item not found' });
    await db.menuItems.findByIdAndDelete(req.params.id);
    emitMenuEvent(req.app.get('io'), item.groupId, 'deleted');
    res.json({ message: 'Menu item deleted' });
  } catch (err) {
    console.error('[Admin] Delete menu error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;
