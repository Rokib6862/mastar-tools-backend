// ============================================================
// MEGA TOOLS — IMAGE UPLOAD ROUTES (Local Storage v3.1)
// ImgBB + FreeImage REMOVED — Files saved locally
// FIX S2: Path traversal sanitization on DELETE
// FIX-UP1 (v3.1): fileUrl now respects CONFIG.PUBLIC_BASE_URL
//                 / protocol+host from request — no more hardcoded
//                 localhost in production.
// FIX-UP2 (v3.1): multer fileFilter now checks both MIME and
//                 file extension whitelist to prevent MIME spoofing.
// FIX-UP3 (v3.1): rate limiter cleanup — expired entries evicted
//                 automatically to prevent unbounded growth.
// FIX-UP4 (v3.1): upload route mounts `upload.single` INSIDE the
//                 handler (via middleware chain) so error handling
//                 is consistent and MulterError codes are mapped.
// FIX-UP5 (v3.1): DELETE endpoint now requires authentication
//                 (was optionalAuth) — prevents anonymous deletion.
// FIX-UP6 (v3.1): filename sanitization hardens against null-bytes
//                 and Windows short-name tricks.
// ============================================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { optionalAuth, authenticate } = require('../middleware/auth');
const { toStringId } = require('../utils/helpers');
const CONFIG = require('../config');

// ---- ENSURE UPLOADS DIRECTORY ----
const UPLOADS_DIR = path.join(__dirname, '../../../uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ============================================================
// PUBLIC URL HELPER (FIX-UP1)
// ============================================================

function getPublicBaseUrl(req) {
  if (CONFIG.PUBLIC_BASE_URL) return CONFIG.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (CONFIG.IS_PRODUCTION && req) {
    try { return `${req.protocol || 'https'}://${req.get('host')}`; } catch (_) {}
  }
  return `http://localhost:${CONFIG.PORT}`;
}

// ============================================================
// RATE LIMITER (FIX-UP3: auto-clean)
// ============================================================

const rateLimiter = {};
let lastSweep = Date.now();

function sweepRateLimiter(now) {
  if (now - lastSweep < 60000) return;
  lastSweep = now;
  for (const ip of Object.keys(rateLimiter)) {
    if (now > (rateLimiter[ip].resetAt || 0)) delete rateLimiter[ip];
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  sweepRateLimiter(now);
  if (!rateLimiter[ip]) {
    rateLimiter[ip] = { count: 1, resetAt: now + 60000 };
    return true;
  }
  const data = rateLimiter[ip];
  if (now > data.resetAt) {
    data.count = 1;
    data.resetAt = now + 60000;
    return true;
  }
  if (data.count >= CONFIG.UPLOAD_RATE_LIMIT_MAX) return false;
  data.count++;
  return true;
}

// ============================================================
// EXTENSION WHITELIST (FIX-UP2)
// ============================================================

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico']);

// ============================================================
// MULTER CONFIG — Local disk storage
// ============================================================

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    const uniqueName = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: 5,
  },
  fileFilter: (req, file, cb) => {
    // FIX-UP2: check BOTH MIME and extension
    const mimeOk = CONFIG.ALLOWED_IMAGE_TYPES.includes(file.mimetype);
    const ext = (path.extname(file.originalname) || '').toLowerCase();
    const extOk = ALLOWED_EXTENSIONS.has(ext);
    if (mimeOk && extOk) return cb(null, true);
    return cb(new Error(`Invalid file type. Allowed: ${CONFIG.ALLOWED_IMAGE_TYPES.join(', ')}`), false);
  },
});

// ============================================================
// MULTER ERROR MAPPER
// ============================================================

function handleMulterError(err, res) {
  if (!err) return false;
  if (err.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ success: false, message: `File exceeds ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB limit` });
    return true;
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    res.status(400).json({ success: false, message: 'Too many files or unexpected field' });
    return true;
  }
  if (err.message && err.message.startsWith('Invalid file type')) {
    res.status(400).json({ success: false, message: err.message });
    return true;
  }
  return false;
}

// ============================================================
// SINGLE IMAGE UPLOAD (FIX-UP4: middleware inside handler)
// ============================================================

router.post('/', optionalAuth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      if (!handleMulterError(err, res)) {
        console.error('[Upload] Multer error:', err.message);
        res.status(500).json({ success: false, message: 'Upload failed' });
      }
      return;
    }
    const startTime = Date.now();
    const clientIp = req.ip || 'unknown';

    try {
      if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ success: false, message: 'Too many uploads. Try again later.' });
      }
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'No image file provided' });
      }

      const fileUrl = `${getPublicBaseUrl(req)}/uploads/${req.file.filename}`;
      const result = {
        url: fileUrl,
        display_url: fileUrl,
        delete_url: '',
        name: req.body.name || req.file.originalname,
        size: req.file.size,
        filename: req.file.filename,
      };

      if (req.user) {
        const io = req.app.get('io');
        if (io) {
          try {
            io.to('user_' + toStringId(req.user._id)).emit('imageUploaded', {
              userId: req.user._id,
              url: result.url,
              name: result.name,
              timestamp: new Date().toISOString(),
            });
          } catch (_) {}
        }
      }

      res.json({ success: true, ...result, duration: Date.now() - startTime });
    } catch (e) {
      console.error('[Upload] Error:', e.message);
      res.status(500).json({ success: false, message: 'Upload failed' });
    }
  });
});

// ============================================================
// MULTIPLE IMAGE UPLOAD
// ============================================================

router.post('/multiple', optionalAuth, (req, res) => {
  upload.array('images', 5)(req, res, async (err) => {
    if (err) {
      if (!handleMulterError(err, res)) {
        console.error('[Upload] Multer multi error:', err.message);
        res.status(500).json({ success: false, message: 'Upload failed' });
      }
      return;
    }
    const startTime = Date.now();
    const clientIp = req.ip || 'unknown';

    try {
      if (!checkRateLimit(clientIp)) {
        return res.status(429).json({ success: false, message: 'Too many uploads.' });
      }
      if (!req.files?.length) {
        return res.status(400).json({ success: false, message: 'No image files provided' });
      }

      const baseUrl = getPublicBaseUrl(req);
      const results = [];
      const errors = [];

      for (const file of req.files) {
        try {
          const fileUrl = `${baseUrl}/uploads/${file.filename}`;
          results.push({
            success: true,
            url: fileUrl,
            display_url: fileUrl,
            delete_url: '',
            name: file.originalname,
            size: file.size,
          });
        } catch (e) {
          errors.push({ name: file.originalname, error: e.message });
        }
      }

      res.json({
        success: true,
        total: req.files.length,
        uploaded: results.length,
        failed: errors.length,
        results,
        errors: errors.length > 0 ? errors : undefined,
        duration: `${Date.now() - startTime}ms`,
      });
    } catch (e) {
      console.error('[Upload] Multiple error:', e);
      res.status(500).json({ success: false, message: 'Upload failed' });
    }
  });
});

// ============================================================
// DELETE IMAGE (Local) — auth required (FIX-UP5)
// FIX S2 + FIX-UP6
// ============================================================

router.delete('/:filename', authenticate, async (req, res) => {
  try {
    const rawName = req.params.filename;
    if (!rawName) return res.status(400).json({ success: false, message: 'Filename required' });

    // FIX-UP6: strip null bytes and reject control characters
    const cleaned = String(rawName).replace(/\0/g, '');
    if (/[\x00-\x1F\x7F]/.test(cleaned)) {
      return res.status(400).json({ success: false, message: 'Invalid filename' });
    }

    // FIX S2: basename guard
    const safeFilename = path.basename(cleaned);
    if (safeFilename !== cleaned) {
      return res.status(400).json({ success: false, message: 'Invalid filename' });
    }

    const filePath = path.join(UPLOADS_DIR, safeFilename);
    const resolvedPath = path.resolve(filePath);
    const resolvedUploadsDir = path.resolve(UPLOADS_DIR);
    if (!resolvedPath.startsWith(resolvedUploadsDir + path.sep)) {
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    fs.unlinkSync(filePath);
    res.json({ success: true, message: 'Image deleted' });
  } catch (err) {
    console.error('[Upload] Delete error:', err);
    res.status(500).json({ success: false, message: 'Delete failed' });
  }
});

// ============================================================
// HEALTH
// ============================================================

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'upload',
    type: 'local',
    configured: true,
    limits: {
      maxFileSize: CONFIG.MAX_FILE_SIZE / 1024 / 1024 + 'MB',
      maxImageSize: CONFIG.MAX_IMAGE_SIZE / 1024 / 1024 + 'MB',
      maxFiles: 5,
      rateLimit: `${CONFIG.UPLOAD_RATE_LIMIT_MAX} per minute`,
    },
  });
});

// ============================================================
// EXPORT
// ============================================================

module.exports = router;