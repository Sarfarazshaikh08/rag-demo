const { Pool } = require("pg");
const config = require("../config");

let pool;

function getPool() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required for PostgreSQL mode.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : false
    });
  }

  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function withTransaction(callback) {
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  query,
  withTransaction
};
