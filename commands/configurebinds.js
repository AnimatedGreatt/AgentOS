const { SlashCommandBuilder } = require('discord.js');
const rankConfig = require('../rankconfig.json');
const bindStore = require('../utils/verification/bindStore');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('configurebinds')
    .setDescription('Manage Roblox group role bindings')
    .setDMPermission(false)
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List configured Roblox group bindings'))
    .addSubcommand(sub => sub
      .setName('add-group')
      .setDescription('Add a Roblox group binding')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding name, such as sgcgroup')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName('group_id')
          .setDescription('Roblox group ID')
          .setRequired(true)
          .setMinValue(1)
      )
      .addBooleanOption(option =>
        option
          .setName('prefixes')
          .setDescription('Use rank prefixes in nicknames')
          .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('configure-group')
      .setDescription('Change a group ID or nickname prefix setting')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding key')
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option
          .setName('group_id')
          .setDescription('New Roblox group ID')
          .setRequired(false)
          .setMinValue(1)
      )
      .addBooleanOption(option =>
        option
          .setName('prefixes')
          .setDescription('Use rank prefixes in nicknames')
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('department_rank')
          .setDescription('Minimum Roblox rank for department prefixes')
          .setRequired(false)
      )
    )
    .addSubcommand(sub => sub
      .setName('remove-group')
      .setDescription('Remove a Roblox group binding')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding key')
          .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('add-base-role')
      .setDescription('Give a role to every member of a Roblox group')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding key')
          .setRequired(true)
      )
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription('Discord role to add')
          .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('remove-base-role')
      .setDescription('Stop giving a base role to group members')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding key')
          .setRequired(true)
      )
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription('Discord role to remove from the binding')
          .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('set-rank')
      .setDescription('Add or update a Roblox rank mapping')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding key')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('rank')
          .setDescription('Exact Roblox rank name')
          .setRequired(true)
      )
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription('Discord role for this rank')
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('prefix')
          .setDescription('Optional nickname prefix')
          .setRequired(false)
      )
    )
    .addSubcommand(sub => sub
      .setName('remove-rank')
      .setDescription('Remove a Roblox rank mapping')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding key')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('rank')
          .setDescription('Exact Roblox rank name')
          .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('set-department')
      .setDescription('Add or update a department role and nickname prefix')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding key')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('department')
          .setDescription('Department name')
          .setRequired(true)
      )
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription('Discord department role')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('prefix')
          .setDescription('Nickname prefix')
          .setRequired(true)
      )
    )
    .addSubcommand(sub => sub
      .setName('remove-department')
      .setDescription('Remove a department role mapping')
      .addStringOption(option =>
        option
          .setName('key')
          .setDescription('Binding key')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('department')
          .setDescription('Exact department name')
          .setRequired(true)
      )
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (interaction.guildId !== String(rankConfig.testserver)) {
      return interaction.editReply({ content: 'This command is only available in the development server.' });
    }

    try {
      const action = interaction.options.getSubcommand();
      const key = interaction.options.getString('key');

      if (action === 'list') {
        const groups = await bindStore.getGroups();
        const lines = Object.entries(groups).map(([groupKey, group]) => {
          const baseRoles = Array.isArray(group.baseroles) ? group.baseroles : [];
          const ranks = Array.isArray(group.rankmap) ? group.rankmap : [];
          const rankLines = ranks.map(rank =>
            `  ${rank.name}: ${rank.roleid ? `<@&${rank.roleid}>` : 'no role'}${rank.prefix ? ` (prefix: ${rank.prefix})` : ''}`
          );
          const departmentLines = (Array.isArray(group.departmentmap) ? group.departmentmap : []).map(department =>
            `  ${department.name}: <@&${department.roleid}> (prefix: ${department.prefix})`
          );
          return [
            `**${groupKey}** — Roblox group \`${group.groupid}\`, prefixes ${group.prefixes === false ? 'off' : 'on'}`,
            `  Base roles: ${baseRoles.length ? baseRoles.map(roleId => `<@&${roleId}>`).join(', ') : 'none'}`,
            ...(group.departmentnickname ? [`  Department threshold: ${group.departmentnickname}`] : []),
            ...rankLines,
            ...departmentLines
          ].join('\n');
        });
        return interaction.editReply({
          content: lines.length ? lines.join('\n\n').slice(0, 1900) : 'No Roblox group bindings are configured.'
        });
      }

      if (action === 'add-group') {
        const groupId = interaction.options.getInteger('group_id', true);
        const prefixes = interaction.options.getBoolean('prefixes', true);
        const savedKey = bindStore.normalizeGroupKey(key);
        await bindStore.addGroup({ key: savedKey, groupId, prefixes });
        return interaction.editReply({ content: `Added \`${savedKey}\` for Roblox group \`${groupId}\`.` });
      }

      if (action === 'configure-group') {
        const groupId = interaction.options.getInteger('group_id');
        const prefixes = interaction.options.getBoolean('prefixes');
        const departmentRank = interaction.options.getString('department_rank');
        const groupKey = bindStore.normalizeGroupKey(key);
        const group = (await bindStore.getGroups())[groupKey];
        if (!group) throw new Error(`Group "${groupKey}" was not found.`);
        await bindStore.configureGroup(groupKey, {
          groupId: groupId ?? undefined,
          prefixes: prefixes ?? undefined,
          departmentRank: departmentRank ?? undefined
        });
        return interaction.editReply({ content: `Updated \`${groupKey}\`.` });
      }

      if (action === 'remove-group') {
        const groupKey = bindStore.normalizeGroupKey(key);
        const group = (await bindStore.getGroups())[groupKey];
        if (!group) throw new Error(`Group "${groupKey}" was not found.`);
        await bindStore.removeGroup(groupKey);
        return interaction.editReply({ content: `Removed \`${groupKey}\`. Existing Discord roles are not removed automatically.` });
      }

      if (action === 'add-base-role' || action === 'remove-base-role') {
        const role = interaction.options.getRole('role', true);
        const groupKey = bindStore.normalizeGroupKey(key);
        const group = (await bindStore.getGroups())[groupKey];
        if (!group) throw new Error(`Group "${groupKey}" was not found.`);
        const verb = action === 'add-base-role' ? 'added as a base role' : 'removed as a base role';
        if (action === 'add-base-role') await bindStore.addBaseRole(groupKey, role.id);
        else await bindStore.removeBaseRole(groupKey, role.id);
        return interaction.editReply({ content: `Role <@&${role.id}> ${verb} for \`${groupKey}\`.` });
      }

      if (action === 'set-rank') {
        const rank = interaction.options.getString('rank', true);
        const role = interaction.options.getRole('role');
        const prefix = interaction.options.getString('prefix');
        const groupKey = bindStore.normalizeGroupKey(key);
        const group = (await bindStore.getGroups())[groupKey];
        if (!group) throw new Error(`Group "${groupKey}" was not found.`);
        await bindStore.configureRank(groupKey, {
          name: rank,
          roleId: role ? role.id : undefined,
          prefix: prefix === null ? undefined : prefix
        });
        return interaction.editReply({ content: `Saved rank mapping for **${rank}** in \`${groupKey}\`.` });
      }

      if (action === 'remove-rank') {
        const rank = interaction.options.getString('rank', true);
        const groupKey = bindStore.normalizeGroupKey(key);
        const group = (await bindStore.getGroups())[groupKey];
        if (!group) throw new Error(`Group "${groupKey}" was not found.`);
        await bindStore.removeRank(groupKey, rank);
        return interaction.editReply({ content: `Removed **${rank}** from \`${groupKey}\`.` });
      }

      if (action === 'set-department') {
        const department = interaction.options.getString('department', true);
        const role = interaction.options.getRole('role', true);
        const prefix = interaction.options.getString('prefix', true);
        const groupKey = bindStore.normalizeGroupKey(key);
        const group = (await bindStore.getGroups())[groupKey];
        if (!group) throw new Error(`Group "${groupKey}" was not found.`);
        await bindStore.configureDepartment(groupKey, { name: department, roleId: role.id, prefix });
        return interaction.editReply({ content: `Saved department mapping for **${department}** in \`${groupKey}\`.` });
      }

      if (action === 'remove-department') {
        const department = interaction.options.getString('department', true);
        const groupKey = bindStore.normalizeGroupKey(key);
        const group = (await bindStore.getGroups())[groupKey];
        if (!group) throw new Error(`Group "${groupKey}" was not found.`);
        await bindStore.removeDepartment(groupKey, department);
        return interaction.editReply({ content: `Removed **${department}** from \`${groupKey}\`.` });
      }

      return interaction.editReply({ content: 'Unknown bind action.' });
    } catch (error) {
      console.error('configurebinds failed:', error);
      return interaction.editReply({ content: `Could not update bindings: ${error.message || String(error)}` });
    }
  }
};
