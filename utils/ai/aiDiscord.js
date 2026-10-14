const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, cleanContent
} = require('discord.js');
const config = require('../../config');
const aiStore = require('./aiStore');
const knowledgeBase = require('./knowledgeBase');
const { askAi, AiUnavailableError } = require('./askAi');

// Discord-facing side of the AI assistant: @mention questions, /ask (see
// commands/ask.js), the "wrong answer" report flow and the `!ai` admin commands.

const PAUSE_KEY = 'ask';
// Short-term memory: the asker's own recent exchanges with the assistant in this channel.
const MEMORY_MINUTES = 10;
const MEMORY_EXCHANGES = 3;
// Reply chain: always included, regardless of age.
const REPLY_CHAIN_DEPTH = 4;
const REPLY_CHAIN_CHARS = 600;
// Recent channel chat: background only, so kept short.
const CHAT_WINDOW_MS = 10 * 60 * 1000;
const CHAT_MESSAGES = 10;
const CHAT_CHARS = 300;
const BOT_MESSAGE_CHARS = 1900;

// Haiku 5.5 rates, USD per million tokens (prompts under 100K tokens). Cache writes use the 1h TTL (2x input).
const PRICE = { input: 0.10, cacheRead: 0.01, cacheWrite: 0.20, output: 0.50 };

const usageByUser = new Map();

function isAdmin(userId) {
  return (config.ADMIN_WHITELIST || []).includes(userId);
}

function isAiGuild(guildId) {
  return !!guildId && config.AI_GUILD_IDS_LIST.includes(guildId);
}

async function isPaused() {
  try {
    const { isPaused: check } = require('../pausedCommands');
    return await check(PAUSE_KEY);
  } catch (e) {
    return false;
  }
}

/**
 * Returns an error message when the user is rate limited, otherwise records the use and returns null.
 */
function checkRateLimit(userId) {
  if (isAdmin(userId)) return null;
  const now = Date.now();
  const day = new Date().toISOString().slice(0, 10);
  const entry = usageByUser.get(userId) || { last: 0, day, count: 0 };
  if (entry.day !== day) { entry.day = day; entry.count = 0; }

  const cooldownMs = (Number(config.AI_USER_COOLDOWN_SECONDS) || 0) * 1000;
  if (now - entry.last < cooldownMs) {
    return `Slow down a little — you can ask again in ${Math.ceil((cooldownMs - (now - entry.last)) / 1000)}s.`;
  }
  const limit = Number(config.AI_USER_DAILY_LIMIT) || 0;
  if (limit > 0 && entry.count >= limit) {
    return `You've reached today's limit of ${limit} questions. It resets at midnight UTC.`;
  }
  entry.last = now;
  entry.count += 1;
  usageByUser.set(userId, entry);
  return null;
}

function feedbackRow(queryId) {
  if (!queryId) return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ai_fb:${queryId}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('👎')
      .setLabel('Wrong answer')
  )];
}

/**
 * Asks the model and logs the query. Returns the reply payload for Discord.
 */
async function answerQuestion({ question, context, user, member, guildId, channelId, source }) {
  const askerName = (member && member.displayName) || user.globalName || user.username;
  try {
    const result = await askAi({ question, askerName, context });
    let queryId = null;
    try {
      queryId = await aiStore.logQuery({
        userId: user.id,
        userTag: user.tag,
        guildId,
        channelId,
        source,
        question,
        answer: result.text,
        usage: result.usage,
        latencyMs: result.latencyMs
      });
    } catch (e) {
      console.warn('AI: failed to log query:', e.message || e);
    }
    return { queryId, payload: { content: result.text, components: feedbackRow(queryId), allowedMentions: { parse: [], repliedUser: false } } };
  } catch (e) {
    const content = e instanceof AiUnavailableError
      ? e.message
      : 'Something went wrong while answering — try again in a moment.';
    if (!(e instanceof AiUnavailableError)) console.error('AI: answer failed:', e);
    return { queryId: null, payload: { content, allowedMentions: { parse: [], repliedUser: false } } };
  }
}

function stripBotMention(content, botId) {
  return String(content || '').replace(new RegExp(`<@!?${botId}>`, 'g'), ' ').replace(/\s+/g, ' ').trim();
}

function describeMessage(msg, client, maxChars) {
  const isBot = msg.author.id === client.user.id;
  let text = cleanContent(stripBotMention(msg.content, client.user.id), msg.channel);
  if (!text && msg.embeds && msg.embeds.length) {
    const e = msg.embeds[0];
    text = [e.title, e.description].filter(Boolean).join(' — ');
  }
  if (!text) return null;
  // One line per message, so the model can tell where each message starts.
  text = text.replace(/\s*\n+\s*/g, ' ↵ ');
  const limit = isBot ? BOT_MESSAGE_CHARS : maxChars;
  if (text.length > limit) text = `${text.slice(0, limit)}…`;
  let name;
  if (isBot) {
    // Slash command replies don't show who asked unless we say so.
    const meta = msg.interactionMetadata;
    name = meta && meta.user
      ? `AgentOS (you), answering ${displayNameOf(msg.guild, meta.user)}'s /ask`
      : 'AgentOS (you)';
  } else {
    name = (msg.member && msg.member.displayName) || msg.author.globalName || msg.author.username;
  }
  return `${name}: ${text}`;
}

function displayNameOf(guild, user) {
  const member = guild && guild.members.cache.get(user.id);
  return (member && member.displayName) || user.globalName || user.username;
}

/**
 * Builds the three context sections for a question:
 *  - memory: the asker's own recent questions/answers in this channel (full text)
 *  - replyChain: messages the question replies to, oldest first (always included)
 *  - chat: recent channel messages, shortened; usually unrelated, the model is told to ignore what isn't referenced
 * @param {object} p
 * @param {import('discord.js').Message} [p.message] - the question message (mentions); omitted for /ask
 */
async function buildContext({ client, channel, userId, message }) {
  const memoryRows = await aiStore.recentExchanges(userId, channel.id, MEMORY_MINUTES, MEMORY_EXCHANGES).catch(() => []);
  const memory = memoryRows.map(r => ({ question: r.question, answer: r.answer }));
  const memoryUrls = new Set(memoryRows.map(r => r.message_url).filter(Boolean));

  const chainMessages = [];
  let cursor = message;
  for (let i = 0; cursor && i < REPLY_CHAIN_DEPTH && cursor.reference && cursor.reference.messageId; i++) {
    try {
      cursor = await channel.messages.fetch(cursor.reference.messageId);
      chainMessages.unshift(cursor);
    } catch (e) {
      break;
    }
  }
  const chainIds = new Set(chainMessages.map(m => m.id));
  const replyChain = chainMessages
    // Bot answers already present in memory don't need repeating.
    .filter(m => !(m.author.id === client.user.id && memoryUrls.has(m.url)))
    .map(m => describeMessage(m, client, REPLY_CHAIN_CHARS))
    .filter(Boolean);

  let chat = [];
  try {
    const now = message ? message.createdTimestamp : Date.now();
    const fetched = await channel.messages.fetch({ limit: CHAT_MESSAGES + 5, ...(message ? { before: message.id } : {}) });
    chat = Array.from(fetched.values())
      .filter(m => now - m.createdTimestamp <= CHAT_WINDOW_MS)
      .filter(m => !chainIds.has(m.id))
      // Skip the asker's earlier questions and the bot's answers to them; they are in memory.
      .filter(m => !(m.author.id === client.user.id && memoryUrls.has(m.url)))
      .filter(m => !(m.author.id === userId && m.mentions && m.mentions.users && m.mentions.users.has(client.user.id)))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
      .slice(-CHAT_MESSAGES)
      .map(m => describeMessage(m, client, CHAT_CHARS))
      .filter(Boolean);
  } catch (e) {
    // missing history permission — answer without chat context
  }

  return { memory, replyChain, chat };
}

/**
 * Answers questions asked by @mentioning the bot (or replying to it with ping on).
 * Messages containing a `!command` are left to messageCommands.js, except `!ai`.
 */
async function handleAiMention(message, client) {
  if (message.author.bot || !message.guild) return;
  if (!message.mentions || !message.mentions.users || !message.mentions.users.has(client.user.id)) return;

  const content = stripBotMention(message.content, client.user.id);
  if (/^!ai\b/i.test(content)) {
    await handleAiAdminCommand(message, content);
    return;
  }
  if (/(^|\s)![a-zø]/i.test(content)) return;
  // Opt-out flag: lets people mention the bot in conversation without triggering an answer.
  if (/(^|\s)--ai(\s|$)/i.test(content)) return;
  if (!isAiGuild(message.guild.id)) return;
  if (!process.env.ANTHROPIC_API_KEY) return;

  const reply = (payload) => message.reply({ allowedMentions: { parse: [], repliedUser: false }, ...payload }).catch(e => {
    console.error('AI: failed to reply:', e.message || e);
    return null;
  });

  if (await isPaused()) {
    await reply({ content: '❗ The AI assistant is temporarily paused by an administrator.' });
    return;
  }

  const question = cleanContent(content, message.channel).trim();
  if (!question && !message.reference) {
    await reply({ content: 'Hi! Ask me anything about OSI guidelines, the UCMJ, punishments, or the game — just mention me with your question, or use `/ask`.' });
    return;
  }

  const limited = checkRateLimit(message.author.id);
  if (limited) {
    await reply({ content: limited });
    return;
  }

  message.channel.sendTyping().catch(() => {});
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  try {
    const context = await buildContext({ client, channel: message.channel, userId: message.author.id, message });
    const { queryId, payload } = await answerQuestion({
      question: question || '(no text — see the message they replied to)',
      context,
      user: message.author,
      member: message.member,
      guildId: message.guild.id,
      channelId: message.channel.id,
      source: 'mention'
    });
    const sent = await reply(payload);
    if (sent && queryId) aiStore.setQueryMessageUrl(queryId, sent.url).catch(() => {});
  } finally {
    clearInterval(typing);
  }
}

// --- "Wrong answer" reports ---

async function handleAiFeedbackButton(interaction) {
  const queryId = Number(String(interaction.customId).split(':')[1]);
  const modal = new ModalBuilder().setCustomId(`ai_fb_modal:${queryId}`).setTitle('Report a wrong answer');
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId('comment')
      .setLabel('What was wrong or missing? (optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(1000)
  ));
  await interaction.showModal(modal);
}

function clip(text, max) {
  const s = String(text || '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : (s || '—');
}

async function handleAiFeedbackModal(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const queryId = Number(String(interaction.customId).split(':')[1]);
  const comment = interaction.fields.getTextInputValue('comment');
  if (!Number.isInteger(queryId) || queryId <= 0) {
    await interaction.editReply('Could not find that answer anymore.');
    return;
  }

  let query;
  let firstReport;
  try {
    query = await aiStore.getQuery(queryId);
    firstReport = query ? await aiStore.markReported(queryId) : false;
  } catch (e) {
    console.error('AI: feedback lookup failed:', e.message || e);
    await interaction.editReply("Couldn't save your report right now (database problem) — please try again in a bit.");
    return;
  }
  if (!query) {
    await interaction.editReply('Could not find that answer anymore.');
    return;
  }
  if (!firstReport) {
    await interaction.editReply('This answer has already been reported — thanks!');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('👎 AI answer reported')
    .setColor(0xed4245)
    .addFields(
      { name: 'Question', value: clip(query.question, 1024) },
      { name: 'Answer', value: clip(query.answer, 1024) },
      { name: 'Reporter comment', value: clip(comment, 1024) },
      { name: 'Asked by', value: `<@${query.user_id}>`, inline: true },
      { name: 'Reported by', value: `<@${interaction.user.id}>`, inline: true }
    )
    .setFooter({ text: `Query #${queryId} · Fix with: @AgentOS !ai note add <correct info>` })
    .setTimestamp(new Date(query.created_at));
  if (query.message_url) embed.setURL(query.message_url);

  try {
    const channel = await interaction.client.channels.fetch(config.AI_FEEDBACK_CHANNEL_ID);
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    await interaction.editReply('Thanks — staff have been notified so the answer can be corrected.');
  } catch (e) {
    console.error('AI: failed to post feedback report:', e.message || e);
    await interaction.editReply('Thanks — your report was saved, but I could not notify staff.');
  }
}

// --- Admin commands ---

function costOf(u) {
  if (!u) return 0;
  return (Number(u.input_tokens) * PRICE.input + Number(u.cache_read_tokens) * PRICE.cacheRead +
    Number(u.cache_write_tokens) * PRICE.cacheWrite + Number(u.output_tokens) * PRICE.output) / 1e6;
}

function fmtDate(d) {
  return d ? `<t:${Math.floor(new Date(d).getTime() / 1000)}:R>` : 'never';
}

async function statusEmbed() {
  const s = knowledgeBase.getStatus();
  const [day, month] = await Promise.all([
    aiStore.usageSince('1 day').catch(() => null),
    aiStore.usageSince('30 days').catch(() => null)
  ]);
  const notes = await aiStore.listNotes().catch(() => []);

  const sourceLines = [
    ...s.docs.map(d => `📄 ${d.title} — edited ${d.updated || '?'}`),
    ...s.trello.map(d => `🗂️ ${d.title} — activity ${d.updated || '?'}`),
    `🌐 Wiki — ${s.wikiKept} pages used, ${s.wikiSkipped.length} skipped (unfinished/tales), ${s.wikiExcluded.length} excluded by staff`
  ];
  if (s.missing.length) sourceLines.push(`❌ Not loaded: ${s.missing.join(', ')}`);
  const errors = Object.entries(s.errors).map(([k, v]) => `**${k}:** ${v}`);

  const embed = new EmbedBuilder()
    .setTitle('AI assistant status')
    .setColor(errors.length ? 0xfaa61a : 0x57f287)
    .addFields(
      { name: 'Knowledge', value: `${s.ready ? '✅ Ready' : '⏳ Loading'}${s.syncing ? ' (syncing…)' : ''} · ~${s.tokens || '?'} tokens\nLast sync ${fmtDate(s.lastSyncAt)} · last change ${fmtDate(s.builtAt)}` },
      { name: 'Sources', value: clip(sourceLines.join('\n'), 1024) },
      { name: 'Staff corrections', value: `${notes.length} active` },
      { name: 'Paused', value: (await isPaused()) ? 'Yes' : 'No', inline: true },
      { name: 'Usage (24h)', value: day ? `${day.queries} questions · ~$${costOf(day).toFixed(3)}` : 'n/a', inline: true },
      { name: 'Usage (30d)', value: month ? `${month.queries} questions · ~$${costOf(month).toFixed(2)} · ${month.reported} reported` : 'n/a', inline: true }
    );
  if (errors.length) embed.addFields({ name: '⚠️ Sync errors (previous content kept)', value: clip(errors.join('\n'), 1024) });
  if (s.wikiSkipped.length) embed.addFields({ name: 'Skipped wiki pages', value: clip(s.wikiSkipped.join(', '), 1024) });
  return embed;
}

const ADMIN_HELP = [
  '`!ai status` — sources, last sync, usage and cost',
  '`!ai reload` — re-sync all sources now',
  '`!ai note add <text>` — add a correction the assistant must follow',
  '`!ai note list` / `!ai note remove <id>`',
  '`!ai exclude <wiki page url>` / `!ai include <wiki page url>`',
  'Pause/unpause the assistant via `!admin` → Manage Commands → `ask`.'
].join('\n');

async function handleAiAdminCommand(message, content) {
  const reply = (payload) => message.reply(typeof payload === 'string'
    ? { content: payload, allowedMentions: { parse: [], repliedUser: false } }
    : { allowedMentions: { parse: [], repliedUser: false }, ...payload }).catch(() => null);

  if (!isAdmin(message.author.id)) {
    await reply('You are not authorized to use this command.');
    return;
  }

  const args = content.replace(/^!ai\b/i, '').trim();
  const [sub, ...rest] = args.split(/\s+/);
  const subLower = (sub || '').toLowerCase();

  try {
    if (subLower === 'status') {
      await reply({ embeds: [await statusEmbed()] });
    } else if (subLower === 'reload') {
      const ack = await reply('🔄 Re-syncing Docs, Trello and wiki…');
      await knowledgeBase.sync({ forceFullWiki: true });
      const s = knowledgeBase.getStatus();
      const errs = Object.keys(s.errors);
      const msg = errs.length
        ? `⚠️ Sync finished with errors in: ${errs.join(', ')} (previous content kept). See \`!ai status\`.`
        : `✅ Sync finished — ~${s.tokens} tokens of knowledge.`;
      if (ack) await ack.edit(msg).catch(() => reply(msg));
      else await reply(msg);
    } else if (subLower === 'note') {
      const action = (rest[0] || '').toLowerCase();
      if (action === 'add') {
        const text = rest.slice(1).join(' ').trim();
        if (!text) return reply('Usage: `!ai note add <text>`');
        if (text.length > 1000) return reply('Keep notes under 1000 characters.');
        const id = await aiStore.addNote(cleanContent(text, message.channel), message.author.id, message.author.tag);
        await reply(`✅ Correction #${id} added. It applies to the next question.`);
      } else if (action === 'remove') {
        const id = Number(rest[1]);
        if (!Number.isInteger(id)) return reply('Usage: `!ai note remove <id>`');
        await reply((await aiStore.removeNote(id)) ? `🗑️ Correction #${id} removed.` : `No correction #${id}.`);
      } else {
        const notes = await aiStore.listNotes();
        const body = notes.length
          ? notes.map(n => `**#${n.id}** ${n.text} — *${n.author_tag || 'unknown'}*`).join('\n')
          : 'No corrections yet. Add one with `!ai note add <text>`.';
        await reply({ embeds: [new EmbedBuilder().setTitle('AI staff corrections').setColor(config.EMBED_COLOR || 0x00aff1).setDescription(clip(body, 4000))] });
      }
    } else if (subLower === 'exclude' || subLower === 'include') {
      const target = rest.join(' ').trim();
      if (!target) return reply(`Usage: \`!ai ${subLower} <wiki page url>\``);
      const key = await knowledgeBase.setWikiExcluded(target, subLower === 'exclude');
      await reply(subLower === 'exclude' ? `🚫 Wiki page \`${key}\` excluded.` : `✅ Wiki page \`${key}\` included again.`);
    } else {
      await reply({ embeds: [new EmbedBuilder().setTitle('AI admin commands').setColor(config.EMBED_COLOR || 0x00aff1).setDescription(ADMIN_HELP)] });
    }
  } catch (e) {
    console.error('AI admin command failed:', e);
    await reply('That command failed — check the logs.');
  }
}

module.exports = {
  PAUSE_KEY,
  isAiGuild,
  isPaused,
  checkRateLimit,
  buildContext,
  answerQuestion,
  handleAiMention,
  handleAiFeedbackButton,
  handleAiFeedbackModal
};
