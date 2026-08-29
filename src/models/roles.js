// ============================================================
// MEGA TOOLS — ROLE DEFINITIONS & PERMISSIONS (SIMPLIFIED v3.1)
// ROLES: Owner (full control) + User (standard access)
// FIXED v3.1: canCreateRole properly defined
// ============================================================

const ROLES = Object.freeze({
  OWNER: 'owner',
  USER: 'user',
});

const ALL_ROLES = Object.values(ROLES);

const ROLE_LEVEL = Object.freeze({
  [ROLES.OWNER]: 0,
  [ROLES.USER]: 1,
});

// ---- Who can create which role ----
// Owner creates Users directly (no intermediate roles)
const CREATE_PERMISSIONS = Object.freeze({
  [ROLES.OWNER]: [ROLES.USER],
  [ROLES.USER]: [],
});

// ---- Referral code prefix → role mapping ----
// OWN- = Owner, USR-/REF- = User (ADM-, TM- removed)
const REFERRAL_ROLE_MAP = Object.freeze({
  'OWN-': ROLES.OWNER,
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