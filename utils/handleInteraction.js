const { handleSlashCommand } = require("./handleSlashCommand");
const { handleApproveButton } = require("./handleApproveButton");
const { handleExamAuthorize } = require("./handleExamAuthorize");
const { handleExamReject } = require("./handleExamReject");
const { handleGradeButton, handleGradeModalSubmit } = require("./handleExamGrade");
const verificationStore = require('./verificationStore');
const axios = require('axios');
const { handleFormReview } = require("./handleFormReview");
const { handleReviewModal } = require("./handleReviewModal");
const { handleModalSubmit: handleInactivityModal, handleApprove: handleInactivityApprove, handleDeny: handleInactivityDeny } = require('./inactivityHandler');
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const config = require('../config');
const { getChangelog, setChangelog } = require('./changelogStore');
const { getState, setState } = require('./adminState');
const pausedCommands = require('./pausedCommands');
const arrestStore = require('./arrestStore');
const eventSystem = require('./eventSystem');
const { handleAiFeedbackButton, handleAiFeedbackModal } = require('./ai/aiDiscord');

/**
 * Main interaction handler that routes to appropriate handlers
 * @param {Interaction} interaction - The interaction that was triggered
 * @param {Client} client - Discord client instance
 */
async function handleInteraction(interaction, client) {
  try {
    // Handle slash commands
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction, client);
      return;
    }

    // Handle button interactions
    if (interaction.isButton()) {
      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('ai_fb:')) {
        await handleAiFeedbackButton(interaction);
        return;
      }

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('event_preset:')) {
        await eventSystem.handlePresetButton(interaction, client);
        return;
      }

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('event_live_')) {
        await eventSystem.handleLiveEventButton(interaction, client);
        return;
      }

      if (interaction.customId === "approve_request") {
        await handleApproveButton(interaction);
        return;
      }

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('exam_authorize:')) {
        await handleExamAuthorize(interaction);
        return;
      }

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('exam_reject:')) {
        await handleExamReject(interaction);
        return;
      }

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('exam_grade:')) {
        await handleGradeButton(interaction);
        return;
      }

      if (interaction.customId === 'inactivity_approve') {
        await handleInactivityApprove(interaction);
        return;
      }

      if (interaction.customId === 'inactivity_deny') {
        await handleInactivityDeny(interaction);
        return;
      }

      if (interaction.customId === "approve" || interaction.customId === "deny") {
        await handleFormReview(interaction);
        return;
      }

      // Admin buttons
      if (interaction.customId === 'admin_toggle_pause') {
        await interaction.deferUpdate();
        const s = await getState();
        const updated = await setState({ pausedApplications: !s.pausedApplications });
        try {
          await interaction.followUp({ content: `Paused Applications: ${updated.pausedApplications}`, ephemeral: true });
        } catch (e) {}
        return;
      }

      if (interaction.customId === 'admin_toggle_debug') {
        await interaction.deferUpdate();
        const s = await getState();
        const updated = await setState({ debugMode: !s.debugMode });
        try {
          await interaction.followUp({ content: `Debug Mode: ${updated.debugMode}`, ephemeral: true });
        } catch (e) {}
        return;
      }

      if (interaction.customId === 'admin_toggle_time_logging') {
        await interaction.deferUpdate();
        const s = await getState();
        const updated = await setState({ pauseTimeLogging: !s.pauseTimeLogging });
        try {
          await interaction.followUp({ content: `Automatic Time Logging Paused: ${updated.pauseTimeLogging}`, ephemeral: true });
        } catch (e) {}
        return;
      }

      if (interaction.customId === 'admin_show_changelog') {
        await interaction.deferReply({ ephemeral: true });
        const cl = await getChangelog();
        const embed = new EmbedBuilder()
          .setTitle(`Changelog ${cl.version || ''}`)
          .setColor(config.EMBED_COLOR)
          .addFields(
            { name: 'Additions', value: cl.additions || 'None', inline: false },
            { name: 'Notes', value: cl.notes || 'None', inline: false }
          )
          .setFooter({ text: `Updated: ${cl.updatedAt || 'never'}` });
        await interaction.editReply({ embeds: [embed] });
        return;
      }

      if (interaction.customId === 'admin_edit_changelog') {
        // show modal to collect version, additions, notes; version is optional and defaults to the latest detected version
        const cl = await getChangelog();
        const modal = new ModalBuilder().setCustomId('admin_changelog_modal').setTitle('Edit Changelog');
        const versionInput = new TextInputBuilder()
          .setCustomId('version')
          .setLabel('Version (optional)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Leave blank to keep latest detected version')
          .setRequired(false)
          .setValue(cl.version || '');
        const additionsInput = new TextInputBuilder().setCustomId('additions').setLabel('Additions (comma-separated or text)').setStyle(TextInputStyle.Paragraph).setRequired(false);
        const notesInput = new TextInputBuilder().setCustomId('notes').setLabel('Notes').setStyle(TextInputStyle.Paragraph).setRequired(false);

        modal.addComponents(new ActionRowBuilder().addComponents(versionInput), new ActionRowBuilder().addComponents(additionsInput), new ActionRowBuilder().addComponents(notesInput));
        try {
          await interaction.showModal(modal);
        } catch (e) {
          console.error('Failed to show admin changelog modal:', e);
        }
        return;
      }

      if (interaction.customId === 'admin_manage_commands') {
        await interaction.deferReply({ ephemeral: true });
        try {
          const commands = Array.from(client.commands.keys());
          if (!commands.length) {
            await interaction.editReply({ content: 'No registered commands found.' });
            return;
          }

          const embed = new EmbedBuilder().setTitle('Manage Slash Commands').setDescription('Toggle pause/unpause for individual slash commands.');
          const rows = [];
          // Build buttons (max 5 per row, up to 25 total)
          let currentRow = new ActionRowBuilder();
          let count = 0;
          for (const name of commands.slice(0, 25)) {
            const isP = await pausedCommands.isPaused(name).catch(() => false);
            const label = `${isP ? '⛔' : '✅'} ${name}`;
            const btn = new ButtonBuilder().setCustomId(`admin_cmd_toggle:${name}`).setLabel(label).setStyle(ButtonStyle.Secondary);
            currentRow.addComponents(btn);
            count += 1;
            if (count % 5 === 0) {
              rows.push(currentRow);
              currentRow = new ActionRowBuilder();
            }
          }
          if (currentRow.components && currentRow.components.length) rows.push(currentRow);

          await interaction.editReply({ embeds: [embed], components: rows });
        } catch (e) {
          console.error('Failed to build manage commands UI:', e);
          try { await interaction.editReply({ content: 'Failed to load commands.' }); } catch (_) {}
        }
        return;
      }

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('admin_cmd_toggle:')) {
        await interaction.deferUpdate();
        try {
          const name = interaction.customId.split(':')[1];
          const cur = await pausedCommands.isPaused(name);
          const updated = await pausedCommands.setPaused(name, !cur);
            await interaction.followUp({ content: `Command '${name}' is now ${updated.paused ? 'paused' : 'unpaused'}.`, ephemeral: true });
        } catch (e) {
          console.error('Failed to toggle command pause:', e);
          try { await interaction.followUp({ content: 'Failed to toggle pause state.', ephemeral: true }); } catch (_) {}
        }
        return;
      }

      // AgentOS verification confirm button handler
      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('agentos_verify_confirm:')) {
        await interaction.deferReply({ ephemeral: true });
        try {
          const username = interaction.customId.split(':')[1];
          const discordId = interaction.user.id;
          const chal = await verificationStore.getChallenge(username, discordId);
          if (!chal) {
            await interaction.editReply({ content: 'No active verification challenge found. Run the command again to start verification.', ephemeral: true });
            return;
          }
          if (new Date(chal.expires_at) < new Date()) {
            await verificationStore.clearChallenge(username, discordId);
            await interaction.editReply({ content: 'Your verification challenge has expired. Start again to create a new challenge.', ephemeral: true });
            return;
          }

          const robloxId = chal.roblox_userid;
          let profileText = '';
          try {
            const p1 = await axios.get(`https://users.roblox.com/v1/users/${robloxId}/profile`).catch(() => null);
            if (p1 && p1.data) profileText += ' ' + JSON.stringify(p1.data);
          } catch (e) {}
          try {
            const p2 = await axios.get(`https://users.roblox.com/v1/users/${robloxId}/status`).catch(() => null);
            if (p2 && p2.data) profileText += ' ' + JSON.stringify(p2.data);
          } catch (e) {}
          try {
            const p3 = await axios.get(`https://users.roblox.com/v1/users/${robloxId}`).catch(() => null);
            if (p3 && p3.data) profileText += ' ' + JSON.stringify(p3.data);
          } catch (e) {}
          try {
            const html = await axios.get(`https://www.roblox.com/users/${robloxId}/profile`).then(r => r.data).catch(() => null);
            if (html) profileText += ' ' + String(html);
          } catch (e) {}

          if (!profileText || !profileText.includes(chal.code)) {
            await interaction.editReply({ content: 'Could not find the verification code in the Roblox profile. Ensure you added the exact code to your About/Status and try again.', ephemeral: true });
            return;
          }

          try {
            const v = await verificationStore.addVerification(username, robloxId, discordId);
            await verificationStore.clearChallenge(username, discordId);
            await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('Verification Complete').setColor(0x57F287).setDescription('Verification succeeded — announcing publicly.')] });
            const publicEmbed = new EmbedBuilder()
              .setTitle('AgentOS Verification — Successful')
              .setColor(0x57F287)
              .setDescription(`Verified: **${v.roblox_username}** ↔ <@${v.discord_id}>`)
              .setTimestamp(new Date());
            await interaction.followUp({ embeds: [publicEmbed] });
            return;
          } catch (err) {
            console.error('Failed to finalize verification (button):', err);
            await interaction.editReply({ content: 'Failed to complete verification. Try again later.', ephemeral: true });
            return;
          }
        } catch (e) {
          console.error('AgentOS verify button handler error:', e);
          try { await interaction.editReply({ content: 'An error occurred while confirming verification.', ephemeral: true }); } catch (_) {}
        }
      }

      // Arrest modification flow: show select list of editable arrests for the username
      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('arrest_modify:')) {
        await interaction.deferReply({ ephemeral: true });
        try {
          const username = interaction.customId.split(':')[1];
          const arrests = await arrestStore.getArrestsByRoblox(username);
          if (!arrests || arrests.length === 0) {
            await interaction.editReply({ content: `No arrests found for ${username}.`, ephemeral: true });
            return;
          }

          const adminRoleIds = (config.ARREST_ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
          const member = interaction.member;
          const options = [];
          for (const a of arrests) {
            const owner = a.submitted_by === interaction.user.id;
            const isAdmin = member && member.roles && adminRoleIds.some(r => member.roles.cache.has(r));
            if (!owner && !isAdmin) continue; // not editable by this user
            options.push({ label: `ID ${a.id} • ${a.roblox_username}`, value: `${a.id}`, description: (a.charges || '').slice(0, 80) || 'No charges' });
          }

          if (!options.length) {
            await interaction.editReply({ content: 'You have no editable arrests for that username.', ephemeral: true });
            return;
          }

          const select = new StringSelectMenuBuilder()
            .setCustomId(`arrest_select:${username}`)
            .setPlaceholder('Select an arrest to view/edit')
            .addOptions(options.slice(0, 25));

          const row = new ActionRowBuilder().addComponents(select);
          await interaction.editReply({ content: 'Select an arrest to modify:', components: [row], ephemeral: true });
        } catch (e) {
          console.error('Failed arrest_modify flow:', e);
          try { await interaction.editReply({ content: 'Failed to build modification list.', ephemeral: true }); } catch (_) {}
        }
        return;
      }

      

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('arrest_edit:')) {
        // Format: arrest_edit:<field>:<id>
        try {
          const parts = interaction.customId.split(':');
          const field = parts[1];
          const id = parts[2];
          const modal = new ModalBuilder().setCustomId(`arrest_modal:${field}:${id}`).setTitle(`Edit Arrest ${id} — ${field}`);
          const input = new TextInputBuilder().setCustomId('value').setLabel(`New ${field}`).setStyle(TextInputStyle.Paragraph).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          await interaction.showModal(modal);
        } catch (e) {
          console.error('Failed to show arrest edit modal:', e);
        }
        return;
      }

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('arrest_view_edits:')) {
        await interaction.deferReply({ ephemeral: true });
        try {
          const id = interaction.customId.split(':')[1];
          const edits = await arrestStore.getEditsForArrest(id);
          if (!edits || edits.length === 0) {
            await interaction.editReply({ content: 'No edits found for that arrest.', ephemeral: true });
            return;
          }
          const lines = edits.map(e => {
            let editedAt = 'Unknown';
            if (e.edited_at) {
              const d = new Date(e.edited_at);
              editedAt = `<t:${Math.floor(d.getTime()/1000)}:f>`;
            }
            return `By ${e.edited_by_tag || e.edited_by} at ${editedAt}\nSummary: ${e.before_incident_summary || 'None'}\nCharges: ${e.before_charges || 'None'}\nSentence: ${e.before_sentence || 'None'}\nProof: ${e.before_proof || 'None'}`;
          }).join('\n\n----\n\n');
          // send as ephemeral follow-up (may be large)
          await interaction.editReply({ content: `Edits for arrest ${id}:\n\n${lines}`, ephemeral: true });
        } catch (e) {
          console.error('Failed to fetch edits:', e);
          try { await interaction.editReply({ content: 'Failed to fetch edits.', ephemeral: true }); } catch (_) {}
        }
        return;
      }

      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('arrest_delete:')) {
        await interaction.deferReply({ ephemeral: true });
        try {
          const id = interaction.customId.split(':')[1];
          const adminRoleIds = (config.ARREST_ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
          const member = interaction.member;
          const isAdmin = member && member.roles && adminRoleIds.some(r => member.roles.cache.has(r));
          if (!isAdmin) {
            await interaction.editReply({ content: 'You do not have permission to delete arrests.', ephemeral: true });
            return;
          }
          const deleted = await arrestStore.deleteArrest(id);
          if (deleted) {
            await interaction.editReply({ content: `Deleted arrest ${id}.`, ephemeral: true });
          } else {
            await interaction.editReply({ content: 'Arrest not found or could not be deleted.', ephemeral: true });
          }
        } catch (e) {
          console.error('Failed to delete arrest:', e);
          try { await interaction.editReply({ content: 'Failed to delete arrest.', ephemeral: true }); } catch (_) {}
        }
        return;
      }
    }

    // Handle select menu interactions
    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
      if (typeof interaction.customId === 'string' && interaction.customId.startsWith('arrest_select:')) {
        await interaction.deferReply({ ephemeral: true });
        try {
          const id = interaction.values ? interaction.values[0] : null;
          if (!id) {
            await interaction.editReply({ content: 'No arrest selected.', ephemeral: true });
            return;
          }
          const arrest = await arrestStore.getArrestById(id);
          if (!arrest) {
            await interaction.editReply({ content: 'Arrest not found.', ephemeral: true });
            return;
          }

          let createdDisplay = 'Unknown';
          if (arrest.created_at) {
            const created = new Date(arrest.created_at);
            const ts = Math.floor(created.getTime() / 1000);
            createdDisplay = `<t:${ts}:f> (<t:${ts}:R>)`;
          }

          const embed = new EmbedBuilder()
            .setTitle(`Arrest ID ${arrest.id} — ${arrest.roblox_username}`)
            .setColor(config.EMBED_COLOR)
            .addFields(
              { name: 'Incident Summary', value: arrest.incident_summary || 'None', inline: false },
              { name: 'Charges', value: arrest.charges || 'None', inline: false },
              { name: 'Sentence', value: arrest.sentence || 'None', inline: false },
              { name: 'Proof', value: arrest.proof || 'None', inline: false },
              { name: 'Submitted By', value: arrest.submitted_by_tag || arrest.submitted_by || 'Unknown', inline: true },
              { name: 'Created', value: createdDisplay, inline: true }
            );

          const adminRoleIds = (config.ARREST_ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
          const member = interaction.member;
          const isAdmin = member && member.roles && adminRoleIds.some(r => member.roles.cache.has(r));
          const isOwner = arrest.submitted_by === interaction.user.id;

          const rows = [];
          const editRow = new ActionRowBuilder();
          editRow.addComponents(
            new ButtonBuilder().setCustomId(`arrest_edit:summary:${arrest.id}`).setLabel('Edit Summary').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`arrest_edit:charges:${arrest.id}`).setLabel('Edit Charges').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`arrest_edit:sentence:${arrest.id}`).setLabel('Edit Sentence').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`arrest_edit:proof:${arrest.id}`).setLabel('Edit Proof').setStyle(ButtonStyle.Primary)
          );
          rows.push(editRow);

          const viewRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`arrest_view_edits:${arrest.id}`).setLabel('View Edits').setStyle(ButtonStyle.Secondary));
          rows.push(viewRow);

          if (isAdmin) {
            const delRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`arrest_delete:${arrest.id}`).setLabel('Delete Arrest').setStyle(ButtonStyle.Danger));
            rows.push(delRow);
          }

          await interaction.editReply({ embeds: [embed], components: rows, ephemeral: true });
        } catch (e) {
          console.error('Failed arrest_select flow:', e);
          try { await interaction.editReply({ content: 'Failed to load arrest.', ephemeral: true }); } catch (_) {}
        }
        return;
      }
    }

    // Handle modal submissions
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('ai_fb_modal:')) {
        await handleAiFeedbackModal(interaction);
        return;
      }

      if (interaction.customId.startsWith('event_preset_modal:')) {
        await eventSystem.handlePresetModal(interaction, client);
        return;
      }

      if (interaction.customId.startsWith('event_live_edit_modal:')) {
        await eventSystem.handleLiveEventEditModal(interaction, client);
        return;
      }

      if (interaction.customId.startsWith('inactivity_modal_')) {
        await handleInactivityModal(interaction);
        return;
      }
      if (interaction.customId.startsWith('exam_grade_modal:')) {
        await handleGradeModalSubmit(interaction);
        return;
      }
      if (interaction.customId.startsWith("feedback_")) {
        await handleReviewModal(interaction);
        return;
      }

      if (interaction.customId === 'admin_changelog_modal') {
        try {
          const version = interaction.fields.getTextInputValue('version');
          const additions = interaction.fields.getTextInputValue('additions') || '';
          const notes = interaction.fields.getTextInputValue('notes') || '';
          const payload = await setChangelog({ version, additions, notes });
          await interaction.reply({ content: `Changelog updated (version ${payload.version}).`, ephemeral: true });
        } catch (e) {
          console.error('Failed to process changelog modal:', e);
          try { await interaction.reply({ content: 'Failed to update changelog.', ephemeral: true }); } catch (_) {}
        }
        return;
      }
      if (interaction.customId && interaction.customId.startsWith('arrest_modal:')) {
        await interaction.deferReply({ ephemeral: true });
        try {
          // Format: arrest_modal:<field>:<id>
          const parts = interaction.customId.split(':');
          const field = parts[1];
          const id = parts[2];
          const newValue = interaction.fields.getTextInputValue('value');
          const arrest = await arrestStore.getArrestById(id);
          if (!arrest) {
            await interaction.editReply({ content: 'Arrest not found.', ephemeral: true });
            return;
          }

          // Permission check: owner or admin
          const adminRoleIds = (config.ARREST_ADMIN_ROLE_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
          const member = interaction.member;
          const isAdmin = member && member.roles && adminRoleIds.some(r => member.roles.cache.has(r));
          const isOwner = arrest.submitted_by === interaction.user.id;
          if (!isOwner && !isAdmin) {
            await interaction.editReply({ content: 'You do not have permission to edit this arrest.', ephemeral: true });
            return;
          }

          // Save prior state
          await arrestStore.addEdit({ arrest_id: arrest.id, edited_by: interaction.user.id, edited_by_tag: interaction.user.tag, before: {
            incident_summary: arrest.incident_summary,
            charges: arrest.charges,
            sentence: arrest.sentence,
            proof: arrest.proof
          }});

          const updatePayload = {
            incident_summary: arrest.incident_summary,
            charges: arrest.charges,
            sentence: arrest.sentence,
            proof: arrest.proof
          };
          if (field === 'summary') updatePayload.incident_summary = newValue;
          if (field === 'charges') updatePayload.charges = newValue;
          if (field === 'sentence') updatePayload.sentence = newValue;
          if (field === 'proof') updatePayload.proof = newValue;

          const updated = await arrestStore.updateArrest(id, updatePayload);
          await interaction.editReply({ content: `Arrest ${id} updated.`, ephemeral: true });
        } catch (e) {
          console.error('Failed to process arrest modal:', e);
          try { await interaction.editReply({ content: 'Failed to update arrest.', ephemeral: true }); } catch (_) {}
        }
        return;
      }
    }
  } catch (error) {
    console.error("Unhandled error in interaction handler:", error);
  }
}

module.exports = { handleInteraction };
