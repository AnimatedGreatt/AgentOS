const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../config');
const arrestStore = require('../../utils/arrestStore');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('arrest-log')
    .setDescription('Log an arrest record')
    .addStringOption(opt => opt.setName('suspect').setDescription('Roblox username of suspect').setRequired(true))
    .addStringOption(opt => opt.setName('summary').setDescription('Brief description of the incident').setRequired(true))
    .addStringOption(opt => opt.setName('charges').setDescription('List of charges, listed as [X.X] Law Name').setRequired(true))
    .addStringOption(opt => opt.setName('sentence').setDescription('Time jailed').setRequired(true))
    .addStringOption(opt => opt.setName('proof').setDescription('Link to media evidence').setRequired(true)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // Validate membership/role strictly in the configured arrest guild.
    try {
      const reqRole = config.ARREST_REQUIRED_ROLE_ID;
      if (reqRole) {
        const permissionGuildId = String(config.ARREST_GUILD_ID || '').trim();
        if (!permissionGuildId) {
          await interaction.editReply({ content: '❌ Arrest permission guild is not configured.', ephemeral: true });
          return;
        }

        const permissionGuild = interaction.client.guilds.cache.get(permissionGuildId)
          || await interaction.client.guilds.fetch(permissionGuildId).catch(() => null);
        if (!permissionGuild) {
          await interaction.editReply({ content: '❌ Could not resolve the arrest permission guild.', ephemeral: true });
          return;
        }

        const fetchedMember = await permissionGuild.members.fetch(interaction.user.id).catch(() => null);
        const hasRequiredRole = !!(fetchedMember && fetchedMember.roles && fetchedMember.roles.cache && fetchedMember.roles.cache.has(reqRole));

        if (!hasRequiredRole) {
          await interaction.editReply({ content: '❌ You do not have permission to run this command.', ephemeral: true });
          return;
        }
      }
    } catch (e) {
      try { await interaction.editReply({ content: '❌ Permission check failed.', ephemeral: true }); } catch (_) {}
      return;
    }

    const suspect = interaction.options.getString('suspect');
    const summary = interaction.options.getString('summary');
    const charges = interaction.options.getString('charges');
    const sentence = interaction.options.getString('sentence');
    const proof = interaction.options.getString('proof') || '';

    try {
      const record = await arrestStore.createArrest({
        roblox_username: suspect,
        incident_summary: summary,
        charges,
        sentence,
        proof,
        submitted_by: interaction.user.id,
        submitted_by_tag: interaction.user.tag
      });

      let createdDisplay = 'Unknown';
      if (record.created_at) {
        const created = new Date(record.created_at);
        const ts = Math.floor(created.getTime() / 1000);
        createdDisplay = `<t:${ts}:f> (<t:${ts}:R>)`;
      }

      const embed = new EmbedBuilder()
        .setTitle(`Arrest Log: ${record.roblox_username}`)
        .setColor(config.EMBED_COLOR)
        .addFields(
          { name: 'Suspect', value: record.roblox_username, inline: true },
          { name: 'Submitted By', value: `${record.submitted_by_tag} (${record.submitted_by})`, inline: true },
          { name: 'Charges', value: record.charges || 'None', inline: false },
          { name: 'Sentence', value: record.sentence || 'None', inline: false },
          { name: 'Incident Summary', value: record.incident_summary || 'None', inline: false },
          { name: 'Proof', value: record.proof || 'None', inline: false }
        )
        .setFooter({ text: `Record ID: ${record.id} • ${createdDisplay}` });

      // Post to configured arrest channel
      const channel = await interaction.client.channels.fetch(config.ARREST_LOG_CHANNEL_ID).catch(() => null);
      if (channel) {
        await channel.send({ embeds: [embed] }).catch(() => {});
      }

      await interaction.editReply({ content: `Arrest logged (ID ${record.id}).`, ephemeral: true });
    } catch (e) {
      console.error('arrest-log failed:', e);
      await interaction.editReply({ content: 'Failed to log arrest.', ephemeral: true });
    }
  }
};
