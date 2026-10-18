const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const examStore = require('./examStore');
const config = require('../../config');

function normalizeSelectionAnswer(value) {
  const letters = String(value || '').toUpperCase().match(/[A-Z]/g) || [];
  return [...new Set(letters)].sort().join('');
}

function isSectionItem(item) {
  return !!(item && typeof item === 'object' && String(item.type || '').toLowerCase() === 'section');
}

function isAutoGradedQuestion(q) {
  return !!(q && typeof q === 'object' && (
    (q.type === 'multiplechoice' && q.correctAnswer) ||
    (q.type === 'selection' && q.correctAnswer)
  ));
}

function clampScore(value, maxScore) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const max = Number.isFinite(Number(maxScore)) ? Number(maxScore) : 1;
  if (n < 0) return 0;
  if (n > max) return max;
  return n;
}

function buildManualScoreMap(rawScores, questions) {
  const map = new Map();
  const qs = Array.isArray(questions) ? questions : [];

  if (!rawScores) return map;

  // Accept object payloads keyed by question index: { "21": 4, "22": 5 }
  if (!Array.isArray(rawScores) && typeof rawScores === 'object') {
    for (const [k, v] of Object.entries(rawScores)) {
      const idx = Number(k);
      if (!Number.isInteger(idx) || idx < 0 || idx >= qs.length) continue;
      const q = qs[idx];
      const maxScore = (typeof q === 'object' && q.maxScore) ? q.maxScore : 1;
      map.set(idx, clampScore(v, maxScore));
    }
    return map;
  }

  if (!Array.isArray(rawScores)) return map;

  const scores = rawScores.map(v => Number(v));
  const nonSectionIndices = [];
  const manualOnlyIndices = [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (isSectionItem(q)) continue;
    nonSectionIndices.push(i);
    if (!isAutoGradedQuestion(q)) manualOnlyIndices.push(i);
  }

  // Format A: full question-indexed array, including section placeholders.
  if (scores.length === qs.length) {
    for (let i = 0; i < scores.length; i++) {
      const q = qs[i];
      const maxScore = (typeof q === 'object' && q.maxScore) ? q.maxScore : 1;
      map.set(i, clampScore(scores[i], maxScore));
    }
    return map;
  }

  // Format B: compact array over non-section questions only.
  if (scores.length === nonSectionIndices.length) {
    for (let i = 0; i < nonSectionIndices.length; i++) {
      const qIdx = nonSectionIndices[i];
      const q = qs[qIdx];
      const maxScore = (typeof q === 'object' && q.maxScore) ? q.maxScore : 1;
      map.set(qIdx, clampScore(scores[i], maxScore));
    }
    return map;
  }

  // Format C: manual-only compact array (non auto-graded items).
  if (scores.length === manualOnlyIndices.length) {
    for (let i = 0; i < manualOnlyIndices.length; i++) {
      const qIdx = manualOnlyIndices[i];
      const q = qs[qIdx];
      const maxScore = (typeof q === 'object' && q.maxScore) ? q.maxScore : 1;
      map.set(qIdx, clampScore(scores[i], maxScore));
    }
    return map;
  }

  // Fallback for legacy payloads: treat values as direct indices.
  for (let i = 0; i < scores.length && i < qs.length; i++) {
    const q = qs[i];
    const maxScore = (typeof q === 'object' && q.maxScore) ? q.maxScore : 1;
    map.set(i, clampScore(scores[i], maxScore));
  }
  return map;
}

async function handleGradeButton(interaction) {
  // customId: exam_grade:<sessionId>
  try {
    await interaction.deferReply({ ephemeral: true });
    const parts = String(interaction.customId).split(':');
    const sessionId = parts[1];
    const sess = await examStore.getSessionById(sessionId);
    if (!sess) return interaction.editReply({ content: 'Session not found.' });

    // Show modal to collect comma-separated scores and feedback
    const modal = new ModalBuilder().setCustomId(`exam_grade_modal:${sessionId}`).setTitle('Grade Exam — Enter scores');
    const scoresInput = new TextInputBuilder().setCustomId('scores').setLabel('Scores (comma-separated)').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 1,0,1,1');
    const feedbackInput = new TextInputBuilder().setCustomId('feedback').setLabel('Feedback for candidate').setStyle(TextInputStyle.Paragraph).setRequired(false);
    modal.addComponents(new ActionRowBuilder().addComponents(scoresInput), new ActionRowBuilder().addComponents(feedbackInput));
    await interaction.showModal(modal);
  } catch (e) {
    console.error('handleGradeButton error:', e);
    try { await interaction.followUp({ content: 'Failed to open grading modal.', ephemeral: true }); } catch (_) {}
  }
}

async function handleGradeModalSubmit(interaction) {
  // customId: exam_grade_modal:<sessionId>
  try {
    const parts = String(interaction.customId).split(':');
    const sessionId = parts[1];
    const scoresRaw = interaction.fields.getTextInputValue('scores') || '';
    const feedback = interaction.fields.getTextInputValue('feedback') || '';
    const scoreParts = scoresRaw.split(',').map(s => parseFloat(s.trim())).filter(s => !Number.isNaN(s));
    await processGrade({ sessionId, scores: scoreParts, feedback, reviewerTag: interaction.user.tag, client: interaction.client });
    await interaction.reply({ content: 'Saved scores. Candidate notified.', ephemeral: true });
  } catch (e) {
    console.error('handleGradeModalSubmit error:', e);
    try { await interaction.reply({ content: 'Failed to record scores.', ephemeral: true }); } catch (_) {}
  }
}

async function processGrade({ sessionId, scores = [], feedback = '', reviewerTag = 'web', client }) {
  const sess = await examStore.getSessionById(sessionId);
  if (!sess) throw new Error('Session not found');

  // Calculate total possible based on answerable question maxScore fields.
  const qs = sess.questions || [];
  const totalPossible = qs.reduce((sum, q) => {
    if (isSectionItem(q)) return sum;
    return sum + ((typeof q === 'object' && q.maxScore) ? q.maxScore : 1);
  }, 0);
  
  // Auto-grade objective question types and merge with manual scores.
  const finalScores = [];
  const manualScoreMap = buildManualScoreMap(scores, qs);
  const as = sess.answers || [];
  const answerByIndex = new Map(as.map(entry => [Number(entry.index), entry]));
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (isSectionItem(q)) {
      finalScores[i] = 0;
      continue;
    }

    const maxScore = (typeof q === 'object' && q.maxScore) ? q.maxScore : 1;
    const answerEntry = answerByIndex.get(i);
    // If MC question, auto-grade it.
    if (typeof q === 'object' && q.type === 'multiplechoice' && q.correctAnswer) {
      const userAnswer = answerEntry ? String(answerEntry.answer).toUpperCase() : '';
      const correctAnswer = String(q.correctAnswer).toUpperCase();
      finalScores[i] = userAnswer === correctAnswer ? maxScore : 0;
    } else if (typeof q === 'object' && q.type === 'selection' && q.correctAnswer) {
      const userAnswer = answerEntry ? normalizeSelectionAnswer(answerEntry.answer) : '';
      const correctAnswer = normalizeSelectionAnswer(q.correctAnswer);
      finalScores[i] = userAnswer && userAnswer === correctAnswer ? maxScore : 0;
    } else {
      // Use normalized manual score mapping to avoid index drift with section rows.
      finalScores[i] = manualScoreMap.has(i) ? manualScoreMap.get(i) : 0;
    }
  }
  
  const totalScored = finalScores.reduce((a,b)=>a+(Number(b)||0),0);
  const percent = totalPossible ? Math.round((totalScored/totalPossible)*100) : 0;
  const passed = percent >= (sess.passThreshold || config.EXAM_PASS_THRESHOLD || 70);
  const review = { scoredAt: Date.now(), scores: finalScores, totalScored, percent, passed, feedback, reviewer: reviewerTag };
  await examStore.setReview(sessionId, review);

  // Fetch updated session and call finalizeReview to edit message and send DM
  const updatedSess = await examStore.getSessionById(sessionId);
  await finalizeReview({ session: updatedSess, client });
}

module.exports = { handleGradeButton, handleGradeModalSubmit, processGrade };

async function finalizeReview({ session, client }) {
  if (!session || !session.review) throw new Error('No review to finalize');
  const review = session.review;
  
  // Calculate total possible based on answerable question maxScore fields.
  const qs = session.questions || [];
  const totalPossible = qs.reduce((sum, q) => {
    if (isSectionItem(q)) return sum;
    return sum + ((typeof q === 'object' && q.maxScore) ? q.maxScore : 1);
  }, 0);
  
  const totalScored = (review.totalScored !== undefined) ? review.totalScored : (Array.isArray(review.scores) ? review.scores.slice(0, session.questions.length).reduce((a,b)=>a+(Number(b)||0),0) : 0);
  const percent = review.percent !== undefined ? review.percent : (totalPossible ? Math.round((totalScored/totalPossible)*100) : 0);
  const passed = percent >= (session.passThreshold || config.EXAM_PASS_THRESHOLD || 70);

  // Edit the review message if present
  try {
    const channel = session.reviewChannelId ? await client.channels.fetch(session.reviewChannelId).catch(()=>null) : null;
    if (channel && session.reviewMessageId) {
      const embed = new EmbedBuilder()
        .setTitle(`Graded — ${session.examId}`)
        .setColor(passed ? 0x57F287 : 0xED4245)
        .addFields(
          { name: 'Candidate', value: `<@${session.userId}>`, inline: true },
          { name: 'Score', value: `${totalScored}/${totalPossible} (${percent}%)`, inline: true },
          { name: 'Result', value: passed ? '✅ Passed' : '❌ Failed', inline: true }
        )
        .setFooter({ text: `Graded by ${review.reviewer || 'web'}` })
        .setTimestamp(new Date());
      await channel.messages.fetch(session.reviewMessageId).then(m => m.edit({ embeds: [embed], components: [] })).catch(()=>null);
    }
  } catch (e) { console.error('Failed to edit review message (finalize):', e); }

  // DM candidate with detailed feedback
  try {
    const user = await client.users.fetch(session.userId).catch(()=>null);
    if (user) {
      const fbEmbed = new EmbedBuilder()
        .setTitle(`Exam Results — ${session.examId}`)
        .setColor(passed ? 0x57F287 : 0xED4245)
        .addFields({ name: 'Score', value: `${totalScored}/${totalPossible} (${percent}%)`, inline: true }, { name: 'Passed', value: passed ? 'Yes' : 'No', inline: true }, { name: 'Feedback', value: review.feedback || '(none)', inline: false })
        .setTimestamp(new Date());
      await user.send({ embeds: [fbEmbed] }).catch(()=>null);
    }
  } catch (e) { console.error('Failed to DM candidate results (finalize):', e); }

  // Mark review as processed so we don't handle it again
  try {
    review.processed = true;
    await require('./examStore').setReview(session.id, review);
  } catch (e) { console.error('Failed to mark review processed:', e); }
}

module.exports.finalizeReview = finalizeReview;
