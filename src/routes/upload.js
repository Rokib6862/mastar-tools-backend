// ============================================================
// MEGA TOOLS — IMAGE UPLOAD ROUTES (ImageKit v4.1)
// FIXED v4.1: readFileSync typo + FormData correct
// ============================================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { optionalAuth } = require('../middleware/auth');
const { toStringId } = require('../utils/helpers');
const CONFIG = require('../config');

// ---- IMAGEKIT CONFIG ----
const IMAGEKIT_PRIVATE_KEY = process.env.IMAGEKIT_PRIVATE_KEY || '';
const IMAGEKIT_PUBLIC_KEY = process.env.IMAGEKIT_PUBLIC_KEY || '';
const IMAGEKIT_URL_ENDPOINT = process.env.IMAGEKIT_URL_ENDPOINT || '';
const IMAGEKIT_UPLOAD_URL = 'https://upload.imagekit.io/api/v1/files/upload';

// ---- TEMP DIRECTORY FOR MULTER ----
const TMP_DIR = path.join(__dirname, '../../../tmp_uploads');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ---- RATE LIMITER ----
const rateLimiter = {};

function checkRateLimit(ip) {
  const now = Date.now();
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

// ---- MULTER CONFIG — Temp storage ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TMP_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '_' + Math.random().toString(36).slice(2, 8) + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: CONFIG.MAX_FILE_SIZE,
    files: 5,
  },
  fileFilter: (req, file, cb) => {
    if (CONFIG.ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Only ${CONFIG.ALLOWED_IMAGE_TYPES.join(', ')} are allowed`), false);
    }
  },
});

// ---- IMAGEKIT UPLOAD HELPER ----
async function uploadToImageKit(filePath, fileName) {
  // ✅ FIXED: readFileSync (was readFileFileSync)
  const fileBuffer = fs.readFileSync(filePath);
  const fileBase64 = fileBuffer.toString('base64');
  
  const authKey = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64');
  
  // ✅ Use fetch with multipart/form-data
  const response = await fetch(IMAGEKIT_UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${authKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `file=${encodeURIComponent(fileBase64)}&fileName=${encodeURIComponent(fileName)}`,
  });
  
  const data = await response.json();
  return data;
}

// ---- CLEANUP TEMP FILE ----
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error('[Upload] Temp file cleanup error:', err.message);
  }
}

// ============================================================
// SINGLE IMAGE UPLOAD
// ============================================================

router.post('/', optionalAuth, upload.single('image'), async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || 'unknown';

  try {
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, message: 'Too many uploads. Try again later.' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }

    // Upload to ImageKit
    const imageKitResponse = await uploadToImageKit(req.file.path, req.file.filename);
    
    // Cleanup temp file
    cleanupTempFile(req.file.path);

    if (!imageKitResponse || !imageKitResponse.url) {
      console.error('[Upload] ImageKit response:', imageKitResponse);
      return res.status(500).json({ success: false, message: 'ImageKit upload failed', details: imageKitResponse });
    }

    const result = {
      url: imageKitResponse.url,
      display_url: imageKitResponse.url,
      thumbnailUrl: imageKitResponse.thumbnailUrl || '',
      delete_url: '',
      name: req.body.name || imageKitResponse.name || req.file.originalname,
      size: imageKitResponse.size || req.file.size,
      filename: imageKitResponse.name || req.file.filename,
      fileId: imageKitResponse.fileId || '',
    };

    const response = {
      success: true,
      ...result,
      duration: Date.now() - startTime,
    };

    if (req.user) {
      const io = req.app.get('io');
      if (io) {
        io.to('user_' + toStringId(req.user._id)).emit('imageUploaded', {
          userId: req.user._id,
          url: result.url,
          name: result.name,
          timestamp: new Date().toISOString(),
        });
      }
    }

    res.json(response);
  } catch (err) {
    console.error('[Upload] Error:', err.message);
    if (req.file) cleanupTempFile(req.file.path);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: `File exceeds ${CONFIG.MAX_FILE_SIZE / 1024 / 1024}MB limit`,
      });
    }
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// ============================================================
// MULTIPLE IMAGE UPLOAD
// ============================================================

router.post('/multiple', optionalAuth, upload.array('images', 5), async (req, res) => {
  const startTime = Date.now();
  const clientIp = req.ip || 'unknown';

  try {
    if (!checkRateLimit(clientIp)) {
      return res.status(429).json({ success: false, message: 'Too many uploads.' });
    }

    if (!req.files?.length) {
      return res.status(400).json({ success: false, message: 'No image files provided' });
    }

    const results = [];
    const errors = [];

    for (const file of req.files) {
      try {
        const imageKitResponse = await uploadToImageKit(file.path, file.filename);
        cleanupTempFile(file.path);
        
        if (imageKitResponse && imageKitResponse.url) {
          results.push({
            success: true,
            url: imageKitResponse.url,
            display_url: imageKitResponse.url,
            name: file.originalname,
            size: imageKitResponse.size || file.size,
            fileId: imageKitResponse.fileId || '',
          });
        } else {
          errors.push({ name: file.originalname, error: 'ImageKit upload failed' });
        }
      } catch (err) {
        cleanupTempFile(file.path);
        errors.push({ name: file.originalname, error: err.message });
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
  } catch (err) {
    console.error('[Upload] Multiple error:', err);
    res.status(500).json({ success: false, message: 'Upload failed' });
  }
});

// ============================================================
// DELETE IMAGE (ImageKit)
// ============================================================

router.delete('/:fileId', optionalAuth, async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!fileId) return res.status(400).json({ success: false, message: 'File ID required' });

    const authKey = Buffer.from(IMAGEKIT_PRIVATE_KEY + ':').toString('base64');
    const deleteUrl = `https://api.imagekit.io/v1/files/${fileId}`;
    
    const response = await fetch(deleteUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${authKey}`,
      },
    });

    if (response.ok) {
      res.json({ success: true, message: 'Image deleted' });
    } else {
      res.status(response.status).json({ success: false, message: 'Delete failed' });
    }
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
    type: 'imagekit',
    configured: !!(IMAGEKIT_PUBLIC_KEY && IMAGEKIT_PRIVATE_KEY),
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