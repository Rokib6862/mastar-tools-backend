// ============================================================
// MEGA TOOLS — EMAIL SERVICE (Brevo)
// ============================================================

const axios = require('axios');
const CONFIG = require('../config');

// ============================================================
// SEND EMAIL (5s timeout + detailed logging)
// ============================================================

async function sendEmail({ to, subject, html }) {
  if (!CONFIG.BREVO_API_KEY) {
    console.warn('[Email] ⚠️  BREVO_API_KEY not configured, skipping email');
    return false;
  }

  try {
    const payload = {
      sender: {
        name: CONFIG.BREVO_SENDER_NAME,
        email: CONFIG.BREVO_SENDER_EMAIL,
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    };

    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      payload,
      {
        timeout: 5000,
        headers: {
          'api-key': CONFIG.BREVO_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`[Email] ✅ Sent to ${to} — Message ID: ${response.data?.messageId || 'N/A'}`);
    return true;
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`[Email] ❌ Failed to send to ${to}:`, JSON.stringify(detail).substring(0, 200));
    return false;
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
    <a href="https://mega-tools.online/login" style="display:inline-block;background:#4F46E5;color:#fff;text-decoration:none;padding:12px 28px;border-radius:6px;font-size:14px;font-weight:600;">Log In</a>
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