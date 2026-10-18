const config = require("../../config");
const { google } = require("googleapis");
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

async function getSheets() {
  const auth = new google.auth.GoogleAuth({
    credentials: config.GOOGLE_SERVICE_ACCOUNT_JSON,
    keyFilename: config.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  const client = await auth.getClient();
  return google.sheets({ version: "v4", auth: client });
}

function colLetterToIndex(letter) {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 65 + 1);
  }
  return index - 1;
}

function indexToColLetter(index) {
  let s = "";
  while (index >= 0) {
    s = String.fromCharCode(65 + (index % 26)) + s;
    index = Math.floor(index / 26) - 1;
  }
  return s;
}

function parseRange(range) {
  const m = range.match(/^([^!]+)!([A-Z]+)(\d+)(?::[A-Z]+\d+)?$/);
  if (!m) return null;
  return { sheetName: m[1], startCol: m[2], startRow: Number(m[3]) };
}

function stripLeadingApostrophe(s) {
  if (s === undefined || s === null) return s;
  return String(s).replace(/^[\u0027\u2018\u2019]+/, '');
}

async function setEndDateForUser({ discordId, username }, endDateStr) {
  if (!config.GOOGLE_SHEET_ID) throw new Error('Google sheet not configured');
  const range = config.TIME_LOG_SHEET_RANGE;
  const parsed = parseRange(range);
  if (!parsed) throw new Error('Unsupported TIME_LOG_SHEET_RANGE format');

  const sheets = await getSheets();
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: config.GOOGLE_SHEET_ID, range });
  const rows = resp.data.values || [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cellNameRaw = (row[config.TIME_LOG_NAME_COL] || "").toString();
    const cellName = stripLeadingApostrophe(cellNameRaw).trim();
    if (!cellName) continue;
    if (username && stripLeadingApostrophe(String(username)).toLowerCase() === cellName.toLowerCase()) {
      const startColIndex = colLetterToIndex(parsed.startCol);
      const targetColIndex = startColIndex + config.TIME_LOG_ENDDATE_COL;
      const targetColLetter = indexToColLetter(targetColIndex);
      const targetRowNumber = parsed.startRow + i;
      const targetA1 = `${parsed.sheetName}!${targetColLetter}${targetRowNumber}`;

      // Log exactly what we're about to write so we can diagnose stray characters (debug-level)
      try { console.debug && console.debug('Writing end date to sheet:', targetA1, JSON.stringify(endDateStr)); } catch (e) {}
      // If the endDateStr was prefixed with an apostrophe inadvertently, strip it before writing
      const outVal = stripLeadingApostrophe(endDateStr);
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.GOOGLE_SHEET_ID,
        range: targetA1,
        // Let Sheets parse the date/text so it stores as a proper date when possible
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[outVal]] }
      });

      return { row: targetRowNumber, col: targetColLetter };
    }
  }
  return null;
}

function buildInactivityEmbed({ targetUser, duration, reason, submitter, robloxUsername }) {
  const eb = new EmbedBuilder()
    .setTitle(`Inactivity Notice — ${targetUser.tag}`)
    .setColor(config.EMBED_COLOR || 0x5865f2)
    .addFields(
      { name: 'Username', value: robloxUsername || '(not provided)', inline: false },
      { name: 'Submitted by', value: submitter.tag, inline: false },
      { name: 'Duration', value: String(duration), inline: false },
      { name: 'Reason', value: reason || '(no reason provided)', inline: false }
    )
    .setTimestamp(new Date());
  return eb;
}

async function handleModalSubmit(interaction) {
  // customId: inactivity_modal_<userId>
  if (!interaction.customId.startsWith('inactivity_modal_')) return;
  await interaction.deferReply({ ephemeral: true }).catch(() => {});
  const targetId = interaction.customId.split('_').slice(2).join('_');
  const duration = interaction.fields.getTextInputValue('duration');
  const roblox = interaction.fields.getTextInputValue('roblox') || '';
  const reason = interaction.fields.getTextInputValue('reason') || '';

  const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
  if (!targetUser) {
    return interaction.editReply({ content: 'Could not resolve target user.' });
  }

  const embed = buildInactivityEmbed({ targetUser, duration, reason, submitter: interaction.user, robloxUsername: roblox });

  // (No extra fields: embed shows Submitted by, Duration, and Reason)

  // Buttons
  const approveBtn = new ButtonBuilder().setCustomId('inactivity_approve').setLabel('Approve').setStyle(ButtonStyle.Success);
  const denyBtn = new ButtonBuilder().setCustomId('inactivity_deny').setLabel('Deny').setStyle(ButtonStyle.Danger);

  // Post to configured channel
  const chanId = config.INACTIVITY_CHANNEL_ID || config.TARGET_CHANNEL_ID;
  if (!chanId) return interaction.editReply({ content: 'Inactivity channel not configured.' });
  const channel = await interaction.client.channels.fetch(chanId).catch(() => null);
  if (!channel) return interaction.editReply({ content: 'Could not fetch the inactivity channel.' });

  const sent = await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(approveBtn, denyBtn)] }).catch(err => null);
  if (!sent) return interaction.editReply({ content: 'Failed to post inactivity notice.' });

  try { await interaction.editReply({ content: 'Inactivity notice submitted for review.', ephemeral: true }); } catch (e) {}
}

function parseApproverRoles() {
  if (!config.INACTIVITY_APPROVER_ROLE_IDS) return [];
  return String(config.INACTIVITY_APPROVER_ROLE_IDS).split(',').map(s => s.trim()).filter(Boolean);
}

async function handleApprove(interaction) {
  await interaction.deferUpdate();

  const approverRoles = parseApproverRoles();
  if (approverRoles.length && !approverRoles.some(r => interaction.member.roles.cache.has(r))) {
    return interaction.followUp({ content: '❌ You do not have permission to approve this.', ephemeral: true });
  }

  // Extract embed and target user id
  const embed = interaction.message.embeds[0];
  if (!embed) return;
  const targetField = embed.fields.find(f => /target/i.test(f.name));
  const idMatch = targetField?.value?.match(/(\d{16,20})/);
  const targetId = idMatch ? idMatch[1] : null;
  const durationField = embed.fields.find(f => /duration/i.test(f.name));
  const durationRaw = durationField?.value || '';
  const usernameField = embed.fields.find(f => /username/i.test(f.name));
  const robloxProvided = usernameField?.value || null;

  // Parse duration as number of days if possible, otherwise accept as text and set endDate as now + days
  let endDateStr = new Date().toISOString().split('T')[0];
  const daysMatch = String(durationRaw).match(/(\d+)/);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    const d = new Date();
    d.setDate(d.getDate() + days);
    endDateStr = d.toISOString().split('T')[0];
  } else if (durationRaw) {
    // fallback: store the raw duration text
    endDateStr = durationRaw;
  }

    // write to sheet
  try {
    // Determine lookup name robustly: prefer provided Roblox username, then legacy 'Target' field, then parse from title
    let lookupName = null;
    if (robloxProvided) lookupName = robloxProvided;
    else {
      const legacyTarget = embed.fields.find(f => /target/i.test(f.name));
      if (legacyTarget && legacyTarget.value) {
        lookupName = String(legacyTarget.value).split(' ')[0];
      } else if (embed.title) {
        const m = String(embed.title).match(/—\s*(.+)$/); // em dash
        const m2 = !m ? String(embed.title).match(/-\s*(.+)$/) : m;
        const parsed = (m || m2) ? (m ? m[1] : m2[1]) : null;
        if (parsed) lookupName = String(parsed).split(' ')[0];
      }
    }
    const res = await setEndDateForUser({ discordId: targetId, username: lookupName }, endDateStr);
    // Write to DB so scheduler can manage expirations
    try {
      const { addEntry } = require('./inactivityStore');
      // try to convert endDateStr to a JS Date when possible
      let endDateObj = null;
      const isoMatch = String(endDateStr).match(/^(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) endDateObj = new Date(isoMatch[1] + 'T00:00:00Z');
      if (!endDateObj && /\d+/.test(String(durationRaw || ''))) {
        const days = Number((String(durationRaw).match(/(\d+)/) || [])[1]);
        if (!Number.isNaN(days)) {
          const d = new Date(); d.setDate(d.getDate() + days); endDateObj = d;
        }
      }
      if (endDateObj) {
        // Resolve a Discord ID to store in DB. Prefer explicit targetId (from embed Target field),
        // otherwise try to resolve the "Submitted by" embed field (username#discriminator) to a guild member ID.
        let dbDiscordId = targetId;
        if (!dbDiscordId) {
          try {
            const submitterField = embed.fields.find(f => /submitted by/i.test(f.name));
            if (submitterField && submitterField.value && interaction.guild) {
              const tag = String(submitterField.value).trim();
              // Try cache lookup by exact tag first
              let member = interaction.guild.members.cache.find(m => m.user.tag === tag);
              if (!member) {
                // Fallback: query members by username portion (may return multiple); then match exact tag if possible
                const namePart = tag.split('#')[0];
                try {
                  const fetched = await interaction.guild.members.fetch({ query: namePart, limit: 5 });
                  member = Array.from(fetched.values()).find(m => m.user.tag === tag) || Array.from(fetched.values())[0];
                } catch (e) {
                  // ignore fetch errors
                }
              }
              if (member) dbDiscordId = member.user.id;
            }
          } catch (e) {
            console.error('Failed to resolve submitter Discord ID:', e);
          }
        }
        await addEntry(lookupName, dbDiscordId, endDateObj);
      }
    } catch (err) {
      console.error('Failed to add inactivity DB entry:', err);
    }

    // Update message: disable buttons and add approval info
    const updatedEmbed = EmbedBuilder.from(embed).setColor(0x57F287).addFields({ name: 'End Date', value: endDateStr, inline: true }, { name: 'Approved by', value: interaction.user.tag, inline: true });
    const disabledRow = new ActionRowBuilder().addComponents(ButtonBuilder.from(interaction.component).setDisabled(true), ButtonBuilder.from(interaction.message.components[0].components[1]).setDisabled(true));
    await interaction.message.edit({ embeds: [updatedEmbed], components: [disabledRow] }).catch(() => {});
    await interaction.followUp({ content: `✅ Approved. End date ${endDateStr} written to sheet.`, ephemeral: true });
  } catch (err) {
    console.error('Error approving inactivity:', err);
    await interaction.followUp({ content: 'Failed to write end date to sheet.', ephemeral: true });
  }
}

async function handleDeny(interaction) {
  // Show feedback modal routed through existing review modal processor
  // Do NOT call deferUpdate() before showModal — showing a modal must be the immediate response.
  const modal = new ModalBuilder().setCustomId(`feedback_deny_${interaction.message.id}`).setTitle('Denial Feedback');
  const feedbackInput = new TextInputBuilder().setCustomId('feedback').setLabel('Feedback for submitter').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000);
  modal.addComponents(new ActionRowBuilder().addComponents(feedbackInput));
  await interaction.showModal(modal).catch(err => { console.error('Failed to show deny modal:', err); });
}

module.exports = { handleModalSubmit, handleApprove, handleDeny, setEndDateForUser };
