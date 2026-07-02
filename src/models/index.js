// ============================================================
// MEGA TOOLS — MODELS BARREL EXPORT
// ============================================================

const User = require('./User');
const Link = require('./Link');
const Session = require('./Session');
const Trash = require('./Trash');
const roles = require('./roles');

module.exports = {
  User,
  Link,
  Session,
  Trash,
  ...roles,
};