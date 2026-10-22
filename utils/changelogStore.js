const { pool } = require('./db/db');
const axios = require('axios');
const config = require('../config');
const fs = require('fs').promises;
const path = require('path');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const CACHE_FILE = path.join(__dirname, '..', 'data', 'changelog_cache.json');

async function _fetchLatestVersionFromGitHub() {
  const repo = process.env.GITHUB_REPO || config.GITHUB_REPO;
  if (!repo) return null;
  // Try file cache first
  try {
    const raw = await fs.readFile(CACHE_FILE, 'utf8').catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version && parsed.ts && (Date.now() - parsed.ts) < CACHE_TTL_MS) {
          return parsed.version;
        }
      } catch (e) {
        // ignore parse errors and continue to fetch
      }
    }
  } catch (e) {
    // ignore cache read errors
  }

  try {
    const url = `https://api.github.com/repos/${repo}/commits?per_page=1`;
    const headers = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'AgentOS-Changelog'
    };
    const res = await axios.get(url, { headers, timeout: 5000 });
    if (!res.data || !Array.isArray(res.data) || res.data.length === 0) return null;
    const commit = res.data[0];
    const msg = (commit && commit.commit && commit.commit.message) ? String(commit.commit.message).split('\n')[0] : '';
    const m = msg.match(/^\s*v?(\d+(?:\.\d+)*)/);
    const found = (m && m[1]) ? m[1] : null;
    if (found) {
      const payload = JSON.stringify({ version: found, ts: Date.now() });
      fs.writeFile(CACHE_FILE, payload, 'utf8').catch(() => {});
      return found;
    }
    return null;
  } catch (e) {
    // On any network or API error, ignore and return null (caller falls back to DB)
    return null;
  }
}

async function getChangelog() {
  const res = await pool.query('SELECT version, additions, notes, updated_at FROM bot_changelog WHERE id = $1', [1]);
  if (!res.rows[0]) return { version: '', additions: '', notes: '', updatedAt: null };
  const row = res.rows[0];

  // Try to get the latest version from GitHub; fall back to stored DB version
  const ghVersion = await _fetchLatestVersionFromGitHub();
  const version = ghVersion || (row.version || '');

  return { version, additions: row.additions || '', notes: row.notes || '', updatedAt: row.updated_at ? row.updated_at.toISOString() : null };
}

async function resolveVersionForSave(version) {
  const trimmed = typeof version === 'string' ? version.trim() : '';
  if (trimmed) return trimmed;
  const latest = await _fetchLatestVersionFromGitHub();
  if (latest) return latest;
  const current = await getChangelog();
  return current.version || '';
}

async function setChangelog({ version, additions, notes }) {
  const resolvedVersion = await resolveVersionForSave(version);
  const res = await pool.query(
    `UPDATE bot_changelog SET version = $1, additions = $2, notes = $3, updated_at = NOW() WHERE id = $4 RETURNING version, additions, notes, updated_at`,
    [resolvedVersion, additions || '', notes || '', 1]
  );
  const row = res.rows[0];
  return { version: row.version, additions: row.additions, notes: row.notes, updatedAt: row.updated_at ? row.updated_at.toISOString() : null };
}

module.exports = { getChangelog, setChangelog, resolveVersionForSave };
