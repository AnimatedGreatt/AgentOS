const axios = require('axios');
const rankConfig = require('../../rankconfig.json');
const verificationStore = require('./verificationStore');

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function roleidvalidation(value) {
  return /^\d{16,20}$/.test(String(value || ''));
}

function groupconfigs() {
  return Object.values(rankConfig.groups || {});
}

function makenick(username, rankPrefixes, departmentPrefixes) {
  const prefixes = [...rankPrefixes, ...departmentPrefixes].filter(Boolean);
  const label = prefixes.length ? `[${prefixes.join(' ')}] ` : '';
  const maxlength = Math.max(0, 32 - Array.from(label).length);
  return `${label}${Array.from(String(username || '').trim()).slice(0, maxlength).join('')}`.slice(0, 32);
}

async function update(member, username, rankPrefixes = [], departmentPrefixes = []) {
  const nickname = makenick(username, rankPrefixes, departmentPrefixes);
  if (member.nickname !== nickname) {
    await member.setNickname(nickname);
  }
  return nickname;
}

async function getgroupmemberships(robloxUserId) {
  const response = await axios.get(
    `https://groups.roblox.com/v2/users/${encodeURIComponent(robloxUserId)}/groups/roles`
  );
  return Array.isArray(response.data?.data) ? response.data.data : [];
}

function findmembership(groups, groupConfig) {
  return groups.find(group =>
    Number(group.group?.id) === Number(groupConfig.groupid)
  );
}

function findrankmapping(groupConfig, rankName) {
  const rankmap = Array.isArray(groupConfig.rankmap) ? groupConfig.rankmap : [];
  return rankmap.find(mapping => normalize(mapping.name) === normalize(rankName));
}

async function getdepartmentprefixes(member, membership, groupConfig) {
  const departments = Array.isArray(groupConfig.departmentmap)
    ? groupConfig.departmentmap.filter(department =>
      roleidvalidation(department.roleid) && String(department.prefix || '').trim()
    )
    : [];
  if (!membership || !departments.length) return [];

  const response = await axios.get(
    `https://groups.roblox.com/v1/groups/${encodeURIComponent(groupConfig.groupid)}/roles`
  );
  const roles = Array.isArray(response.data?.roles) ? response.data.roles : [];
  const minrank = roles.find(role =>
    normalize(role.name) === normalize(groupConfig.departmentnickname)
  )?.rank;
  if (!Number.isFinite(Number(minrank)) || Number(membership.role?.rank) < Number(minrank)) return [];

  return departments
    .filter(department => member.roles.cache.has(department.roleid))
    .map(department => String(department.prefix).trim());
}

async function syncmember(client, { discordId, robloxUserId, robloxUsername }) {
  const guild = await client.guilds.fetch(rankConfig.testserver);
  const member = await guild.members.fetch(discordId);
  const groups = await getgroupmemberships(robloxUserId);
  const configuredGroups = groupconfigs();
  const desiredRoleIds = new Set();
  const managedRoleIds = new Set();
  const rankPrefixes = [];
  let hasMembership = false;
  let hasUnmappedRank = false;
  let departmentPrefixes = [];

  for (const groupConfig of configuredGroups) {
    const baseroles = Array.isArray(groupConfig.baseroles) ? groupConfig.baseroles : [];
    const rankmap = Array.isArray(groupConfig.rankmap) ? groupConfig.rankmap : [];
    const membership = findmembership(groups, groupConfig);

    for (const roleId of baseroles) {
      if (roleidvalidation(roleId)) {
        managedRoleIds.add(roleId);
        if (membership) desiredRoleIds.add(roleId);
      }
    }
    for (const mapping of rankmap) {
      if (roleidvalidation(mapping.roleid)) managedRoleIds.add(mapping.roleid);
    }

    if (!membership) continue;
    hasMembership = true;

    const rankName = String(membership.role?.name || '').trim();
    const rankMapping = findrankmapping(groupConfig, rankName);
    if (rankmap.length && !rankMapping) hasUnmappedRank = true;

    if (rankMapping && roleidvalidation(rankMapping.roleid)) {
      desiredRoleIds.add(rankMapping.roleid);
    }
    if (groupConfig.prefixes !== false && rankMapping && String(rankMapping.prefix || '').trim()) {
      rankPrefixes.push(String(rankMapping.prefix).trim());
    }
    if (groupConfig.prefixes !== false && groupConfig.departmentmap) {
      departmentPrefixes = await getdepartmentprefixes(member, membership, groupConfig);
    }
  }

  const removeroles = [...managedRoleIds].filter(roleId =>
    member.roles.cache.has(roleId) && !desiredRoleIds.has(roleId)
  );
  const addRoleIds = [...desiredRoleIds].filter(roleId => !member.roles.cache.has(roleId));

  if (removeroles.length) {
    await member.roles.remove(removeroles);
  }
  if (addRoleIds.length) {
    await member.roles.add(addRoleIds);
  }

  const nickname = await update(member, robloxUsername, rankPrefixes, departmentPrefixes);
  return {
    status: !hasMembership ? 'nogroup' : hasUnmappedRank ? 'ranknotfound' : 'allg',
    nickname,
    addedRoles: addRoleIds,
    removedRoles: removeroles
  };
}

async function syncdepartment(member) {
  const verification = await verificationStore.getByDiscord(member.id);
  if (!verification || !verification.roblox_userid) return { status: 'unverified' };

  const groups = await getgroupmemberships(verification.roblox_userid);
  const rankPrefixes = [];
  let departmentPrefixes = [];
  let hasMembership = false;

  for (const groupConfig of groupconfigs()) {
    const membership = findmembership(groups, groupConfig);
    if (!membership) continue;
    hasMembership = true;

    const rankName = String(membership.role?.name || '').trim();
    const rankMapping = findrankmapping(groupConfig, rankName);
    if (groupConfig.prefixes !== false && rankMapping && String(rankMapping.prefix || '').trim()) {
      rankPrefixes.push(String(rankMapping.prefix).trim());
    }
    if (groupConfig.prefixes !== false && groupConfig.departmentmap) {
      departmentPrefixes = await getdepartmentprefixes(member, membership, groupConfig);
    }
  }

  const nickname = await update( member, verification.roblox_username, rankPrefixes, departmentPrefixes );
  return { status: hasMembership ? 'updated' : 'nogroup', nickname };
}

async function syncroleupdate(oldMember, newMember) {
  if (newMember.guild.id !== String(rankConfig.testserver)) return null;

  const departmentids = groupconfigs()
    .flatMap(groupConfig => Array.isArray(groupConfig.departmentmap) ? groupConfig.departmentmap : [])
    .map(department => department.roleid)
    .filter(roleidvalidation);
  const departmentchange = departmentids.some(roleId =>
    oldMember.roles.cache.has(roleId) !== newMember.roles.cache.has(roleId)
  );
  if (!departmentchange) return null;

  return syncdepartment(newMember);
}

module.exports = { syncmember, syncroleupdate };