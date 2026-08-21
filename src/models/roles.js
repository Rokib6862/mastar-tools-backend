// ============================================================
// MEGA TOOLS — ROLE DEFINITIONS & PERMISSIONS (v2.0 Clean)
// ENTERPRISE: Owner + User only.
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
const CREATE_PERMISSIONS = Object.freeze({
  [ROLES.OWNER]: [ROLES.USER],
  [ROLES.USER]: [],
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

module.exports = {
  ROLES,
  ALL_ROLES,
  ROLE_LEVEL,
  CREATE_PERMISSIONS,
  ROTATION_MODES,
  getRoleLevel,
  canCreateRole,
  isHigherRole,
};