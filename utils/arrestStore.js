const { pool } = require('./db/db');

async function init() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_arrests (
      id SERIAL PRIMARY KEY,
      roblox_username TEXT NOT NULL,
      incident_summary TEXT,
      charges TEXT,
      sentence TEXT,
      proof TEXT,
      submitted_by TEXT,
      submitted_by_tag TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );

  await pool.query(
    `CREATE TABLE IF NOT EXISTS bot_arrest_edits (
      id SERIAL PRIMARY KEY,
      arrest_id INTEGER REFERENCES bot_arrests(id) ON DELETE CASCADE,
      edited_by TEXT,
      edited_by_tag TEXT,
      before_incident_summary TEXT,
      before_charges TEXT,
      before_sentence TEXT,
      before_proof TEXT,
      edited_at TIMESTAMPTZ DEFAULT NOW()
    )`
  );
}

async function createArrest({ roblox_username, incident_summary, charges, sentence, proof, submitted_by, submitted_by_tag }) {
  const res = await pool.query(
    `INSERT INTO bot_arrests (roblox_username, incident_summary, charges, sentence, proof, submitted_by, submitted_by_tag)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [roblox_username, incident_summary, charges, sentence, proof, submitted_by, submitted_by_tag]
  );
  return res.rows[0];
}

async function getArrestsByRoblox(roblox_username) {
  const res = await pool.query(`SELECT * FROM bot_arrests WHERE LOWER(roblox_username)=LOWER($1) ORDER BY created_at DESC`, [roblox_username]);
  return res.rows;
}

async function getArrestById(id) {
  const res = await pool.query(`SELECT * FROM bot_arrests WHERE id=$1`, [id]);
  return res.rows[0];
}

async function addEdit({ arrest_id, edited_by, edited_by_tag, before }) {
  const res = await pool.query(
    `INSERT INTO bot_arrest_edits (arrest_id, edited_by, edited_by_tag, before_incident_summary, before_charges, before_sentence, before_proof)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [arrest_id, edited_by, edited_by_tag, before.incident_summary, before.charges, before.sentence, before.proof]
  );
  return res.rows[0];
}

async function getEditsForArrest(arrest_id) {
  const res = await pool.query(`SELECT * FROM bot_arrest_edits WHERE arrest_id=$1 ORDER BY edited_at DESC`, [arrest_id]);
  return res.rows;
}

async function updateArrest(id, { incident_summary, charges, sentence, proof }) {
  const res = await pool.query(
    `UPDATE bot_arrests SET incident_summary=$1, charges=$2, sentence=$3, proof=$4 WHERE id=$5 RETURNING *`,
    [incident_summary, charges, sentence, proof, id]
  );
  return res.rows[0];
}

async function deleteArrest(id) {
  await pool.query(`DELETE FROM bot_arrest_edits WHERE arrest_id=$1`, [id]);
  const res = await pool.query(`DELETE FROM bot_arrests WHERE id=$1 RETURNING *`, [id]);
  return res.rows[0];
}

module.exports = {
  init,
  createArrest,
  getArrestsByRoblox,
  getArrestById,
  addEdit,
  getEditsForArrest,
  updateArrest,
  deleteArrest
};
