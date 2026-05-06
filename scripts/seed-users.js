require("dotenv").config();

const { getPool } = require("../src/db/postgres");
const { hashPassword, looksLikeBcryptHash } = require("../src/security/passwords");
const { upsertUser } = require("../src/repositories/postgresRepository");

async function secretToHash(secret, label) {
  if (!secret) {
    throw new Error(`${label} is required.`);
  }

  if (looksLikeBcryptHash(secret)) {
    return secret;
  }

  return hashPassword(secret);
}

async function main() {
  const users = [
    {
      username: process.env.ADMIN_USER || "admin",
      displayName: "Solvagence Admin",
      passwordHash: await secretToHash(process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD || "admin123", "ADMIN_PASSWORD_HASH or ADMIN_PASSWORD"),
      role: "admin"
    },
    {
      username: process.env.REVIEWER_USER || "reviewer",
      displayName: "Solvagence Reviewer",
      passwordHash: await secretToHash(process.env.REVIEWER_PASSWORD_HASH || process.env.REVIEWER_PASSWORD || "reviewer123", "REVIEWER_PASSWORD_HASH or REVIEWER_PASSWORD"),
      role: "reviewer"
    },
    {
      username: process.env.VIEWER_USER || "viewer",
      displayName: "Solvagence Viewer",
      passwordHash: await secretToHash(process.env.VIEWER_PASSWORD_HASH || process.env.VIEWER_PASSWORD || "viewer123", "VIEWER_PASSWORD_HASH or VIEWER_PASSWORD"),
      role: "viewer"
    }
  ];

  for (const user of users) {
    const saved = await upsertUser(user);
    console.log(`${saved.role}: ${saved.username}`);
  }

  await getPool().end();
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
