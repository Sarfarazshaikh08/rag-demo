require("dotenv").config();

const { hashPassword } = require("../src/security/passwords");

async function main() {
  const password = process.argv[2];

  if (!password) {
    console.error("Usage: npm run password:hash -- <password>");
    process.exit(1);
  }

  const hash = await hashPassword(password);
  console.log(hash);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
