// ============================================================
// MEGA TOOLS — IMAGE UPLOAD ROUTES (imgbb)
// ============================================================

const express = require('express');
const router = express.Router();
const multer = require('multer');
const FormData = require('form-data');
const axios = require('axios');
const { optionalAuth } = require('../middleware/auth');
const CONFIG = require('../config');

// ============================================================
// RATE LIMITER
// ============================================================

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

// ============================================================
// MULTER CONFIG
// ============================================================

const upload = multer({
  storage: multer.memoryStorage(),
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

    if (req.file.size > CONFIG.MAX_IMAGE_SIZE) {
      return res.status(400).json({
        success: false,
        message: `Image must be less than ${CONFIG.MAX_IMAGE_SIZE / 1024 / 1024}MB`,
      });
    }

    if (!CONFIG.IMGBB_API_KEY) {
      return res.status(500).json({ success: false, message: 'Upload service not configured' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const formData = new FormData();
    formData.append('key', CONFIG.IMGBB_API_KEY);
    formData.append('image', base64Image);
    if (req.body.name) formData.append('name', req.body.name);

    const imgbbRes = await axios.post('https://api.imgbb.com/1/upload', formData, {
      headers: formData.getHeaders(),
      timeout: CONFIG.IMGBB_TIMEOUT,
    });

    if (imgbbRes.data?.success) {
      const result = {
        success: true,
        url: imgbbRes.data.data.url,
        display_url: imgbbRes.data.data.display_url,
        delete_url: imgbbRes.data.data.delete_url,
        width: imgbbRes.data.data.width,
        height: imgbbRes.data.data.height,
        size: imgbbRes.data.data.size,
        name: imgbbRes.data.data.title || req.file.originalname,
        duration: Date.now() - startTime,
      };

      if (req.user) {
        const io = req.app.get('io');
        if (io) {
          io.emit('imageUploaded', {
            userId: req.user._id,
            url: result.url,
            name: result.name,
            timestamp: new Date().toISOString(),
          });
        }
      }

      res.json(result);
    } else {
      console.error('[Upload] imgbb failed:', imgbbRes.data);
      res.status(500).json({ success: false, message: 'Upload failed' });
    }
  } catch (err) {
    console.error('[Upload] Error:', err.message);
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

    if (!CONFIG.IMGBB_API_KEY) {
      return res.status(500).json({ success: false, message: 'Upload service not configured' });
    }

    const results = [];
    const errors = [];

    for (const file of req.files) {
      try {
        if (file.size > CONFIG.MAX_IMAGE_SIZE) {
          errors.push({ name: file.originalname, error: 'Size exceeds limit' });
          continue;
        }

        const base64Image = file.buffer.toString('base64');
        const formData = new FormData();
        formData.append('key', CONFIG.IMGBB_API_KEY);
        formData.append('image', base64Image);
        if (req.body.name) formData.append('name', `${req.body.name}_${Date.now()}`);

        const imgbbRes = await axios.post('https://api.imgbb.com/1/upload', formData, {
          headers: formData.getHeaders(),
          timeout: CONFIG.IMGBB_TIMEOUT,
        });

        if (imgbbRes.data?.success) {
          results.push({
            success: true,
            url: imgbbRes.data.data.url,
            display_url: imgbbRes.data.data.display_url,
            delete_url: imgbbRes.data.data.delete_url,
            name: file.originalname,
            size: file.size,
          });
        } else {
          errors.push({ name: file.originalname, error: 'Upload failed' });
        }
      } catch (err) {
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
// DELETE IMAGE
// ============================================================

router.delete('/:deleteUrl', optionalAuth, async (req, res) => {
  try {
    const { deleteUrl } = req.params;
    if (!deleteUrl) return res.status(400).json({ success: false, message: 'Delete URL required' });

    const response = await axios.delete(`https://api.imgbb.com/1/delete/${deleteUrl}`, {
      timeout: CONFIG.IMGBB_TIMEOUT,
    });

    if (response.data?.success) {
      res.json({ success: true, message: 'Image deleted' });
    } else {
      res.status(400).json({ success: false, message: 'Delete failed' });
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
    configured: !!CONFIG.IMGBB_API_KEY,
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