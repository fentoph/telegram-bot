const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const RETENTION_DAYS = Number(process.env.BROADCAST_LOG_RETENTION_DAYS || 30);

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}
if (!Number.isInteger(RETENTION_DAYS) || RETENTION_DAYS < 1 || RETENTION_DAYS > 3650) {
  throw new Error("BROADCAST_LOG_RETENTION_DAYS must be an integer between 1 and 3650");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 10000
});

async function main() {
  const result = await pool.query(
    "DELETE FROM broadcast_logs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')",
    [RETENTION_DAYS]
  );

  console.log(
    JSON.stringify({
      ok: true,
      job: "db-cleanup",
      deletedBroadcastLogs: result.rowCount,
      retentionDays: RETENTION_DAYS,
      executedAt: new Date().toISOString()
    })
  );
}

main()
  .catch((error) => {
    console.error("DB cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
