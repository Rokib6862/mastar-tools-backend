// ============================================================
// MEGA TOOLS — IMAGE UPLOAD ROUTES (Hybrid: imgbb + FreeImage)
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
// HYBRID UPLOAD — Try imgbb1 → imgbb2 → freeimage
// ============================================================

async function tryAllUploadServices(base64Image, name) {
  // Collect all available API configs
  const services = [];
  if (CONFIG.IMGBB_API_KEY_1) {
    services.push({ type: 'imgbb', key: CONFIG.IMGBB_API_KEY_1, url: 'https://api.imgbb.com/1/upload' });
  }
  if (CONFIG.IMGBB_API_KEY_2) {
    services.push({ type: 'imgbb', key: CONFIG.IMGBB_API_KEY_2, url: 'https://api.imgbb.com/1/upload' });
  }
  if (CONFIG.FREEIMAGE_API_KEY) {
    services.push({ type: 'freeimage', key: CONFIG.FREEIMAGE_API_KEY, url: 'https://freeimage.host/api/1/upload' });
  }

  if (services.length === 0) {
    throw new Error('No upload service configured');
  }

  for (const service of services) {
    try {
      const formData = new FormData();

      if (service.type === 'imgbb') {
        formData.append('key', service.key);
        formData.append('image', base64Image);
        if (name) formData.append('name', name);

        const res = await axios.post(service.url, formData, {
          headers: formData.getHeaders(),
          timeout: CONFIG.IMGBB_TIMEOUT,
        });

        if (res.data?.success) {
          return {
            url: res.data.data.url,
            display_url: res.data.data.display_url,
            delete_url: res.data.data.delete_url,
            width: res.data.data.width,
            height: res.data.data.height,
            size: res.data.data.size,
            name: res.data.data.title || name,
          };
        }
      } else if (service.type === 'freeimage') {
        formData.append('key', service.key);
        formData.append('action', 'upload');
        formData.append('source', base64Image);
        formData.append('format', 'json');
        if (name) formData.append('name', name);

        const res = await axios.post(service.url, formData, {
          headers: formData.getHeaders(),
          timeout: CONFIG.IMGBB_TIMEOUT,
        });

        if (res.data?.status_code === 200 && res.data?.image?.url) {
          return {
            url: res.data.image.url,
            display_url: res.data.image.display_url || res.data.image.url,
            delete_url: '',
            width: res.data.image.width,
            height: res.data.image.height,
            size: res.data.image.size,
            name: name || res.data.image.filename,
          };
        }
      }
    } catch (err) {
      // Try next service
      continue;
    }
  }

  throw new Error('All upload services failed');
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

    const base64Image = req.file.buffer.toString('base64');
    const result = await tryAllUploadServices(base64Image, req.body.name || req.file.originalname);

    const response = {
      success: true,
      ...result,
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

    res.json(response);
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

    const results = [];
    const errors = [];

    for (const file of req.files) {
      try {
        if (file.size > CONFIG.MAX_IMAGE_SIZE) {
          errors.push({ name: file.originalname, error: 'Size exceeds limit' });
          continue;
        }

        const base64Image = file.buffer.toString('base64');
        const result = await tryAllUploadServices(base64Image, req.body.name ? `${req.body.name}_${Date.now()}` : file.originalname);

        results.push({
          success: true,
          url: result.url,
          display_url: result.display_url,
          delete_url: result.delete_url,
          name: file.originalname,
          size: file.size,
        });
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
    configured: !!(CONFIG.IMGBB_API_KEY_1 || CONFIG.IMGBB_API_KEY_2 || CONFIG.FREEIMAGE_API_KEY),
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