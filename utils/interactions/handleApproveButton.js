const { ActionRowBuilder, ButtonBuilder } = require("discord.js");
const config = require("../../config");
const { addFollowup } = require('../followups/followupStore');
const { scheduleFollowup } = require('../followups/followupScheduler');

/**
 * Handles the approve_request button interaction
 * @param {ButtonInteraction} interaction - The button interaction
 */
async function handleApproveButton(interaction) {
  await interaction.deferUpdate();

  // Check if button is already disabled
  if (interaction.message.components[0].components[0].disabled) {
    return interaction.followUp({
      content: "⚠️ This case has already been approved.",
      ephemeral: true
    });
  }

  // Role check from config
  const requiredRoles = Array.isArray(config.REQUIRED_ROLE_IDS_LIST)
    ? config.REQUIRED_ROLE_IDS_LIST
    : String(config.REQUIRED_ROLE_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  const hasRequiredRole = requiredRoles.some(roleId => interaction.member.roles.cache.has(roleId));
  if (!hasRequiredRole) {
    return interaction.followUp({
      content: "❌ You do not have permission to approve this.",
      ephemeral: true
    });
  }

  // Fetch target channel and send message with thread
  const channel = await interaction.guild.channels.fetch(config.TARGET_CHANNEL_ID);

  const messageLink = `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${interaction.message.id}`;

  // Extract case number from embed
  const embed = interaction.message.embeds[0];
  const caseField = embed.fields.find(f => f.name === "Case Number");
  const casenumber = caseField?.value ?? "Unknown";

  // Send message to target channel with thread
  // Post a parent message and start a thread named with the case number,
  // then send the ping inside the thread rather than on the parent message.
  const parentMsg = await channel.send({
    content: `Case [${casenumber}] | ${messageLink}`
  });

  const threadName = `Punishment Discussion - ${casenumber}`;
  const thread = await parentMsg.startThread({ name: threadName });

    // Ping the regular alert role inside the newly created thread for visibility
    await thread.send({ content: `<@&${config.PING_ROLE_ID}> | ${messageLink}` });

  // Persist a follow-up message to be sent after 48 hours and schedule it
  try {
    const sendAt = Date.now() + 48 * 60 * 60 * 1000;
    const followupPingRole = config.FOLLOWUP_PING_ROLE_ID;
    const roleMentions = followupPingRole ? `<@&${followupPingRole}>` : '';
    const content = `${roleMentions}\n\nPunishment Discussion ${casenumber} is complete (48 hours has passed).`;
    const allowedMentions = followupPingRole ? [followupPingRole] : [];
    const entry = await addFollowup({ guildId: interaction.guildId, threadId: thread.id, sendAt, content, allowedMentions });
    // Try to schedule now (scheduler will also pick this up on restart)
    try { scheduleFollowup(entry); } catch (e) {}
  } catch (e) {
    console.error('Failed to persist follow-up entry:', e);
  }

  // Disable the button
  const disabledRow = new ActionRowBuilder().addComponents(
    ButtonBuilder.from(interaction.component).setDisabled(true)
  );

  await interaction.message.edit({
    components: [disabledRow]
  });
}

module.exports = { handleApproveButton };
