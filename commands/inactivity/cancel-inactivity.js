const { SlashCommandBuilder } = require('discord.js');
const config = require('../../config');
const { getAll, removeEntry } = require('../../utils/inactivity/inactivityStore');
const { setEndDateForUser } = require('../../utils/inactivity/inactivityHandler');

function parseApproverRoles() {
  if (!config.INACTIVITY_APPROVER_ROLE_IDS) return [];
  return String(config.INACTIVITY_APPROVER_ROLE_IDS).split(',').map(s => s.trim()).filter(Boolean);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('cancel-inactivity')
    .setDescription('Cancel an active inactivity (IN) entry prematurely')
    .addStringOption(o => o.setName('username').setDescription('Roblox username whose IN to cancel').setRequired(true)),
  
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // permission: must have one of the approver roles, or fallback to REQUIRED_ROLE_ID
    const approverRoles = parseApproverRoles();
    const allowedRoles = approverRoles.length ? approverRoles : [config.REQUIRED_ROLE_ID];
    const hasPerm = interaction.member && interaction.member.roles && allowedRoles.some(r => interaction.member.roles.cache.has(r));
    if (!hasPerm) return interaction.editReply({ content: '❌ You do not have permission to cancel inactivity entries.', ephemeral: true });

    const optUsername = interaction.options.getString('username');
    if (!optUsername) return interaction.editReply({ content: 'You must provide a Roblox username to cancel.', ephemeral: true });

    try {
      const rows = await getAll();
      const qUsername = String(optUsername).toLowerCase();

      const found = rows.find(r => String(r.roblox_username).toLowerCase() === qUsername);
      if (!found) return interaction.editReply({ content: 'No active inactivity entry found for that user.', ephemeral: true });

      // Remove DB entry
      await removeEntry(found.roblox_username).catch(err => { throw err; });

      // Clear end date cell in sheet (if possible)
      try {
        await setEndDateForUser({ username: found.roblox_username }, '');
      } catch (err) {
        console.warn('Failed to clear sheet end date for', found.roblox_username, err);
      }

      // DM the discord user if we have an id
      if (found.discord_id) {
        try {
          const u = await interaction.client.users.fetch(found.discord_id).catch(() => null);
          if (u) await u.send(`Your inactivity notice with the username ${found.roblox_username} has been cancelled prematurely by ${interaction.user.tag}.`).catch(() => null);
        } catch (err) {
          console.warn('Failed to DM user after cancelling IN:', err);
        }
      }

      await interaction.editReply({ content: `✅ Inactivity for ${found.roblox_username} cancelled and removed from active IN list by ${interaction.user.tag}.`, ephemeral: true });
    } catch (err) {
      console.error('cancel-inactivity error:', err);
      await interaction.editReply({ content: 'An error occurred while cancelling inactivity.', ephemeral: true });
    }
  }
};
