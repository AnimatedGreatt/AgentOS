const { pool } = require('./db/db');

async function addSubmission({ guildId, userId, userTag, link, caseNumber, verdict, suspect }) {
  const res = await pool.query(
    `INSERT INTO bot_queued_submissions (guild_id, user_id, user_tag, link, case_number, verdict, suspect)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [guildId, userId, userTag, link, caseNumber, verdict, suspect]
  );
  return res.rows[0];
}

async function getAllAndClear() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(`SELECT * FROM bot_queued_submissions ORDER BY created_at ASC`);
    const rows = res.rows || [];
    await client.query(`DELETE FROM bot_queued_submissions`);
    await client.query('COMMIT');
    return rows;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { addSubmission, getAllAndClear };
