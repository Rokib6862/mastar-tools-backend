// ============================================================
// MEGA TOOLS - VISITOR IDENTITY NORMALIZER
// FIX-ID1 (v1.0 - SINGLE-SOURCE-OF-TRUTH VISITOR ID FORMAT)
//
// FIX-S45 (v1.1 — RAW-IP-AS-VID GUARD):
//   Root cause (production screenshot evidence):
//     • routes/data.js getClientIdentity() was returning
//       `visitorId: bodyVid || ip` — a raw IP string as the
//       visitorId when the frontend omitted vid.
//     • This function then accepted that raw IP verbatim
//       (first branch), bypassing the `ip_` prefix and
//       collapsing every visitor behind the same IP into
//       one session.
//   Fix:
//     • Reject raw IPv4/IPv6 strings in the `visitorId` branch.
//     • Fall through to the normal `ip_` prefix path so the
//       final vid is always either a real client vid, an
//       `ip_*` scoped id, or a `tc_*` scoped id.
//   No behaviour change for legit vids (v_*, ip_*, tc_*, any
//   custom token). Only raw IP strings are re-routed.
// ============================================================

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function looksLikeRawIp(value) {
  const v = String(value || "").trim();
  if (!v) return false;
  if (IPV4_RE.test(v)) {
    // Extra check: each octet <= 255 (defensive)
    const parts = v.split(".");
    for (let i = 0; i < parts.length; i++) {
      const n = parseInt(parts[i], 10);
      if (!Number.isFinite(n) || n < 0 || n > 255) return false;
    }
    return true;
  }
  // IPv6 must contain ':' to distinguish from normal tokens.
  if (IPV6_RE.test(v) && v.indexOf(":") !== -1) return true;
  return false;
}

function normalizeVisitorId({ visitorId, ip, trackingCode } = {}) {
  if (visitorId !== undefined && visitorId !== null) {
    const v = String(visitorId).trim();
    // FIX-S45: reject raw IP masquerading as vid; let the
    // ip-prefix branch below handle it consistently.
    if (v && !looksLikeRawIp(v)) return v;
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

module.exports = { normalizeVisitorId, ownerCodeOf, looksLikeRawIp };