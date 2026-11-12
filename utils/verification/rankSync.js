const axios = require('axios');
const rankConfig = require('../../rankconfig.json');
const verificationStore = require('./verificationStore');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function roleidvalidation(value) {
  return /^\d{16,20}$/.test(String(value || ''));
}

function makenick(username, rankPrefix, departmentPrefixes) {
  const prefixes = [rankPrefix, ...departmentPrefixes].filter(Boolean);
  const label = prefixes.length ? `[${prefixes.join(' ')}] ` : '';
  const maxlength = Math.max(0, 32 - Array.from(label).length);
  return `${label}${Array.from(String(username || '').trim()).slice(0, maxlength).join('')}`.slice(0, 32);
}

async function update(member, username, rankPrefix = '', departmentPrefixes = []) {
  const nickname = makenick(username, rankPrefix, departmentPrefixes);
  if (member.nickname !== nickname) {
    await member.setNickname(nickname);
  }
  return nickname;
}

async function depprefixes(member, rank) {
  const departments = rankConfig.departmentmap.filter(department =>
    roleidvalidation(department.roleid) && String(department.prefix || '').trim()
  );
  if (!departments.length) return [];

  const roleresponse = await axios.get(
    `https://groups.roblox.com/v1/groups/${encodeURIComponent(rankConfig.osigroup)}/roles`
  );
  const roles = Array.isArray(roleresponse.data?.roles) ? roleresponse.data.roles : [];
  const minrank = roles.find(role =>
    normalize(role.name) === normalize(rankConfig.departmentnickname)
  )?.rank;
  if (!Number.isFinite(Number(minrank)) || Number(rank) < Number(minrank)) return [];

  return departments
    .filter(department => member.roles.cache.has(department.roleid))
    .map(department => String(department.prefix).trim());
}

async function syncmember(client, { discordId, robloxUserId, robloxUsername }) {
  const guild = await client.guilds.fetch(rankConfig.testserver);
  const member = await guild.members.fetch(discordId);

  const response = await axios.get(
    `https://groups.roblox.com/v2/users/${encodeURIComponent(robloxUserId)}/groups/roles`
  );
  const groups = Array.isArray(response.data?.data) ? response.data.data : [];
  const membership = groups.find(group => Number(group.group?.id) === Number(rankConfig.osigroup));

  if (!membership) {
    const nickname = await update(member, robloxUsername);
    return { status: 'nogroup', nickname };
  }

  const rankName = String(membership.role?.name || '').trim();
  const rankMapping = rankConfig.rankmap.find(mapping => normalize(mapping.name) === normalize(rankName));
  const baseroles = rankConfig.baseroles.filter(roleidvalidation);
  const mappedRankRoleIds = rankConfig.rankmap.map(mapping => mapping.roleid).filter(roleidvalidation);
  const desiredRoleIds = new Set(baseroles);
  if (rankMapping && roleidvalidation(rankMapping.roleid)) desiredRoleIds.add(rankMapping.roleid);

  const managedRoleIds = new Set([...baseroles, ...mappedRankRoleIds]);
  const removeRoleIds = [...managedRoleIds].filter(roleId =>
    member.roles.cache.has(roleId) && !desiredRoleIds.has(roleId)
  );
  const addRoleIds = [...desiredRoleIds].filter(roleId => !member.roles.cache.has(roleId));

  if (removeRoleIds.length) {
    await member.roles.remove(removeRoleIds);
  }
  if (addRoleIds.length) {
    await member.roles.add(addRoleIds);
  }

  const rankPrefix = rankMapping ? String(rankMapping.prefix || '').trim() : '';
  const departmentPrefixes = await depprefixes(member, membership.role?.rank);
  const nickname = await update(member, robloxUsername, rankPrefix, departmentPrefixes);

  return {
    status: rankMapping ? 'allg' : 'ranknotfound',
    rankName,
    nickname,
    addedRoles: addRoleIds,
    removedRoles: removeRoleIds
  };
}

async function syncdepartment(member) {
  const verification = await verificationStore.getByDiscord(member.id);
  if (!verification || !verification.roblox_userid) return { status: 'unverified' };

  const response = await axios.get(
    `https://groups.roblox.com/v2/users/${encodeURIComponent(verification.roblox_userid)}/groups/roles`
  );
  const groups = Array.isArray(response.data?.data) ? response.data.data : [];
  const membership = groups.find(group => Number(group.group?.id) === Number(rankConfig.osigroup));

  if (!membership) {
    const nickname = await update(member, verification.roblox_username);
    return { status: 'nogroup', nickname };
  }

  const rankName = String(membership.role?.name || '').trim();
  const rankMapping = rankConfig.rankmap.find(mapping => normalize(mapping.name) === normalize(rankName));
  const rankPrefix = rankMapping ? String(rankMapping.prefix || '').trim() : '';
  const departmentPrefixes = await depprefixes(member, membership.role?.rank);
  const nickname = await update(
    member,
    verification.roblox_username,
    rankPrefix,
    departmentPrefixes
  );

  return { status: 'updated', nickname };
}

async function syncroleupdate(oldMember, newMember) {
  if (newMember.guild.id !== String(rankConfig.testserver)) return null;

  const departmentids = rankConfig.departmentmap
    .map(department => department.roleid)
    .filter(roleidvalidation);
  const departmentchange = departmentids.some(roleId =>
    oldMember.roles.cache.has(roleId) !== newMember.roles.cache.has(roleId)
  );
  if (!departmentchange) return null;

  return syncdepartment(newMember);
}

module.exports = { syncmember, syncroleupdate };