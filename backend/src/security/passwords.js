const bcrypt = require("bcryptjs");

const HASH_PREFIXES = ["$2a$", "$2b$", "$2y$"];

function looksLikeBcryptHash(value = "") {
  return HASH_PREFIXES.some(prefix => value.startsWith(prefix));
}

async function hashPassword(password) {
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  return bcrypt.hash(password, 12);
}

async function comparePassword(password, storedSecret) {
  if (!password || !storedSecret) {
    return false;
  }

  if (looksLikeBcryptHash(storedSecret)) {
    return bcrypt.compare(password, storedSecret);
  }

  // Local-demo fallback only. Production should use *_PASSWORD_HASH values.
  return password === storedSecret;
}

module.exports = {
  comparePassword,
  hashPassword,
  looksLikeBcryptHash
};
