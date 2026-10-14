const config = require('../../config');
const aiStore = require('./aiStore');
const { getClient } = require('./anthropicClient');
const { fetchGoogleDocs } = require('./sources/googleDocs');
const { fetchTrelloBoards } = require('./sources/trello');
const { syncWiki, renderWikiDocs, pageKey } = require('./sources/wiki');

// Builds and keeps fresh the knowledge text the assistant answers from.
//
// The rendered text goes into the cached part of the prompt, so it must be
// byte-identical between rebuilds unless a source actually changed (no
// timestamps of when we synced, stable ordering). A failing source keeps its
// previous content rather than disappearing from the knowledge base.

const WIKI_FULL_CRAWL_MS = 24 * 60 * 60 * 1000;
// Haiku pricing steps up above 100K prompt tokens; warn well before that.
const TOKEN_WARN_THRESHOLD = 90_000;

const state = {
  docs: [],
  trello: [],
  wikiPages: new Map(),
  wikiEditDates: {},
  wikiExcluded: new Set(),
  wikiLastSync: null,
  wikiLastFullCrawl: 0,
  text: '',
  tokens: null,
  builtAt: null,
  lastSyncAt: null,
  errors: {},
  syncing: null
};

function escapeAttr(v) {
  return String(v || '').replace(/"/g, "'");
}

function renderSource(kind, doc) {
  const attrs = [`type="${kind}"`, `title="${escapeAttr(doc.title)}"`, `url="${escapeAttr(doc.url)}"`];
  if (doc.updated) attrs.push(`last_edited="${doc.updated}"`);
  return `<source ${attrs.join(' ')}>\n${doc.text}\n</source>`;
}

function render() {
  const wikiDocs = renderWikiDocs(state.wikiPages, state.wikiEditDates, state.wikiExcluded);
  const parts = [];
  parts.push('<authoritative_sources>');
  for (const d of state.docs) parts.push(renderSource('guideline_document', d));
  for (const d of state.trello) parts.push(renderSource('trello_board', d));
  parts.push('</authoritative_sources>');
  parts.push('<background_sources>');
  for (const d of wikiDocs) parts.push(renderSource('wiki_page', d));
  parts.push('</background_sources>');
  return { text: parts.join('\n\n'), wikiCount: wikiDocs.length };
}

async function countTokens(text) {
  const client = getClient();
  if (!client) return Math.round(text.length / 4);
  try {
    const res = await client.messages.countTokens({
      model: config.AI_MODEL,
      system: text,
      messages: [{ role: 'user', content: '.' }]
    });
    return res.input_tokens;
  } catch (e) {
    return Math.round(text.length / 4);
  }
}

async function loadPersisted() {
  try {
    const dates = await aiStore.cacheGet('wiki_edit_dates');
    if (dates && typeof dates === 'object') state.wikiEditDates = dates;
    const excluded = await aiStore.cacheGet('wiki_excluded');
    if (Array.isArray(excluded)) state.wikiExcluded = new Set(excluded);
  } catch (e) {
    console.warn('AI knowledge: could not load persisted state:', e.message || e);
  }
}

async function runSync({ forceFullWiki = false } = {}) {
  const startedAt = new Date();

  try {
    state.docs = await fetchGoogleDocs();
    delete state.errors.docs;
  } catch (e) {
    state.errors.docs = e.message || String(e);
    console.error('AI knowledge: Google Docs sync failed:', e.message || e);
  }

  try {
    state.trello = await fetchTrelloBoards();
    delete state.errors.trello;
  } catch (e) {
    state.errors.trello = e.message || String(e);
    console.error('AI knowledge: Trello sync failed:', e.message || e);
  }

  try {
    const full = forceFullWiki || Date.now() - state.wikiLastFullCrawl > WIKI_FULL_CRAWL_MS;
    const res = await syncWiki({
      previous: state.wikiPages,
      full,
      since: state.wikiLastSync,
      excluded: state.wikiExcluded,
      editDates: state.wikiEditDates
    });
    state.wikiPages = res.pages;
    state.wikiEditDates = res.editDates;
    state.wikiLastSync = startedAt.toISOString();
    if (full) state.wikiLastFullCrawl = Date.now();
    aiStore.cacheSet('wiki_edit_dates', state.wikiEditDates).catch(() => {});
    delete state.errors.wiki;
  } catch (e) {
    state.errors.wiki = e.message || String(e);
    console.error('AI knowledge: wiki sync failed:', e.message || e);
  }

  await rebuild();
  state.lastSyncAt = new Date();
}

async function rebuild() {
  const { text, wikiCount } = render();
  if (text === state.text) return false;
  state.text = text;
  state.builtAt = new Date();
  state.tokens = await countTokens(text);
  console.info(`AI knowledge rebuilt: ${state.docs.length} docs, ${state.trello.length} boards, ${wikiCount} wiki pages, ~${state.tokens} tokens`);
  if (state.tokens > TOKEN_WARN_THRESHOLD) {
    console.warn(`AI knowledge is ${state.tokens} tokens — approaching the 100K price step for ${config.AI_MODEL}.`);
  }
  return true;
}

// Serialises syncs: a reload requested during a sync waits for it instead of running twice.
function sync(opts) {
  if (!state.syncing) {
    state.syncing = runSync(opts)
      .catch(e => console.error('AI knowledge sync crashed:', e))
      .finally(() => { state.syncing = null; });
  }
  return state.syncing;
}

function startKnowledgeSync() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.info('ANTHROPIC_API_KEY not set — AI assistant disabled.');
    return;
  }
  loadPersisted().then(() => sync({ forceFullWiki: true }));
  const intervalMs = Math.max(5, Number(config.AI_SYNC_INTERVAL_MINUTES) || 30) * 60 * 1000;
  setInterval(() => sync(), intervalMs).unref();
}

function getKnowledgeText() {
  return state.text;
}

function isReady() {
  return !!state.text;
}

async function setWikiExcluded(urlOrSlug, excluded) {
  const base = config.AI_WIKI_BASE_URL.replace(/\/+$/, '');
  const raw = String(urlOrSlug || '').trim();
  const url = /^https?:\/\//.test(raw) ? raw : `${base}/${raw.replace(/^\/+/, '')}`;
  const key = pageKey(url);
  if (excluded) state.wikiExcluded.add(key);
  else state.wikiExcluded.delete(key);
  await aiStore.cacheSet('wiki_excluded', Array.from(state.wikiExcluded));
  await rebuild();
  return key;
}

function getStatus() {
  const keptWiki = Array.from(state.wikiPages.keys()).filter(k => !k.startsWith('skip:'));
  const skipped = Array.from(state.wikiPages.entries()).filter(([k]) => k.startsWith('skip:'));
  return {
    ready: isReady(),
    syncing: !!state.syncing,
    tokens: state.tokens,
    builtAt: state.builtAt,
    lastSyncAt: state.lastSyncAt,
    docs: state.docs.map(d => ({ title: d.title, updated: d.updated, chars: d.text.length })),
    trello: state.trello.map(d => ({ title: d.title, updated: d.updated, chars: d.text.length })),
    wikiKept: keptWiki.filter(k => !state.wikiExcluded.has(k)).length,
    wikiSkipped: skipped.map(([k, v]) => `${k.replace(/^skip:[^/]+\//, '')} (${v.reason})`),
    wikiExcluded: Array.from(state.wikiExcluded),
    errors: { ...state.errors }
  };
}

module.exports = {
  startKnowledgeSync,
  sync,
  getKnowledgeText,
  isReady,
  getStatus,
  setWikiExcluded
};
