const config = require('../../config');
const examStore = require('./examStore');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

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

function buildQuestionEmbed(q, questions, index) {
  const qText = typeof q === 'string' ? q : (q && q.text ? q.text : String(q));
  const qEmbed = new EmbedBuilder()
    .setTitle(`Question ${answerableQuestionNumber(questions, index)}`)
    .setDescription(qText)
    .setColor(config.EMBED_COLOR);

  if (typeof q === 'object' && (q.type === 'multiplechoice' || q.type === 'selection') && Array.isArray(q.choices)) {
    qEmbed.addFields({ name: 'Options', value: q.choices.join('\n'), inline: false });
    if (q.type === 'multiplechoice') {
      qEmbed.addFields({ name: 'Answer', value: 'Reply with just one letter (for example: A).', inline: false });
    } else {
      qEmbed.addFields({ name: 'Answer', value: 'Type out all letters that are correct (for example: AC or A,C).', inline: false });
    }
  }

  return qEmbed;
}

function getChoiceLetters(choices) {
  return (choices || []).map(c => String(c).trim().charAt(0).toUpperCase()).filter(Boolean);
}

function parseSelectionLetters(input) {
  const raw = String(input || '').toUpperCase();
  const letters = raw.match(/[A-Z]/g) || [];
  return [...new Set(letters)];
}

async function handleExamDM(message, client) {
  // Only handle DMs
  if (message.author.bot) return;
  if (message.guild) return; // skip guild messages

  const sess = await examStore.getSessionByUser(message.author.id);
  if (!sess) return; // not in an active session
  if (sess.status !== 'active') return;

  if (sess.expiresAt && Date.now() >= Number(sess.expiresAt)) {
    await examStore.expireSession(sess.id, client, 'time_limit').catch(err => {
      console.error('Failed to expire timed-out exam session from DM handler:', err);
    });
    return;
  }

  // If the current item is a section divider, skip sections before validating/recording.
  const preAdvance = await examStore.advancePastSections(sess.id);
  const activeSession = preAdvance && preAdvance.session ? preAdvance.session : sess;
  const currentQ = activeSession.questions && activeSession.questions[activeSession.currentIndex] ? activeSession.questions[activeSession.currentIndex] : null;
  const userAnswer = (message.content || '').trim();
  
  // Validate answer format for choice-based questions.
  if (currentQ && typeof currentQ === 'object' && currentQ.type === 'multiplechoice') {
    const answerUpper = userAnswer.toUpperCase();
    const validChoices = getChoiceLetters(currentQ.choices);
    if (!validChoices.includes(answerUpper)) {
      try {
        await message.channel.send({ content: `❌ Invalid answer. Please respond with one of: ${validChoices.join(', ')}` });
      } catch (e) {}
      return; // don't record yet
    }
  }

  if (currentQ && typeof currentQ === 'object' && currentQ.type === 'selection') {
    const validChoices = getChoiceLetters(currentQ.choices);
    const selectedLetters = parseSelectionLetters(userAnswer);
    const hasInvalid = selectedLetters.some(letter => !validChoices.includes(letter));
    if (!selectedLetters.length || hasInvalid) {
      try {
        await message.channel.send({ content: `❌ Invalid answer. Type all letters that are correct (for example: AC or A,C) using only: ${validChoices.join(', ')}` });
      } catch (e) {}
      return; // don't record yet
    }
  }

  // record answer and send next question or finalize
  const recorded = await examStore.recordAnswer(activeSession.id, userAnswer);
  if (!recorded) return;
  const updated = await examStore.getSessionById(activeSession.id);
  const advanced = await examStore.advancePastSections(activeSession.id);
  const state = advanced && advanced.session ? advanced.session : updated;
  const skippedSections = advanced && Array.isArray(advanced.skippedSections) ? advanced.skippedSections : [];
  const nextIndex = state.currentIndex;

  if (nextIndex < (state.questions || []).length) {
    try {
      for (const sectionItem of skippedSections) {
        const sectionEmbed = buildSectionEmbed(sectionItem.section || {}, sectionItem.index || 0);
        await message.channel.send({ embeds: [sectionEmbed] });
      }

      const q = state.questions[nextIndex];
      if (!isSectionItem(q)) {
        const qEmbed = buildQuestionEmbed(q, state.questions || [], nextIndex);
        await message.channel.send({ embeds: [qEmbed] });
      }
    } catch (e) {
      console.error('Failed to send next question DM:', e);
    }
    return;
  }

  // finished: post to review channel with link to grade in browser
  const reviewEmbed = new EmbedBuilder()
    .setTitle(`Exam Submission — ${updated.examId}`)
    .setColor(config.EMBED_COLOR)
    .setDescription('New submission received. Open in browser below to view and grade responses.')
    .addFields(
      { name: 'Candidate', value: `<@${message.author.id}>`, inline: true },
      { name: 'Session', value: state.id, inline: true },
      { name: 'Questions', value: `${(state.questions || []).filter(q => !isSectionItem(q)).length}`, inline: true }
    )
    .setTimestamp(new Date());

  const rows = [];
  // If a web grading UI is configured, expose a single Link button to open it.
  if (config.EXAM_WEB_BASE_URL) {
    const base = String(config.EXAM_WEB_BASE_URL).replace(/\/$/, '');
    // Send graders to the dashboard page for web-based grading.
    const url = `${base}/exams`;
    const linkBtn = new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Open Dashboard (Web)')
      .setURL(url);
    rows.push(new ActionRowBuilder().addComponents(linkBtn));
  } else {
    // Fallback: provide the in-Discord Grade button
    const gradeBtn = new ButtonBuilder().setCustomId(`exam_grade:${state.id}`).setLabel('Grade').setStyle(ButtonStyle.Primary);
    rows.push(new ActionRowBuilder().addComponents(gradeBtn));
  }

  const reviewChan = await client.channels.fetch(config.EXAM_REVIEW_CHANNEL_ID).catch(() => null);
  if (!reviewChan) {
    try { await message.channel.send({ content: '⚠️ Could not submit exam for review (review channel not found).' }); } catch (_) {}
    return;
  }

  const sent = await reviewChan.send({ embeds: [reviewEmbed], components: rows }).catch(err => null);
  if (sent) {
    await examStore.setReviewMessage(state.id, reviewChan.id, sent.id);
    try { await message.channel.send({ content: '✅ Your exam has been submitted for review. You will receive feedback when grading completes.' }); } catch (e) {}
    try { console.info && console.info(`Exam posted for review: session=${state.id} channel=${reviewChan.id} message=${sent.id}`); } catch (e) {}
  } else {
    try { await message.channel.send({ content: '⚠️ Failed to submit exam for review. Please contact staff.' }); } catch (e) {}
  }
}

module.exports = { handleExamDM };
