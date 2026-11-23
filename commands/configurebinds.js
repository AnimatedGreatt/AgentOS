const { SlashCommandBuilder, ActionRowBuilder, ContainerBuilder, LabelBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const bindStore = require('../utils/verification/bindStore');
const auditLog = require('../utils/verification/auditLog');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('configurebinds')
    .setDescription('Manage Roblox group role bindings')
    .setDMPermission(false),

  async execute(interaction) {
    return interaction.reply({
      components: [buildPanel()],
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2
    });
  },

  handleSelect, handleModal
};

const Options = [
  { value: 'list', label: 'Show groups' },
  { value: 'add-group', label: 'Add group' },
  { value: 'configure-group', label: 'Edit group' },
  { value: 'remove-group', label: 'Remove group' },
  { value: 'manage-base-roles', label: 'Manage base roles' },
  { value: 'manage-ranks', label: 'Manage ranks' },
  { value: 'manage-departments', label: 'Manage departments' }
];

const MFields = {
  'add-group': [
    { id: 'key', label: 'Group key', required: true, placeholder: 'e.g. sgcgroup' },
    { id: 'group_id', label: 'Roblox group ID', required: true, placeholder: 'Numbers only' },
    { id: 'prefixes', label: 'Prefixes? (true/false)', required: true, placeholder: 'true or false', maxLength: 5 },
    { id: 'departments', label: 'Departments? (true/false)', required: true, placeholder: 'true or false', maxLength: 5 }
  ],
  'configure-group': [
    { id: 'key', label: 'Group key', required: true },
    { id: 'group_id', label: 'Roblox group ID', required: true },
    { id: 'prefixes', label: 'Prefixes? (true/false)', required: true, maxLength: 5 },
    { id: 'departments', label: 'Departments? (true/false)', required: true, maxLength: 5 }
  ],
  'manage-base-roles': [
    { id: 'key', label: 'Group key', required: true },
    { id: 'action', label: 'Action (add/remove)', required: true, placeholder: 'add or remove', maxLength: 6 },
    { id: 'role_id', label: 'Discord role ID', required: true }
  ],
  'manage-ranks': [
    { id: 'key', label: 'Group key', required: true },
    { id: 'action', label: 'Action (add/remove)', required: true, placeholder: 'add or remove', maxLength: 6 },
    { id: 'rank', label: 'Roblox rank name', required: true },
    { id: 'role_id', label: 'Discord role ID (optional)', required: false },
    { id: 'prefix', label: 'Nickname prefix', required: false }
  ],
  'manage-departments': [
    { id: 'key', label: 'Group key', required: true },
    { id: 'action', label: 'Action (add/remove)', required: true, placeholder: 'add or remove', maxLength: 6 },
    { id: 'department', label: 'Department name', required: true },
    { id: 'role_id', label: 'Discord role ID', required: false },
    { id: 'prefix', label: 'Nickname prefix', required: false }
  ],
  'department-threshold': [
    { id: 'key', label: 'Group key', required: true },
    { id: 'department_rank', label: 'Department threshold rank', required: true }
  ]
};

function buildPanel(details = 'Choose an action below.') {
  const actionMenu = new StringSelectMenuBuilder()
    .setCustomId('configurebinds:action:menu')
    .setPlaceholder('Choose an action')
    .addOptions(Options.map(option => ({
      label: option.label,
      value: option.value
    })));

  return new ContainerBuilder()
    .addTextDisplayComponents(
      new TextDisplayBuilder().setContent('## Configure binds')
    )
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(details))
    .addActionRowComponents(new ActionRowBuilder().addComponents(actionMenu));
}

function getModal(action, groupKey, group) {
  const modalFields = MFields[action];
  if (!modalFields) throw new Error('Unknown binding action.');

  const modal = new ModalBuilder()
    .setCustomId(`configurebinds:modal:${action}`)
    .setTitle(Options.find(item => item.value === action)?.label || 'Department threshold');

  for (const field of modalFields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(TextInputStyle.Short)
      .setRequired(field.required);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    if (field.maxLength) input.setMaxLength(field.maxLength);
    if (action === 'configure-group' && group) {
      const currentValues = {
        key: groupKey,
        group_id: String(group.groupid),
        prefixes: group.prefixes === false ? 'false' : 'true',
        departments: group.departments === false ? 'false' : 'true'
      };
      input.setValue(currentValues[field.id]);
    }
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

function buildGroupPicker(action, groups, page = 0) {
  const entries = Object.entries(groups);
  const pageSize = 23;
  const pageCount = Math.ceil(entries.length / pageSize);
  page = Math.min(Math.max(page, 0), Math.max(pageCount - 1, 0));
  const options = entries.slice(page * pageSize, (page + 1) * pageSize).map(([key, group]) => ({
    label: `${key} (${group.groupid})`.slice(0, 100),
    value: key
  }));
  if (page > 0) options.push({ label: 'Previous page', value: '@previous' });
  if (page + 1 < pageCount) options.push({ label: 'Next page', value: '@next' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`configurebinds:action:group:${action}:${page}`)
    .setPlaceholder('Choose a group')
    .addOptions(options);

  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      action === 'remove-group' ? '## Remove group' : '## Edit group'
    ))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      pageCount > 1 ? `Choose a configured group. Page ${page + 1} of ${pageCount}.` : 'Choose a configured group.'
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(menu));
}

function getRemoveGroupModal(groups, page = 0) {
  const entries = Object.entries(groups);
  const pageSize = 23;
  const pageCount = Math.ceil(entries.length / pageSize);
  page = Math.min(Math.max(page, 0), Math.max(pageCount - 1, 0));
  const options = entries.slice(page * pageSize, (page + 1) * pageSize).map(([key, group]) => ({
    label: `${key} (${group.groupid})`.slice(0, 100),
    value: key
  }));
  if (page > 0) options.push({ label: 'Previous page', value: '@previous' });
  if (page + 1 < pageCount) options.push({ label: 'Next page', value: '@next' });

  const menu = new StringSelectMenuBuilder()
    .setCustomId('group')
    .setPlaceholder('Choose a group to remove')
    .addOptions(options);
  return new ModalBuilder()
    .setCustomId(`configurebinds:modal:remove-group:${page}`)
    .setTitle('Remove group')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(pageCount > 1 ? `Group (page ${page + 1} of ${pageCount})` : 'Group')
        .setStringSelectMenuComponent(menu)
    );
}

function buildDepartmentMenu() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('configurebinds:action:departments')
    .setPlaceholder('Choose a department setting')
    .addOptions([
      { label: 'Manage department mapping', value: 'mapping' },
      { label: 'Set department threshold', value: 'threshold' }
    ]);

  return new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('## Manage departments'))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('Choose what to update.'))
    .addActionRowComponents(new ActionRowBuilder().addComponents(menu));
}

function getFields(interaction, action) {
  const values = {};
  for (const field of MFields[action]) {
    values[field.id] = interaction.fields.getTextInputValue(field.id).trim();
  }
  return values;
}

function parseBoolean(value, label) {
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error(`${label} must be "true" or "false".`);
}

function getAction(value) {
  const action = value.toLowerCase();
  if (action !== 'add' && action !== 'remove') {
    throw new Error('Action must be "add" or "remove".');
  }
  return action;
}

async function showBindings(interaction) {
  await interaction.update({
    components: [buildPanel('Loading configured bindings...')]
  });

  try {
    const groups = await bindStore.getGroups();
    const lines = Object.entries(groups || {}).map(([key, group]) => {
      const baseRoles = Array.isArray(group.baseroles) ? group.baseroles : [];
      const ranks = Array.isArray(group.rankmap) ? group.rankmap : [];
      const departments = Array.isArray(group.departmentmap) ? group.departmentmap : [];
      const rankLines = ranks.map(rank =>
        `  ${rank.name}: ${rank.roleid ? `<@&${rank.roleid}>` : 'no role'}${rank.prefix ? ` (prefix: ${rank.prefix})` : ''}`
      );
      const departmentLines = departments.map(department =>
        `  ${department.name}: <@&${department.roleid}> (prefix: ${department.prefix})`
      );
      return [
        `**${key}** — group \`${group.groupid}\`, prefixes ${group.prefixes === false ? 'off' : 'on'}, departments ${group.departments === false ? 'off' : 'on'}`,
        `  Base roles: ${baseRoles.length ? baseRoles.map(roleId => `<@&${roleId}>`).join(', ') : 'none'}`,
        ...(group.departmentnickname ? [`  Department threshold: ${group.departmentnickname}`] : []),
        ...rankLines,
        ...departmentLines
      ].join('\n');
    });
    const details = lines.length ? lines.join('\n\n').slice(0, 3900) : 'No Roblox group bindings are configured.';
    await interaction.editReply({
      components: [buildPanel(details)]
    });
  } catch (error) {
    console.error('Failed to list Roblox group bindings:', error);
    await interaction.editReply({
      components: [buildPanel('An error occurred while configuring binds. Contact the Department of Engineering.')]
    });
  }
}

async function handleSelect(interaction) {
  if (interaction.customId === 'configurebinds:action:departments') {
    const action = interaction.values[0] === 'threshold'
      ? 'department-threshold'
      : 'manage-departments';
    return interaction.showModal(getModal(action));
  }

  if (interaction.customId.startsWith('configurebinds:action:group:')) {
    const [, , , action, currentPage] = interaction.customId.split(':');
    const key = interaction.values[0];
    try {
      const groups = await bindStore.getGroups();
      if (!Object.keys(groups || {}).length) {
        return interaction.update({
          components: [buildPanel('No Roblox group bindings are configured.')]
        });
      }
      if (key === '@next' || key === '@previous') {
        const page = Number(currentPage) + (key === '@next' ? 1 : -1);
        return interaction.update({ components: [buildGroupPicker(action, groups, page)] });
      }
      const group = groups[key];
      if (!group) {
        return interaction.update({
          components: [buildPanel('That group no longer exists. Choose another action.')]
        });
      }
      if (action === 'configure-group') {
        return interaction.showModal(getModal(action, key, group));
      }
      await interaction.update({ components: [buildPanel('Removing group...')] });
      const message = await saveAction(interaction, action, { key });
      await interaction.editReply({ components: [buildPanel(message)] });
    } catch (error) {
      console.error(`configurebinds ${action} failed:`, error);
      await interaction.editReply({
        components: [buildPanel('An error occurred while configuring binds. Contact the Department of Engineering.')]
      });
    }
    return;
  }

  const action = interaction.values[0];
  if (action === 'list') return showBindings(interaction);
  if (action === 'manage-departments') {
    return interaction.update({ components: [buildDepartmentMenu()] });
  }
  if (action === 'configure-group' || action === 'remove-group') {
    try {
      const groups = await bindStore.getGroups();
      const entries = Object.entries(groups || {});
      if (!entries.length) {
        return interaction.update({
          components: [buildPanel('No Roblox group bindings are configured.')]
        });
      }
      if (action === 'remove-group') {
        return interaction.showModal(getRemoveGroupModal(groups));
      }
      return interaction.update({ components: [buildGroupPicker(action, groups)] });
    } catch (error) {
      console.error('Failed to load Roblox groups:', error);
      return interaction.update({
        components: [buildPanel('An error occurred while configuring binds. Contact the Department of Engineering.')]
      });
    }
  }
  return interaction.showModal(getModal(action));
}

async function applyAction(action, fields) {
  const key = bindStore.normalizekey(fields.key);

  switch (action) {
    case 'add-group': {
      const groupId = Number(fields.group_id);
      if (!/^\d+$/.test(fields.group_id)) throw new Error('Roblox group ID must be a positive integer.');
      const prefixes = parseBoolean(fields.prefixes, 'Prefix setting');
      const departments = parseBoolean(fields.departments, 'Departments setting');
      const savedKey = await bindStore.addGroup({ key, groupId, prefixes, departments });
      return `Added \`${savedKey}\` for Roblox group \`${groupId}\`.`;
    }
    case 'configure-group': {
      const groupId = fields.group_id
        ? (/^\d+$/.test(fields.group_id) ? Number(fields.group_id) : NaN)
        : undefined;
      if (Number.isNaN(groupId)) throw new Error('Roblox group ID must be a positive integer.');
      const prefixes = parseBoolean(fields.prefixes, 'Prefix setting');
      const departments = parseBoolean(fields.departments, 'Departments setting');
      await bindStore.configureGroup(key, { groupId, prefixes, departments });
      return `Updated \`${key}\`.`;
    }
    case 'remove-group':
      await bindStore.removeGroup(key);
      return `Removed \`${key}\`. Existing Discord roles are not removed automatically.`;
    case 'manage-base-roles': {
      const action = getAction(fields.action);
      if (action === 'add') {
        await bindStore.addBaseRole(key, fields.role_id);
        return `Added <@&${fields.role_id}> to \`${key}\`.`;
      }
      await bindStore.removeBaseRole(key, fields.role_id);
      return `Removed <@&${fields.role_id}> from \`${key}\`.`;
    }
    case 'manage-ranks': {
      const action = getAction(fields.action);
      if (action === 'remove') {
        await bindStore.removeRank(key, fields.rank);
        return `Removed **${fields.rank}** from \`${key}\`.`;
      }
      await bindStore.configureRank(key, {
        name: fields.rank,
        roleId: fields.role_id || undefined,
        prefix: fields.prefix || undefined
      });
      return `Saved rank mapping for **${fields.rank}** in \`${key}\`.`;
    }
    case 'manage-departments': {
      const action = getAction(fields.action);
      if (action === 'remove') {
        await bindStore.removeDepartment(key, fields.department);
        return `Removed **${fields.department}** from \`${key}\`.`;
      }
      await bindStore.configureDepartment(key, {
        name: fields.department,
        roleId: fields.role_id,
        prefix: fields.prefix
      });
      return `Saved department mapping for **${fields.department}** in \`${key}\`.`;
    }
    case 'department-threshold':
      await bindStore.configureGroup(key, { departmentRank: fields.department_rank });
      return `Updated the department threshold for \`${key}\`.`;
    default:
      throw new Error('Unknown binding action.');
  }
}

async function saveAction(interaction, action, values) {
  const key = bindStore.normalizekey(values.key);
  const groups = await bindStore.getGroups();
  const previousGroup = groups[key] || null;
  const message = await applyAction(action, values);

  const auditDetails = [
    `Updater: <@${interaction.user.id}> (ID: ${interaction.user.id})`,
    `Action: ${Options.find(option => option.value === action)?.label || action}`,
    ...Object.entries(values)
      .filter(([, value]) => value)
      .map(([field, value]) => `${field}: ${value}`)
  ].join('\n');
  try {
    await auditLog.send(interaction.client, 'Bind Settings Changed', auditDetails);
  } catch (error) {
    try {
      await bindStore.restoreGroup(key, previousGroup);
    } catch (rollbackError) {
      console.error('Failed to restore bind settings after audit logging failed:', rollbackError);
      throw rollbackError;
    }
    throw error;
  }
  return message;
}

async function handleModal(interaction) {
  const [, , action, currentPage] = interaction.customId.split(':');

  if (action === 'remove-group') {
    try {
      const groups = await bindStore.getGroups();
      if (!Object.keys(groups || {}).length) {
        return interaction.reply({
          content: 'No Roblox group bindings are configured.',
          flags: MessageFlags.Ephemeral
        });
      }
      const selected = interaction.fields.getStringSelectValues('group')[0];
      if (selected === '@next' || selected === '@previous') {
        const page = Number(currentPage) + (selected === '@next' ? 1 : -1);
        return interaction.showModal(getRemoveGroupModal(groups, page));
      }
      if (!groups[selected]) {
        return interaction.reply({
          content: 'That group no longer exists. Run `/configurebinds` again.',
          flags: MessageFlags.Ephemeral
        });
      }

      await interaction.reply({
        content: 'Removing group...',
        flags: MessageFlags.Ephemeral
      });
      const message = await saveAction(interaction, action, { key: selected });
      await interaction.editReply({ content: message });
    } catch (error) {
      console.error('configurebinds remove-group failed:', error);
      if (interaction.replied) {
        await interaction.editReply({
          content: 'An error occurred while configuring binds. Contact the Department of Engineering.'
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while configuring binds. Contact the Department of Engineering.',
          flags: MessageFlags.Ephemeral
        });
      }
    }
    return;
  }

  await interaction.reply({
    content: 'Saving binding changes...',
    flags: MessageFlags.Ephemeral
  });

  try {
    const values = getFields(interaction, action);
    const message = await saveAction(interaction, action, values);
    await interaction.editReply({ content: message });
  } catch (error) {
    console.error(`configurebinds ${action} failed:`, error);
    await interaction.editReply({
      content: 'An error occurred while configuring binds. Contact the Department of Engineering.'
    });
  }
}