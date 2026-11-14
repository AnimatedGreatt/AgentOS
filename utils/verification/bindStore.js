const axios = require('axios');
const crypto = require('crypto');
const rankConfig = require('../../rankconfig.json');
const serviceAccount = require('../../agentos-c3e04-firebase-adminsdk-fbsvc-3223816f6b.json');
const databaseUrl = 'https://agentos-c3e04-default-rtdb.firebaseio.com';
const requestTimeout = 30000;
const encoder = new TextEncoder();
const oauthTokenUrl = 'https://oauth2.googleapis.com/token';

let accessToken = null;
let tokenExpiresAt = 0;

function base64url(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return Buffer.from(bytes).toString('base64url');
}

function privateKeyBytes(privateKey) {
  const encoded = privateKey.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}

function responseErrorMessage(error) {
  const data = error.response?.data;
  if (typeof data === 'string') return data;
  if (typeof data?.error === 'string') return data.error_description || data.error;
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  return error.message || 'Unknown error';
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database',
    aud: oauthTokenUrl,
    iat: now,
    exp: now + 3600
  }));
  const unsignedToken = `${header}.${payload}`;
  const privateKey = await crypto.webcrypto.subtle.importKey(
    'pkcs8',
    privateKeyBytes(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.webcrypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(unsignedToken)
  ));
  const assertion = `${unsignedToken}.${base64url(signature)}`;
  let response;
  try {
    response = await axios.post(
      oauthTokenUrl,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: requestTimeout }
    );
  } catch (error) {
    const status = error.response?.status;
    throw new Error(
      `Firebase authentication failed${status ? ` (${status})` : ''}: ${responseErrorMessage(error)}`,
      { cause: error }
    );
  }
  if (!response.data?.access_token) throw new Error('Google did not return a Firebase access token.');
  accessToken = response.data.access_token;
  tokenExpiresAt = Date.now() + Number(response.data.expires_in || 3600) * 1000;
  return accessToken;
}

async function databaseRequest(method, databasePath, data) {
  const token = await getAccessToken();
  const url = `${databaseUrl}/${databasePath}.json`;
  let response;
  try {
    response = await axios({
      method,
      url,
      data,
      headers: { Authorization: `Bearer ${token}` },
      timeout: requestTimeout
    });
  } catch (error) {
    const status = error.response?.status;
    throw new Error(
      `Firebase ${method.toUpperCase()} ${databasePath} failed${status ? ` (${status})` : ''}: ${responseErrorMessage(error)}`,
      { cause: error }
    );
  }
  return response.data;
}

async function writeWithRollback(databasePath, value, previous) {
  try {
    await databaseRequest('put', databasePath, value);
  } catch (error) {
    try {
      if (previous === null) await databaseRequest('delete', databasePath);
      else await databaseRequest('put', databasePath, previous);
    } catch (rollbackError) {
      console.error(`Failed to restore Firebase value at ${databasePath}:`, rollbackError);
    }
    throw error;
  }
}

async function patchWithRollback(databasePath, changes, previous) {
  try {
    await databaseRequest('patch', databasePath, changes);
  } catch (error) {
    try {
      await databaseRequest('patch', databasePath, previous);
    } catch (rollbackError) {
      console.error(`Failed to restore Firebase fields at ${databasePath}:`, rollbackError);
    }
    throw error;
  }
}

function normalizeGroupKey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!key) throw new Error('Group key must contain letters or numbers.');
  return key;
}

function validateGroupId(groupId) {
  const id = Number(groupId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Roblox group ID must be a positive integer.');
  return id;
}

function validateRoleId(roleId) {
  const id = String(roleId || '');
  if (!/^\d{16,20}$/.test(id)) throw new Error('Discord role ID is invalid.');
  return id;
}

async function getGroups() {
  let groups = await databaseRequest('get', 'verificationBinds/groups');
  if (!groups) {
    groups = rankConfig.groups || {};
    await databaseRequest('put', 'verificationBinds/groups', groups);
  }
  return groups;
}

async function addGroup({ key, groupId, prefixes = false }) {
  const normalizedKey = normalizeGroupKey(key);
  const groups = await getGroups();
  if (groups[normalizedKey]) throw new Error(`Group "${normalizedKey}" is already configured.`);
  await writeWithRollback(`verificationBinds/groups/${normalizedKey}`, {
    groupid: validateGroupId(groupId),
    prefixes: Boolean(prefixes),
    baseroles: [],
    rankmap: []
  }, null);
  return normalizedKey;
}

async function configureGroup(key, changes) {
  const normalizedKey = normalizeGroupKey(key);
  const groups = await getGroups();
  if (!groups[normalizedKey]) throw new Error(`Group "${normalizedKey}" was not found.`);
  const updates = {};
  if (changes.groupId !== undefined) updates.groupid = validateGroupId(changes.groupId);
  if (changes.prefixes !== undefined) updates.prefixes = Boolean(changes.prefixes);
  if (changes.departmentRank !== undefined) updates.departmentnickname = String(changes.departmentRank).trim();
  if (!Object.keys(updates).length) throw new Error('No group settings were provided.');
  const previous = {};
  for (const field of Object.keys(updates)) {
    previous[field] = Object.prototype.hasOwnProperty.call(groups[normalizedKey], field)
      ? groups[normalizedKey][field]
      : null;
  }
  await patchWithRollback(`verificationBinds/groups/${normalizedKey}`, updates, previous);
  return normalizedKey;
}

async function removeGroup(key) {
  const normalizedKey = normalizeGroupKey(key);
  const groups = await getGroups();
  if (!groups[normalizedKey]) throw new Error(`Group "${normalizedKey}" was not found.`);
  const removed = groups[normalizedKey];
  await writeWithRollback(`verificationBinds/groups/${normalizedKey}`, null, removed);
  return { key: normalizedKey, group: removed };
}

async function addBaseRole(key, roleId) {
  const normalizedKey = normalizeGroupKey(key);
  const id = validateRoleId(roleId);
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const roles = Array.isArray(group.baseroles) ? group.baseroles : [];
  if (roles.includes(id)) throw new Error('That base role is already configured.');
  await writeWithRollback(
    `verificationBinds/groups/${normalizedKey}/baseroles`,
    [...roles, id],
    Array.isArray(group.baseroles) ? group.baseroles : null
  );
  return normalizedKey;
}

async function removeBaseRole(key, roleId) {
  const normalizedKey = normalizeGroupKey(key);
  const id = validateRoleId(roleId);
  const groups = await getGroups();
  const group = groups[normalizedKey];
  const roles = group && Array.isArray(group.baseroles) ? group.baseroles : [];
  if (!roles.includes(id)) throw new Error('That base role was not found.');
  await writeWithRollback(`verificationBinds/groups/${normalizedKey}/baseroles`, roles.filter(role => role !== id), roles);
  return normalizedKey;
}

async function configureRank(key, { name, roleId, prefix }) {
  const normalizedKey = normalizeGroupKey(key);
  const rankName = String(name || '').trim();
  if (!rankName) throw new Error('Rank name cannot be empty.');
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const rankmap = Array.isArray(group.rankmap) ? group.rankmap : [];
  const index = rankmap.findIndex(rank => String(rank.name || '').trim().toLowerCase() === rankName.toLowerCase());
  const mapping = index === -1 ? { name: rankName, roleid: '', prefix: '' } : { ...rankmap[index] };
  if (roleId !== undefined) mapping.roleid = roleId ? validateRoleId(roleId) : '';
  if (prefix !== undefined) mapping.prefix = String(prefix).trim();
  if (index === -1) rankmap.push(mapping);
  else rankmap[index] = mapping;
  await writeWithRollback(`verificationBinds/groups/${normalizedKey}/rankmap`, rankmap, group.rankmap || null);
  return normalizedKey;
}

async function removeRank(key, name) {
  const normalizedKey = normalizeGroupKey(key);
  const rankName = String(name || '').trim().toLowerCase();
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const rankmap = Array.isArray(group.rankmap) ? group.rankmap : [];
  const next = rankmap.filter(rank => String(rank.name || '').trim().toLowerCase() !== rankName);
  if (next.length === rankmap.length) throw new Error(`Rank "${name}" was not found.`);
  await writeWithRollback(`verificationBinds/groups/${normalizedKey}/rankmap`, next, rankmap);
  return normalizedKey;
}

async function configureDepartment(key, { name, roleId, prefix }) {
  const normalizedKey = normalizeGroupKey(key);
  const departmentName = String(name || '').trim();
  if (!departmentName) throw new Error('Department name cannot be empty.');
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const departments = Array.isArray(group.departmentmap) ? group.departmentmap : [];
  const index = departments.findIndex(department =>
    String(department.name || '').trim().toLowerCase() === departmentName.toLowerCase()
  );
  const mapping = index === -1
    ? { name: departmentName, roleid: '', prefix: '' }
    : { ...departments[index] };
  if (roleId !== undefined) mapping.roleid = roleId ? validateRoleId(roleId) : '';
  if (prefix !== undefined) mapping.prefix = String(prefix).trim();
  if (!mapping.roleid) throw new Error('A Discord role is required for a department mapping.');
  if (index === -1) departments.push(mapping);
  else departments[index] = mapping;
  await writeWithRollback(`verificationBinds/groups/${normalizedKey}/departmentmap`, departments, group.departmentmap || null);
  return normalizedKey;
}

async function removeDepartment(key, name) {
  const normalizedKey = normalizeGroupKey(key);
  const departmentName = String(name || '').trim().toLowerCase();
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const departments = Array.isArray(group.departmentmap) ? group.departmentmap : [];
  const next = departments.filter(department =>
    String(department.name || '').trim().toLowerCase() !== departmentName
  );
  if (next.length === departments.length) throw new Error(`Department "${name}" was not found.`);
  await writeWithRollback(`verificationBinds/groups/${normalizedKey}/departmentmap`, next, departments);
  return normalizedKey;
}

module.exports = {
  getGroups,
  addGroup,
  configureGroup,
  removeGroup,
  addBaseRole,
  removeBaseRole,
  configureRank,
  removeRank,
  configureDepartment,
  removeDepartment,
  normalizeGroupKey
};
