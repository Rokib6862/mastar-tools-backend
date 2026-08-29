// ============================================================
// MEGA TOOLS — ROUTES BARREL EXPORT (v4.1 FIXED)
// FIXED v4.1: All lazy loaders properly defined + exported
// ============================================================

const routeCache = {};

function lazyLoadRoute(routeName, routePath) {
  if (!routeCache[routeName]) {
    routeCache[routeName] = require(routePath);
  }
  return routeCache[routeName];
}

// Core routes - load immediately
const authRoutes = require('./auth');
const sessionsRoutes = require('./sessions');
const dataRoutes = require('./data');
const webhookRoutes = require('./webhook');

// Lazy loaded routes
const getLinksRoutes = () => lazyLoadRoute('links', './links');
const getRedirectRoutes = () => lazyLoadRoute('redirect', './redirect');
const getExportRoutes = () => lazyLoadRoute('export', './export');
const getUploadRoutes = () => lazyLoadRoute('upload', './upload');
const getTrashRoutes = () => lazyLoadRoute('trash', './trash');

module.exports = {
  authRoutes,
  sessionsRoutes,
  dataRoutes,
  webhookRoutes,
  get linksRoutes() { return getLinksRoutes(); },
  get redirectRoutes() { return getRedirectRoutes(); },
  get exportRoutes() { return getExportRoutes(); },
  get uploadRoutes() { return getUploadRoutes(); },
  get trashRoutes() { return getTrashRoutes(); },
};

function preloadAllRoutes() {
  if (process.env.NODE_ENV === 'production') {
    const essentialRoutes = ['./auth', './sessions', './data', './webhook', './links', './redirect'];
    essentialRoutes.forEach(route => { try { require(route); } catch (e) {} });
  }
}

if (process.env.NODE_ENV === 'production' && process.env.PRELOAD_ROUTES === 'true') {
  preloadAllRoutes();
}