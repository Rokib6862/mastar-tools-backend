// ============================================================
// MEGA TOOLS — ROLE DEFINITIONS & PERMISSIONS (v4.0 — 3-TIER)
// ROLES: Owner (full control) + Admin (child management) + User (self)
// HIERARCHY: Owner → Admin → User
// ============================================================

const ROLES = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  USER: 'user',
});

const ALL_ROLES = Object.values(ROLES);

const ROLE_LEVEL = Object.freeze({
  [ROLES.OWNER]: 0,
  [ROLES.ADMIN]: 1,
  [ROLES.USER]: 2,
});

// ---- Who can create which role ----
// Owner creates Admin + User
// Admin creates User only
// User creates nobody
const CREATE_PERMISSIONS = Object.freeze({
  [ROLES.OWNER]: [ROLES.ADMIN, ROLES.USER],
  [ROLES.ADMIN]: [ROLES.USER],
  [ROLES.USER]: [],
});

// ---- Referral code prefix → role mapping ----
// ADM- = Admin (new), USR-/REF- = User, OWN- = Admin (security: no owner creation)
const REFERRAL_ROLE_MAP = Object.freeze({
  'ADM-': ROLES.ADMIN,
  'OWN-': ROLES.ADMIN,
  'USR-': ROLES.USER,
  'REF-': ROLES.USER,
});

// ---- Chain rotation modes ----
const ROTATION_MODES = Object.freeze({
  SEQUENTIAL: 'sequential',
  RANDOM: 'random',
  WEIGHTED: 'weighted',
});

// ---- Helper functions ----
const getRoleLevel = (role) => ROLE_LEVEL[role] ?? 99;

const canCreateRole = (creatorRole, targetRole) => {
  const allowed = CREATE_PERMISSIONS[creatorRole] || [];
  return allowed.includes(targetRole);
};

const isHigherRole = (roleA, roleB) => {
  return getRoleLevel(roleA) < getRoleLevel(roleB);
};

const getReferralRole = (referralCode) => {
  if (!referralCode) return null;
  const dashIndex = referralCode.indexOf('-');
  const prefix = dashIndex >= 0 ? referralCode.substring(0, dashIndex + 1) : referralCode.substring(0, 4);
  return REFERRAL_ROLE_MAP[prefix] || null;
};

module.exports = {
  ROLES,
  ALL_ROLES,
  ROLE_LEVEL,
  CREATE_PERMISSIONS,
  REFERRAL_ROLE_MAP,
  ROTATION_MODES,
  getRoleLevel,
  canCreateRole,
  isHigherRole,
  getReferralRole,
};