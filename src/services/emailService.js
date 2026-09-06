// ============================================================
// MEGA TOOLS — EMAIL SERVICE (Brevo API Integration v4.1)
// FIX v4.1: API Key moved to environment variable
// ============================================================

const axios = require('axios');
const CONFIG = require('../config');

// ============================================================
// BREVO CONFIGURATION
// ============================================================

const BREVO_CONFIG = {
  API_URL: 'https://api.brevo.com/v3/smtp/email',
  // ✅ SECURITY FIX: API Key from environment variable
  API_KEY: process.env.BREVO_API_KEY || '',
  SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL || 'noreply@megatools.site',
  SENDER_NAME: process.env.BREVO_SENDER_NAME || 'Mega Tools Support',
};

// ============================================================
// SEND EMAIL (Brevo API)
// ============================================================

async function sendEmail({ to, subject, html }) {
  try {
    if (!BREVO_CONFIG.API_KEY) {
      console.error('[Email] ERROR: BREVO_API_KEY not configured in .env');
      throw new Error('Email service not configured. Missing BREVO_API_KEY.');
    }

    const payload = {
      sender: {
        email: BREVO_CONFIG.SENDER_EMAIL,
        name: BREVO_CONFIG.SENDER_NAME,
      },
      to: [
        {
          email: to,
          name: to,
        },
      ],
      subject: subject,
      htmlContent: html,
    };

    const response = await axios.post(BREVO_CONFIG.API_URL, payload, {
      headers: {
        'api-key': BREVO_CONFIG.API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      timeout: 15000,
    });

    console.log('[Email] ========================================');
    console.log(`[Email] TO: ${to}`);
    console.log(`[Email] SUBJECT: ${subject}`);
    console.log(`[Email] STATUS: SENT via Brevo (${response.status})`);
    console.log(`[Email] Message ID: ${response.data?.messageId || 'N/A'}`);
    console.log('[Email] ========================================');
    return true;
  } catch (err) {
    console.error('[Email] ========================================');
    console.error(`[Email] TO: ${to}`);
    console.error(`[Email] SUBJECT: ${subject}`);
    console.error(`[Email] STATUS: FAILED`);
    console.error(`[Email] ERROR: ${err.response?.data?.message || err.message}`);
    console.error('[Email] ========================================');
    throw new Error(`Email send failed: ${err.response?.data?.message || err.message}`);
  }
}

// ============================================================
// TEMPLATES — SIMPLE & SPAM-SAFE
// ============================================================

function passwordResetTemplate(user, newPassword) {
  const name = user.name || user.fullName || 'User';
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:20px;background:#f8f9fa;font-family:Arial,sans-serif;">
  <div style="max-width:440px;margin:0 auto;background:#fff;border-radius:8px;padding:28px 24px;border:1px solid #e0e0e0;">
    <p style="font-size:15px;color:#333;margin:0 0 12px;">Hello ${name},</p>
    <p style="font-size:14px;color:#555;margin:0 0 16px;line-height:1.5;">You requested a new password for your account.</p>
    <div style="background:#f0f4ff;border-radius:6px;padding:14px 18px;margin-bottom:16px;">
      <p style="font-size:12px;color:#777;margin:0 0 4px;">New Password</p>
      <p style="font-size:22px;color:#4F46E5;font-weight:700;margin:0;letter-spacing:0.5px;font-family:monospace;">${newPassword}</p>
    </div>
    <p style="font-size:13px;color:#777;margin:0 0 16px;line-height:1.4;">Please log in and change your password from Settings.</p>
    <a href="http://localhost:5173/login" style="display:inline-block;background:#4F46E5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:600;">Log In</a>
    <p style="font-size:11px;color:#aaa;margin:20px 0 0;">© 2026 Mega Tools</p>
  </div>
</body>
</html>`;
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
  sendEmail,
  passwordResetTemplate,
};