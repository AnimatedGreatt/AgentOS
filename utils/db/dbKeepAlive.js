const { Pool } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
const INTERVAL_MS = Number(process.env.DB_KEEPALIVE_MS) || 5 * 60 * 1000; // default 5 minutes

let pool = null;
let timer = null;

async function ping() {
  if (!pool) return;
  try {
    await pool.query("SELECT 1");
    console.info("[dbKeepAlive] ping OK");
  } catch (err) {
    console.error("[dbKeepAlive] ping failed:", err.message || err);
  }
}

function startKeepAlive() {
  if (!DATABASE_URL) {
    console.info("[dbKeepAlive] DATABASE_URL not set; skipping DB keep-alive");
    return;
  }
  if (pool) return;
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.on("error", (err) => console.error("[dbKeepAlive] pool error:", err));
  // initial ping and schedule
  ping().catch(() => {});
  timer = setInterval(() => ping().catch(() => {}), INTERVAL_MS);
  console.info(`[dbKeepAlive] started, interval=${INTERVAL_MS}ms`);
}

async function stopKeepAlive() {
  if (timer) clearInterval(timer);
  timer = null;
  if (pool) {
    try { await pool.end(); } catch (e) {}
    pool = null;
  }
}

module.exports = { startKeepAlive, stopKeepAlive };
