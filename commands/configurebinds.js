const { SlashCommandBuilder, ActionRowBuilder, ContainerBuilder, MessageFlags, ModalBuilder, StringSelectMenuBuilder, TextDisplayBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const bindStore = require('../utils/verification/bindStore');

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
    { id: 'prefixes', label: 'Use prefixes? (true/false)', required: true, placeholder: 'true or false', maxLength: 5 }
  ],
  'configure-group': [
    { id: 'key', label: 'Group key', required: true },
    { id: 'group_id', label: 'New Roblox group ID (optional)', required: false },
    { id: 'prefixes', label: 'Use prefixes? (true/false)', required: false, placeholder: 'Leave blank to keep current setting', maxLength: 5 },
    { id: 'department_rank', label: 'Department threshold rank (optional)', required: false }
  ],
  'remove-group': [
    { id: 'key', label: 'Group key', required: true }
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

function getModal(action) {
  const modalFields = MFields[action];
  if (!modalFields) throw new Error('Unknown binding action.');

  const modal = new ModalBuilder()
    .setCustomId(`configurebinds:modal:${action}`)
    .setTitle(Options.find(item => item.value === action).label);

  for (const field of modalFields) {
    const input = new TextInputBuilder()
      .setCustomId(field.id)
      .setLabel(field.label)
      .setStyle(TextInputStyle.Short)
      .setRequired(field.required);
    if (field.placeholder) input.setPlaceholder(field.placeholder);
    if (field.maxLength) input.setMaxLength(field.maxLength);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  return modal;
}

function getFields(interaction, action) {
  const values = {};
  for (const field of MFields[action]) {
    values[field.id] = interaction.fields.getTextInputValue(field.id).trim();
  }
  return values;
}

function optionalB(value, label) {
  if (!value) return undefined;
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
        `**${key}** — group \`${group.groupid}\`, prefixes ${group.prefixes === false ? 'off' : 'on'}`,
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
  const action = interaction.values[0];
  if (action === 'list') return showBindings(interaction);
  return interaction.showModal(getModal(action));
}

async function applyAction(action, fields) {
  const key = bindStore.normalizeGroupKey(fields.key);

  switch (action) {
    case 'add-group': {
      const groupId = Number(fields.group_id);
      if (!/^\d+$/.test(fields.group_id)) throw new Error('Roblox group ID must be a positive integer.');
      const prefixes = optionalB(fields.prefixes, 'Prefix setting');
      const savedKey = await bindStore.addGroup({ key, groupId, prefixes });
      return `Added \`${savedKey}\` for Roblox group \`${groupId}\`.`;
    }
    case 'configure-group': {
      const groupId = fields.group_id
        ? (/^\d+$/.test(fields.group_id) ? Number(fields.group_id) : NaN)
        : undefined;
      if (Number.isNaN(groupId)) throw new Error('Roblox group ID must be a positive integer.');
      const prefixes = optionalB(fields.prefixes, 'Prefix setting');
      const departmentRank = fields.department_rank || undefined;
      await bindStore.configureGroup(key, { groupId, prefixes, departmentRank });
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
    default:
      throw new Error('Unknown binding action.');
  }
}

async function handleModal(interaction) {
  const action = interaction.customId.split(':')[2];

  await interaction.reply({
    content: 'Saving binding changes...',
    flags: MessageFlags.Ephemeral
  });

  try {
    const message = await applyAction(action, getFields(interaction, action));
    await interaction.editReply({ content: message });
  } catch (error) {
    console.error(`configurebinds ${action} failed:`, error);
    await interaction.editReply({
      content: 'An error occurred while configuring binds. Contact the Department of Engineering.'
    });
  }
}