require("dotenv").config();

const fs = require("fs/promises");
const path = require("path");
const { getPool } = require("../src/db/postgres");

async function main() {
  const schemaPath = path.join(__dirname, "..", "src", "db", "schema.sql");
  const schema = await fs.readFile(schemaPath, "utf-8");
  await getPool().query(schema);
  await getPool().end();
  console.log("PostgreSQL schema initialized.");
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
