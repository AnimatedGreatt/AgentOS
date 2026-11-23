const db = require('../db/firebase');

function normalizekey(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!key) throw new Error('Group key must contain letters or numbers.');
  return key;
}

function validategroup(groupId) {
  const id = Number(groupId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Roblox group ID must be a positive integer.');
  return id;
}

function validaterole(roleId) {
  const id = String(roleId || '');
  if (!/^\d{16,20}$/.test(id)) throw new Error('Discord role ID is invalid.');
  return id;
}

async function databaseRequest(method, databasePath, data) {
  try {
    const ref = db.ref(databasePath);
    if (method === 'get') return (await ref.once('value')).val();
    if (method === 'put') return await ref.set(data);
    if (method === 'patch') return await ref.update(data);
    if (method === 'delete') return await ref.remove();
    throw new Error(`Unsupported Firebase operation: ${method}`);
  } catch (error) {
    throw new Error(
      `Firebase ${method.toUpperCase()} ${databasePath} failed: ${(error && error.message) || String(error)}`,
      { cause: error }
    );
  }
}

async function getGroups() {
  return (await databaseRequest('get', 'verificationBinds/groups')) || {};
}

async function addGroup({ key, groupId, prefixes = false, departments = true }) {
  const normalizedKey = normalizekey(key);
  const groups = await getGroups();
  if (groups[normalizedKey]) throw new Error(`Group "${normalizedKey}" is already configured.`);
  await databaseRequest('put', `verificationBinds/groups/${normalizedKey}`, {
    groupid: validategroup(groupId),
    prefixes: Boolean(prefixes),
    departments: Boolean(departments),
    baseroles: [],
    rankmap: [],
    departmentmap: []
  });
  return normalizedKey;
}

async function configureGroup(key, changes) {
  const normalizedKey = normalizekey(key);
  const groups = await getGroups();
  if (!groups[normalizedKey]) throw new Error(`Group "${normalizedKey}" was not found.`);
  const updates = {};
  if (changes.groupId !== undefined) updates.groupid = validategroup(changes.groupId);
  if (changes.prefixes !== undefined) updates.prefixes = Boolean(changes.prefixes);
  if (changes.departments !== undefined) updates.departments = Boolean(changes.departments);
  if (changes.departmentRank !== undefined) updates.departmentnickname = String(changes.departmentRank).trim();
  if (!Object.keys(updates).length) throw new Error('No group settings were provided.');
  await databaseRequest('patch', `verificationBinds/groups/${normalizedKey}`, updates);
  return normalizedKey;
}

async function removeGroup(key) {
  const normalizedKey = normalizekey(key);
  const groups = await getGroups();
  if (!groups[normalizedKey]) throw new Error(`Group "${normalizedKey}" was not found.`);
  const removed = groups[normalizedKey];
  await databaseRequest('delete', `verificationBinds/groups/${normalizedKey}`);
  return { key: normalizedKey, group: removed };
}

async function restoreGroup(key, group) {
  const normalizedKey = normalizekey(key);
  const path = `verificationBinds/groups/${normalizedKey}`;
  if (group === null || group === undefined) {
    await databaseRequest('delete', path);
    return;
  }
  await databaseRequest('put', path, group);
}

async function addBaseRole(key, roleId) {
  const normalizedKey = normalizekey(key);
  const id = validaterole(roleId);
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const roles = Array.isArray(group.baseroles) ? group.baseroles : [];
  if (roles.includes(id)) throw new Error('That base role is already configured.');
  await databaseRequest(
    'put',
    `verificationBinds/groups/${normalizedKey}/baseroles`,
    [...roles, id]
  );
  return normalizedKey;
}

async function removeBaseRole(key, roleId) {
  const normalizedKey = normalizekey(key);
  const id = validaterole(roleId);
  const groups = await getGroups();
  const group = groups[normalizedKey];
  const roles = group && Array.isArray(group.baseroles) ? group.baseroles : [];
  if (!roles.includes(id)) throw new Error('That base role was not found.');
  await databaseRequest(
    'put',
    `verificationBinds/groups/${normalizedKey}/baseroles`,
    roles.filter(role => role !== id)
  );
  return normalizedKey;
}

async function configureRank(key, { name, roleId, prefix }) {
  const normalizedKey = normalizekey(key);
  const rankName = String(name || '').trim();
  if (!rankName) throw new Error('Rank name cannot be empty.');
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const rankmap = Array.isArray(group.rankmap) ? group.rankmap : [];
  const index = rankmap.findIndex(rank => String(rank.name || '').trim().toLowerCase() === rankName.toLowerCase());
  const mapping = index === -1 ? { name: rankName, roleid: '', prefix: '' } : { ...rankmap[index] };
  if (roleId !== undefined) mapping.roleid = roleId ? validaterole(roleId) : '';
  if (prefix !== undefined) mapping.prefix = String(prefix).trim();
  if (index === -1) rankmap.push(mapping);
  else rankmap[index] = mapping;
  await databaseRequest('put', `verificationBinds/groups/${normalizedKey}/rankmap`, rankmap);
  return normalizedKey;
}

async function removeRank(key, name) {
  const normalizedKey = normalizekey(key);
  const rankName = String(name || '').trim().toLowerCase();
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const rankmap = Array.isArray(group.rankmap) ? group.rankmap : [];
  const next = rankmap.filter(rank => String(rank.name || '').trim().toLowerCase() !== rankName);
  if (next.length === rankmap.length) throw new Error(`Rank "${name}" was not found.`);
  await databaseRequest('put', `verificationBinds/groups/${normalizedKey}/rankmap`, next);
  return normalizedKey;
}

async function configureDepartment(key, { name, roleId, prefix }) {
  const normalizedKey = normalizekey(key);
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
  if (roleId !== undefined) mapping.roleid = roleId ? validaterole(roleId) : '';
  if (prefix !== undefined) mapping.prefix = String(prefix).trim();
  if (!mapping.roleid) throw new Error('A Discord role is required for a department mapping.');
  if (index === -1) departments.push(mapping);
  else departments[index] = mapping;
  await databaseRequest('put', `verificationBinds/groups/${normalizedKey}/departmentmap`, departments);
  return normalizedKey;
}

async function removeDepartment(key, name) {
  const normalizedKey = normalizekey(key);
  const departmentName = String(name || '').trim().toLowerCase();
  const groups = await getGroups();
  const group = groups[normalizedKey];
  if (!group) throw new Error(`Group "${normalizedKey}" was not found.`);
  const departments = Array.isArray(group.departmentmap) ? group.departmentmap : [];
  const next = departments.filter(department =>
    String(department.name || '').trim().toLowerCase() !== departmentName
  );
  if (next.length === departments.length) throw new Error(`Department "${name}" was not found.`);
  await databaseRequest('put', `verificationBinds/groups/${normalizedKey}/departmentmap`, next);
  return normalizedKey;
}

module.exports = { getGroups, addGroup, configureGroup, removeGroup, restoreGroup, addBaseRole, removeBaseRole, configureRank, removeRank, configureDepartment, removeDepartment, normalizekey };