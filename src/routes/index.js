// ============================================================
// MEGA TOOLS — ROUTES BARREL EXPORT
// ============================================================

const authRoutes = require('./auth');
const linksRoutes = require('./links');
const sessionsRoutes = require('./sessions');
const adminRoutes = require('./admin');
const dataRoutes = require('./data');
const webhookRoutes = require('./webhook');
const redirectRoutes = require('./redirect');
const exportRoutes = require('./export');
const themeRoutes = require('./theme');
const supportRoutes = require('./support');
const uploadRoutes = require('./upload');

module.exports = {
  authRoutes,
  linksRoutes,
  sessionsRoutes,
  adminRoutes,
  dataRoutes,
  webhookRoutes,
  redirectRoutes,
  exportRoutes,
  themeRoutes,
  supportRoutes,
  uploadRoutes,
};