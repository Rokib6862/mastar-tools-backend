// ============================================================
// MEGA TOOLS — ROLE DEFINITIONS & PERMISSIONS
// ============================================================

const ROLES = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  TEAM_MANAGER: 'team_manager',
  USER: 'user',
});

const ALL_ROLES = Object.values(ROLES);

const ROLE_LEVEL = Object.freeze({
  [ROLES.OWNER]: 0,
  [ROLES.ADMIN]: 1,
  [ROLES.TEAM_MANAGER]: 2,
  [ROLES.USER]: 3,
});

// ---- Who can create which role ----
const CREATE_PERMISSIONS = Object.freeze({
  [ROLES.OWNER]: [ROLES.ADMIN, ROLES.TEAM_MANAGER, ROLES.USER],
  [ROLES.ADMIN]: [ROLES.TEAM_MANAGER, ROLES.USER],
  [ROLES.TEAM_MANAGER]: [ROLES.USER],
  [ROLES.USER]: [],
});

// ---- Referral code prefix → role mapping ----
const REFERRAL_ROLE_MAP = Object.freeze({
  'OWN-': ROLES.OWNER,
  'ADM-': ROLES.ADMIN,
  'TM-': ROLES.TEAM_MANAGER,
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