// ============================================================
// MEGA TOOLS — SUPPORT / CHAT ROUTES (CLEAN)
// ============================================================
// LOGIC: Everyone chats ONLY with the Owner.
// Owner sees everyone. Admin/TM/User see only Owner.
// ============================================================

const express = require('express');
const router = express.Router();
const db = require('../database');
const { ROLES } = require('../models/roles');
const { authenticate } = require('../middleware/auth');
const { toStringId, sanitizeText, paginate } = require('../utils/helpers');
const CONFIG = require('../config');

// ============================================================
// FIND OWNER
// ============================================================

async function findOwner() {
  const allUsers = await db.users.read();
  return allUsers.find(u => u.role === ROLES.OWNER && !u.isTrial && u.status !== 'blocked') || null;
}

// ============================================================
// FORMAT CONTACT
// ============================================================

function formatContact(u) {
  return {
    _id: toStringId(u._id),
    name: u.name || u.fullName || u.username || 'Unknown',
    role: u.role || ROLES.USER,
    email: u.email || '',
    profilePic: u.profilePic || '',
    phone: u.phone || '',
    trackingCode: u.trackingCode || '',
    referralCode: u.referralCode || '',
    facebook: u.facebook || '',
    username: u.username || '',
    status: u.status || 'active',
    created_at: u.created_at || '',
    createdBy: u.createdBy || null,
    parentId: u.parentId || null,
    isOnline: false,
  };
}

// ============================================================
// CONTACTS — Simple: Owner sees all, others see only Owner
// ============================================================

router.get('/contacts', authenticate, async (req, res) => {
  try {
    const allUsers = await db.users.read();
    const currentUserId = toStringId(req.user._id);
    let contacts = [];

    if (req.user.role === ROLES.OWNER) {
      // Owner sees everyone except self & blocked
      contacts = allUsers
        .filter(u => toStringId(u._id) !== currentUserId && u.status !== 'blocked')
        .map(formatContact);
    } else {
      // Everyone else sees only the Owner
      const owner = await findOwner();
      if (owner && toStringId(owner._id) !== currentUserId) {
        contacts = [formatContact(owner)];
      }
    }

    res.json(contacts);
  } catch (err) {
    console.error('[Support] Contacts error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// GET MESSAGES — Between current user and target
// ============================================================

router.get('/messages/:userId', authenticate, async (req, res) => {
  try {
    const allMessages = await db.readJSON('messages');
    const targetId = req.params.userId;
    const currentId = toStringId(req.user._id);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || CONFIG.MESSAGES_PER_PAGE;

    const conversation = allMessages
      .filter(m =>
        (m.senderId === currentId && m.receiverId === targetId) ||
        (m.senderId === targetId && m.receiverId === currentId)
      )
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Mark as read
    let changed = false;
    allMessages.forEach(m => {
      if (m.senderId === targetId && m.receiverId === currentId && !m.read) {
        m.read = true;
        m.readAt = new Date().toISOString();
        changed = true;
      }
    });

    if (changed) {
      await db.writeJSON('messages', allMessages);
      const io = req.app.get('io');
      if (io) {
        const unread = allMessages.filter(m => m.receiverId === currentId && !m.read).length;
        io.to(`user_${currentId}`).emit('supportUnreadCount', { count: unread });
      }
    }

    const result = paginate(conversation, page, limit);

    res.json({
      messages: result.data,
      total: result.total,
      page: result.page,
      totalPages: result.totalPages,
      hasMore: result.hasMore,
    });
  } catch (err) {
    console.error('[Support] Messages error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// SEND MESSAGE — Owner ↔ Anyone. Others only → Owner.
// ============================================================

router.post('/send', authenticate, async (req, res) => {
  try {
    const { to, text } = req.body;

    if (!to) return res.status(400).json({ message: 'Receiver ID is required' });
    if (!text?.trim()) return res.status(400).json({ message: 'Message text is required' });
    if (text.length > 5000) return res.status(400).json({ message: 'Message too long (max 5000 chars)' });

    const sanitized = sanitizeText(text);
    if (!sanitized) return res.status(400).json({ message: 'Invalid message content' });

    // Check receiver exists
    const allUsers = await db.users.read();
    const receiver = allUsers.find(u => toStringId(u._id) === to);
    if (!receiver) return res.status(404).json({ message: 'Receiver not found' });
    if (receiver.status === 'blocked') return res.status(403).json({ message: 'This user is blocked' });
    if (req.user.status === 'blocked') return res.status(403).json({ message: 'Your account is blocked' });

    // SIMPLE PERMISSION: Owner can chat with anyone. Others can only chat with Owner.
    const isOwner = (u) => u.role === ROLES.OWNER && !u.isTrial;
    const senderIsOwner = isOwner(req.user);
    const receiverIsOwner = isOwner(receiver);

    if (!senderIsOwner && !receiverIsOwner) {
      return res.status(403).json({ message: 'You can only message the Owner.' });
    }

    // Create message
    const allMessages = await db.readJSON('messages');
    const newMessage = {
      _id: 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      senderId: toStringId(req.user._id),
      receiverId: to,
      text: sanitized,
      timestamp: new Date().toISOString(),
      read: false,
      senderName: req.user.name || req.user.fullName || req.user.username || 'Unknown',
      senderRole: req.user.role || ROLES.USER,
    };

    allMessages.push(newMessage);
    await db.writeJSON('messages', allMessages);

    // Emit via Socket.IO
    const io = req.app.get('io');
    if (io) {
      io.to(`user_${to}`).emit('newMessage', newMessage);
      io.to(`user_${toStringId(req.user._id)}`).emit('newMessage', newMessage);

      const unread = allMessages.filter(m => m.receiverId === to && !m.read).length;
      io.to(`user_${to}`).emit('supportUnreadCount', { count: unread });
    }

    res.status(201).json({ success: true, message: 'Message sent', data: newMessage });
  } catch (err) {
    console.error('[Support] Send error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// UNREAD COUNT
// ============================================================

router.get('/unread', authenticate, async (req, res) => {
  try {
    const allMessages = await db.readJSON('messages');
    const currentId = toStringId(req.user._id);
    const unread = allMessages.filter(m => m.receiverId === currentId && !m.read).length;
    res.json({ count: unread, lastChecked: new Date().toISOString() });
  } catch (err) {
    console.error('[Support] Unread error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// MARK ALL READ
// ============================================================

router.post('/mark-all-read', authenticate, async (req, res) => {
  try {
    const allMessages = await db.readJSON('messages');
    const currentId = toStringId(req.user._id);
    let changed = false;

    allMessages.forEach(m => {
      if (m.receiverId === currentId && !m.read) {
        m.read = true;
        m.readAt = new Date().toISOString();
        changed = true;
      }
    });

    if (changed) {
      await db.writeJSON('messages', allMessages);
      const io = req.app.get('io');
      if (io) io.to(`user_${currentId}`).emit('supportUnreadCount', { count: 0 });
    }

    res.json({ success: true, message: 'All messages marked as read' });
  } catch (err) {
    console.error('[Support] Mark all read error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// DELETE MESSAGE
// ============================================================

router.delete('/messages/:messageId', authenticate, async (req, res) => {
  try {
    const allMessages = await db.readJSON('messages');
    const messageId = req.params.messageId;
    const currentId = toStringId(req.user._id);

    const msgIndex = allMessages.findIndex(m => m._id === messageId);
    if (msgIndex === -1) return res.status(404).json({ message: 'Message not found' });

    const msg = allMessages[msgIndex];
    const isOwner = req.user.role === ROLES.OWNER;
    const isSender = msg.senderId === currentId;

    if (!isSender && !isOwner) return res.status(403).json({ message: 'Access denied' });

    allMessages.splice(msgIndex, 1);
    await db.writeJSON('messages', allMessages);

    res.json({ success: true, message: 'Message deleted' });
  } catch (err) {
    console.error('[Support] Delete error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ============================================================
// STATS (Owner/Admin only)
// ============================================================

router.get('/stats', authenticate, async (req, res) => {
  try {
    if (![ROLES.OWNER, ROLES.ADMIN].includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied' });
    }

    const allMessages = await db.readJSON('messages');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    res.json({
      total: allMessages.length,
      unread: allMessages.filter(m => !m.read).length,
      today: allMessages.filter(m => new Date(m.timestamp) >= today).length,
    });
  } catch (err) {
    console.error('[Support] Stats error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;