require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

function getDbPort() {
  const port = Number(process.env.DB_PORT);
  return Number.isInteger(port) && port > 0 ? port : 5432;
}

async function main() {
  const schema = fs.readFileSync(
    path.join(__dirname, "..", "db", "schema.sql"),
    "utf8"
  );

  const client = new Client({
    host: process.env.DB_HOST,
    port: getDbPort(),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  });

  await client.connect();
  try {
    await client.query(schema);
    console.log("Database schema applied.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Failed to initialize database:", error.message);
  process.exitCode = 1;
});
