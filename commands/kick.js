const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const config = require('../config');

function hasAllowedKickRole(member) {
  const allowed = config.KICK_COMMAND_ALLOWED_ROLE_IDS_LIST || [];
  if (!allowed.length) return false;
  return member?.roles?.cache?.some(role => allowed.includes(role.id));
}

async function ensureCommandAccess(interaction) {
  if ((config.ADMIN_WHITELIST || []).includes(interaction.user.id)) return true;
  if (hasAllowedKickRole(interaction.member)) return true;
  return false;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDMPermission(false)
    .setDescription('Kick a user from one configured server and strip configured roles in another server')
    .addUserOption(option =>
      option
        .setName('user')
        .setDescription('User to process')
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('reason')
        .setDescription('Reason for kick (optional)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    if (!(await ensureCommandAccess(interaction))) {
      return interaction.editReply({ content: '❌ You are not allowed to use this command.', ephemeral: true });
    }

    const targetGuildId = config.KICK_TARGET_GUILD_ID;
    const stripGuildId = config.KICK_ROLE_STRIP_GUILD_ID;
    const kickLogChannelId = config.KICK_LOG_CHANNEL_ID;
    const stripRoleIds = config.KICK_ROLE_STRIP_ROLE_IDS_LIST || [];

    if (!targetGuildId || !stripGuildId) {
      return interaction.editReply({
        content: '⚠️ Command is not configured. Set KICK_TARGET_GUILD_ID and KICK_ROLE_STRIP_GUILD_ID.',
        ephemeral: true
      });
    }

    const user = interaction.options.getUser('user', true);
    const reasonInput = (interaction.options.getString('reason') || '').trim();
    const reason = reasonInput || `Action executed by ${interaction.user.tag} (${interaction.user.id})`;

    const summary = [];
    let didKick = false;
    let removedRoleCount = 0;

    // 1) Kick from configured target guild.
    try {
      const targetGuild = await interaction.client.guilds.fetch(targetGuildId).catch(() => null);
      if (!targetGuild) {
        summary.push(`⚠️ Could not access target guild ${targetGuildId}.`);
      } else {
        const me = await targetGuild.members.fetchMe().catch(() => null);
        if (!me || !me.permissions.has(PermissionsBitField.Flags.KickMembers)) {
          summary.push(`⚠️ I do not have Kick Members permission in ${targetGuild.name} (${targetGuild.id}).`);
        } else {
          const targetMember = await targetGuild.members.fetch(user.id).catch(() => null);
          if (!targetMember) {
            summary.push(`ℹ️ ${user.tag} is not in ${targetGuild.name}, so no kick was needed.`);
          } else if (!targetMember.kickable) {
            summary.push(`⚠️ ${user.tag} is in ${targetGuild.name}, but cannot be kicked (role hierarchy/permissions).`);
          } else {
            await targetMember.kick(reason);
            didKick = true;
            summary.push(`✅ Kicked ${user.tag} from ${targetGuild.name}.`);

            const dmEmbed = new EmbedBuilder()
              .setTitle('You Were Kicked')
              .setColor(0xED4245)
              .setDescription(`You were removed from **${targetGuild.name}**.`)
              .addFields({ name: 'Moderator', value: `${interaction.user.tag}`, inline: true })
              .setTimestamp(new Date());

            if (reasonInput) {
              dmEmbed.addFields({ name: 'Reason', value: reasonInput.slice(0, 1024), inline: false });
            }

            try {
              await user.send({ embeds: [dmEmbed] });
              summary.push('✅ Sent kick notice DM to affected user.');
            } catch (dmErr) {
              summary.push('⚠️ Could not DM the affected user.');
            }
          }
        }
      }
    } catch (err) {
      console.error('kick command: failed during target guild kick step', err);
      summary.push('⚠️ Failed while attempting kick action.');
    }

    // 2) Remove configured roles in configured strip guild.
    try {
      const stripGuild = await interaction.client.guilds.fetch(stripGuildId).catch(() => null);
      if (!stripGuild) {
        summary.push(`⚠️ Could not access role-strip guild ${stripGuildId}.`);
      } else if (!stripRoleIds.length) {
        summary.push(`ℹ️ No strip roles configured for ${stripGuild.name} (KICK_ROLE_STRIP_ROLE_IDS is empty).`);
      } else {
        const stripMember = await stripGuild.members.fetch(user.id).catch(() => null);
        if (!stripMember) {
          summary.push(`ℹ️ ${user.tag} is not in ${stripGuild.name}, so no roles were removed.`);
        } else {
          const existingRoleIds = stripRoleIds.filter(roleId => stripMember.roles.cache.has(roleId));
          if (!existingRoleIds.length) {
            summary.push(`ℹ️ ${user.tag} does not currently have any configured strip roles in ${stripGuild.name}.`);
          } else {
            await stripMember.roles.remove(existingRoleIds, `Role strip via /kick by ${interaction.user.tag} (${interaction.user.id})`);
            removedRoleCount = existingRoleIds.length;
            summary.push(`✅ Removed ${existingRoleIds.length} configured role(s) from ${user.tag} in ${stripGuild.name}.`);
          }
        }
      }
    } catch (err) {
      console.error('kick command: failed during role strip step', err);
      summary.push('⚠️ Failed while attempting role removal action.');
    }

    if (kickLogChannelId) {
      try {
        const logChannel = await interaction.client.channels.fetch(kickLogChannelId).catch(() => null);
        if (logChannel && logChannel.isTextBased()) {
          const logEmbed = new EmbedBuilder()
            .setTitle('Kick Command Log')
            .setColor(didKick ? 0x57F287 : 0xFEE75C)
            .addFields(
              { name: 'Moderator', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false },
              { name: 'User', value: `${user.tag} (${user.id})`, inline: false },
              { name: 'Reason', value: reasonInput ? reasonInput.slice(0, 1024) : 'No reason provided', inline: false },
              { name: 'Kick Executed', value: didKick ? 'Yes' : 'No', inline: true },
              { name: 'Roles Removed', value: String(removedRoleCount), inline: true }
            )
            .setDescription(summary.join('\n').slice(0, 4096))
            .setTimestamp(new Date());

          await logChannel.send({ embeds: [logEmbed] });
        } else {
          console.warn(`kick command: log channel ${kickLogChannelId} is missing or not text-based`);
        }
      } catch (err) {
        console.error('kick command: failed to send log message', err);
      }
    }

    return interaction.editReply({ content: summary.join('\n'), ephemeral: true });
  }
};
