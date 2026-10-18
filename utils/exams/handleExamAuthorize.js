const { ActionRowBuilder, ButtonBuilder, EmbedBuilder, ButtonStyle } = require('discord.js');
const config = require('../../config');
const examStore = require('./examStore');
const verificationStore = require('../verification/verificationStore');

function isSectionItem(item) {
  return !!(item && typeof item === 'object' && String(item.type || '').toLowerCase() === 'section');
}

function answerableQuestionNumber(questions, index) {
  let count = 0;
  for (let i = 0; i <= index; i++) {
    if (!isSectionItem(questions[i])) count += 1;
  }
  return count;
}

function buildSectionEmbed(section, sectionIndex) {
  return new EmbedBuilder()
    .setTitle(section.title || `Section ${sectionIndex + 1}`)
    .setDescription(section.description || '(no description)')
    .setColor(config.EMBED_COLOR);
}

function buildQuestionEmbed(question, questions, index) {
  const qText = typeof question === 'string' ? question : (question && question.text ? question.text : String(question));
  const qEmbed = new EmbedBuilder()
    .setTitle(`Question ${answerableQuestionNumber(questions, index)}`)
    .setDescription(qText)
    .setColor(config.EMBED_COLOR);

  if (typeof question === 'object' && (question.type === 'multiplechoice' || question.type === 'selection') && Array.isArray(question.choices)) {
    qEmbed.addFields({ name: 'Options', value: question.choices.join('\n'), inline: false });
    if (question.type === 'multiplechoice') {
      qEmbed.addFields({ name: 'Answer', value: 'Reply with just one letter (for example: A).', inline: false });
    } else {
      qEmbed.addFields({ name: 'Answer', value: 'Type out all letters that are correct (for example: AC or A,C).', inline: false });
    }
  }

  return qEmbed;
}

function formatTimeLimitMinutes(timeLimitSeconds) {
  const seconds = Number(timeLimitSeconds) || 0;
  if (seconds <= 0) return 'No time limit';

  const minutes = seconds / 60;
  const minuteLabel = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return `${minuteLabel} minute${Number(minuteLabel) === 1 ? '' : 's'}`;
}

async function handleExamAuthorize(interaction) {
  // customId format: exam_authorize:<userId>:<examId>
  try {
    await interaction.deferUpdate();
    const parts = String(interaction.customId).split(':');
    const userId = parts[1];
    const examId = parts[2];

    if (!interaction.member.roles.cache.has(config.EXAM_AUTH_ROLE_ID)) {
      return interaction.followUp({ content: '❌ You are not authorized to approve exams.', ephemeral: true });
    }

    // Check if user already has an active session for this exam
    const existingSession = await examStore.getSessionByUser(userId);
    if (existingSession && existingSession.examId === examId && (existingSession.status === 'active' || existingSession.status === 'awaiting_review')) {
      return interaction.followUp({ content: '⚠️ This candidate already has an active exam session.', ephemeral: true });
    }

    const examDef = examStore.getExamDefinition(examId);
    if (!examDef) {
      return interaction.followUp({ content: `⚠️ Could not find exam definition ${examId}.`, ephemeral: true });
    }

    // DM the user with initial question
    const user = await interaction.client.users.fetch(userId).catch(() => null);
    if (!user) {
      return interaction.followUp({ content: `❌ Could not resolve user <@${userId}>.`, ephemeral: true });
    }

    const linked = await verificationStore.getByDiscord(userId).catch(() => null);
    if (!linked || !linked.roblox_username) {
      return interaction.followUp({
        content: '⚠️ Candidate must have a linked Roblox account before this exam can be started.',
        ephemeral: true
      });
    }

    // create session
    const timeLimit = examDef.timeLimitSeconds || config.EXAM_TIME_LIMIT_SECONDS || 0;
    const sess = await examStore.createSession({
      userId,
      username: linked.roblox_username,
      examId,
      questions: examDef.questions || [],
      timeLimitSeconds: timeLimit
    });

    const advanced = await examStore.advancePastSections(sess.id);
    const activeSession = advanced && advanced.session ? advanced.session : sess;
    const initialSections = advanced && Array.isArray(advanced.skippedSections) ? advanced.skippedSections : [];
    const firstQ = (activeSession.questions && activeSession.questions[activeSession.currentIndex]) ? activeSession.questions[activeSession.currentIndex] : null;
    
    // Intro embed
    const introEmbed = new EmbedBuilder()
      .setTitle(`${examDef.title || examId} — Exam Started`)
      .setColor(config.EMBED_COLOR)
      .addFields(
        { name: 'Time Limit', value: formatTimeLimitMinutes(timeLimit), inline: true },
        { name: 'Instructions', value: examDef.instructions || 'Answer each question in this DM. Your next question will be posted after each answer.', inline: false }
      )
      .setTimestamp(new Date());

    const dm = await user.send({ embeds: [introEmbed] }).catch(() => null);
    if (!dm) {
      return interaction.followUp({ content: `⚠️ Could not DM the candidate. They may have DMs disabled.`, ephemeral: true });
    }

    // Send section divider embeds (if any) before the next answerable question.
    for (const sectionItem of initialSections) {
      const sectionEmbed = buildSectionEmbed(sectionItem.section || {}, sectionItem.index || 0);
      await user.send({ embeds: [sectionEmbed] }).catch(() => null);
    }

    if (firstQ && !isSectionItem(firstQ)) {
      const qEmbed = buildQuestionEmbed(firstQ, activeSession.questions || [], activeSession.currentIndex || 0);
      await user.send({ embeds: [qEmbed] }).catch(() => null);
    }

    // store dm message reference for potential countdown updates
    await examStore.setDMMessage(sess.id, dm);
    examStore.scheduleExpiration(sess, interaction.client);

    // Disable all buttons on the original message
    try {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`exam_authorize:${userId}:${examId}`)
          .setLabel('Authorize & Start')
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId(`exam_reject:${userId}:${examId}`)
          .setLabel('Reject')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true)
      );
      await interaction.message.edit({ components: [row] });
    } catch (e) { console.error('Failed to disable authorize button:', e); }

    // Acknowledge to authorizer
    await interaction.followUp({ content: `✅ Authorized and started exam for <@${userId}> (session ${sess.id}).`, ephemeral: true });
  } catch (e) {
    console.error('handleExamAuthorize error:', e);
    try { await interaction.followUp({ content: '⚠️ Failed to authorize exam.', ephemeral: true }); } catch (_) {}
  }
}

module.exports = { handleExamAuthorize };
