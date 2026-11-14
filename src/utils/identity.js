// ============================================================
// MEGA TOOLS - VISITOR IDENTITY NORMALIZER
// FIX-ID1 (v1.0 - SINGLE-SOURCE-OF-TRUTH VISITOR ID FORMAT)
// ============================================================

function normalizeVisitorId({ visitorId, ip, trackingCode } = {}) {
  if (visitorId !== undefined && visitorId !== null) {
    const v = String(visitorId).trim();
    if (v) return v;
  }
  if (ip && ip !== "unknown" && ip !== "::1" && ip !== "127.0.0.1") {
    return "ip_" + String(ip).trim();
  }
  if (trackingCode) {
    const tc = String(trackingCode).trim();
    if (tc) return "tc_" + tc;
  }
  return null;
}

function ownerCodeOf(trackingCode) {
  if (!trackingCode) return "";
  const s = String(trackingCode);
  const i = s.indexOf("_");
  return i > 0 ? s.substring(0, i) : s;
}

module.exports = { normalizeVisitorId, ownerCodeOf };