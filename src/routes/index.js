// ============================================================
// MEGA TOOLS — ROUTES BARREL EXPORT (v3.1 SIMPLIFIED)
// REMOVED: adminRoutes, supportRoutes, marketplaceRoutes
// FIX-RI1 (v3.1): lazyLoadRoute now resolves routePath relative
//                 to THIS file's directory — previously bare
//                 require('./links') resolved relative to CWD.
// FIX-RI2 (v3.1): preloadAllRoutes now uses the correct paths
//                 (./auth etc.) AND is properly invoked under
//                 NODE_ENV=production without double-require.
// FIX-RI3 (v3.1): lazy routes fail fast — if require throws, the
//                 cached slot is cleared so subsequent calls can
//                 retry after a fix.
// ============================================================

const path = require('path');

const routeCache = {};

function lazyLoadRoute(routeName, routePath) {
  if (!routeCache[routeName]) {
    try {
      // FIX-RI1: resolve path against this file's directory
      const fullPath = require.resolve(path.join(__dirname, routePath));
      routeCache[routeName] = require(fullPath);
    } catch (err) {
      // FIX-RI3: do not poison the cache on failure
      delete routeCache[routeName];
      console.error(`[Routes] Failed to load route '${routeName}' from ${routePath}:`, err.message);
      throw err;
    }
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
const getThemeRoutes = () => lazyLoadRoute('theme', './theme');
const getUploadRoutes = () => lazyLoadRoute('upload', './upload');
const getGeneratePageRoutes = () => lazyLoadRoute('generatePage', './generatePage');
const getTrashRoutes = () => lazyLoadRoute('trash', './trash');

module.exports = {
  authRoutes,
  sessionsRoutes,
  dataRoutes,
  webhookRoutes,
  get linksRoutes() { return getLinksRoutes(); },
  get redirectRoutes() { return getRedirectRoutes(); },
  get exportRoutes() { return getExportRoutes(); },
  get themeRoutes() { return getThemeRoutes(); },
  get uploadRoutes() { return getUploadRoutes(); },
  get trashRoutes() { return getTrashRoutes(); },
  get generatePageRoutes() { return getGeneratePageRoutes(); },
};

// FIX-RI2: correct preload paths + single execution
function preloadAllRoutes() {
  const essentialRoutes = ['./auth', './sessions', './data', './webhook', './links', './redirect', './export', './theme', './upload', './trash', './generatePage'];
  for (const r of essentialRoutes) {
    try {
      const fullPath = require.resolve(path.join(__dirname, r));
      require(fullPath);
    } catch (e) {
      console.error(`[Routes] Preload failed for ${r}:`, e.message);
    }
  }
}

if (process.env.NODE_ENV === 'production' && process.env.PRELOAD_ROUTES === 'true') {
  preloadAllRoutes();
}