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
// timestamps of when we synced, stable ordering).
//
// Every doc/board keeps its last good copy: a fetch that fails or comes back
// (nearly) empty never replaces it. Last good copies are persisted to the
// database so a restart during a Google/Trello/wiki outage still starts with
// full knowledge.

const WIKI_FULL_CRAWL_MS = 24 * 60 * 60 * 1000;
// Haiku pricing steps up above 100K prompt tokens; warn well before that.
const TOKEN_WARN_THRESHOLD = 90_000;
// A doc/board shorter than this is treated as a failed fetch, not as real content.
const MIN_SOURCE_CHARS = 200;

const state = {
  docs: new Map(),
  trello: new Map(),
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

function docKeys() {
  return config.AI_GOOGLE_DOC_IDS_LIST.map(id => `doc:${id}`);
}

function boardKeys() {
  return config.AI_TRELLO_BOARD_IDS_LIST.map(id => `trello:${id}`);
}

// Loaded docs/boards in configured order.
function loaded(map, keys) {
  return keys.map(k => map.get(k)).filter(Boolean);
}

/**
 * Merges fresh fetch results into `map`, keeping the previous copy for any
 * item that failed or came back too short. Returns error strings for status.
 */
function mergeSources(map, results) {
  const errors = [];
  for (const r of results) {
    const prev = map.get(r.key);
    const label = (prev && prev.title) || r.title || r.key;
    if (r.error) {
      errors.push(`${label}: ${r.error}${prev ? ' (previous copy kept)' : ''}`);
      continue;
    }
    if (String(r.text || '').trim().length < MIN_SOURCE_CHARS) {
      errors.push(`${label}: came back empty${prev ? ' (previous copy kept)' : ''}`);
      continue;
    }
    if (!prev || prev.text !== r.text || prev.title !== r.title || prev.updated !== r.updated) {
      aiStore.cacheSet(`source:${r.key}`, r).catch(e => console.warn('AI knowledge: could not persist source:', e.message || e));
    }
    map.set(r.key, r);
  }
  return errors;
}

function render() {
  const docs = loaded(state.docs, docKeys());
  const boards = loaded(state.trello, boardKeys());
  // Without the guidelines or Trello the assistant would answer from the wiki alone; better not to answer.
  if (docs.length === 0 && boards.length === 0) return { text: '', wikiCount: 0 };

  const wikiDocs = renderWikiDocs(state.wikiPages, state.wikiEditDates, state.wikiExcluded);
  const parts = [];
  parts.push('<authoritative_sources>');
  for (const d of docs) parts.push(renderSource('guideline_document', d));
  for (const d of boards) parts.push(renderSource('trello_board', d));
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
    for (const key of [...docKeys(), ...boardKeys()]) {
      const saved = await aiStore.cacheGet(`source:${key}`);
      if (saved && typeof saved.text === 'string' && saved.text.trim().length >= MIN_SOURCE_CHARS) {
        (key.startsWith('doc:') ? state.docs : state.trello).set(key, saved);
      }
    }
    const wiki = await aiStore.cacheGet('wiki_pages');
    if (Array.isArray(wiki)) state.wikiPages = new Map(wiki);
  } catch (e) {
    console.warn('AI knowledge: could not load persisted state:', e.message || e);
  }
  // Serve the last known copy right away; the sync that follows refreshes it.
  if (await rebuild()) console.info('AI knowledge: started from saved copy while syncing');
}

function setErrors(key, errors) {
  if (errors.length) {
    state.errors[key] = errors.join('; ');
    console.error(`AI knowledge: ${key} sync problems: ${state.errors[key]}`);
  } else {
    delete state.errors[key];
  }
}

async function runSync({ forceFullWiki = false } = {}) {
  const startedAt = new Date();

  try {
    setErrors('docs', mergeSources(state.docs, await fetchGoogleDocs()));
  } catch (e) {
    setErrors('docs', [`${e.message || e}${state.docs.size ? ' (previous copies kept)' : ''}`]);
  }

  try {
    setErrors('trello', mergeSources(state.trello, await fetchTrelloBoards()));
  } catch (e) {
    setErrors('trello', [`${e.message || e}${state.trello.size ? ' (previous copies kept)' : ''}`]);
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
    const changed = JSON.stringify(Array.from(res.pages)) !== JSON.stringify(Array.from(state.wikiPages));
    state.wikiPages = res.pages;
    state.wikiEditDates = res.editDates;
    state.wikiLastSync = startedAt.toISOString();
    if (full) state.wikiLastFullCrawl = Date.now();
    aiStore.cacheSet('wiki_edit_dates', state.wikiEditDates).catch(() => {});
    if (changed) aiStore.cacheSet('wiki_pages', Array.from(state.wikiPages)).catch(() => {});
    delete state.errors.wiki;
  } catch (e) {
    setErrors('wiki', [`${e.message || e}${state.wikiPages.size ? ' (previous copy kept)' : ''}`]);
  }

  await rebuild();
  state.lastSyncAt = new Date();
}

async function rebuild() {
  const { text, wikiCount } = render();
  if (text === state.text) return false;
  state.text = text;
  state.builtAt = new Date();
  if (!text) {
    state.tokens = 0;
    console.warn('AI knowledge: no guideline documents or Trello boards loaded — assistant unavailable.');
    return true;
  }
  state.tokens = await countTokens(text);
  console.info(`AI knowledge rebuilt: ${state.docs.size} docs, ${state.trello.size} boards, ${wikiCount} wiki pages, ~${state.tokens} tokens`);
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

// Configured sources with no copy at all (never loaded successfully), for the prompt and status.
function getMissingSources() {
  const missing = [];
  for (const k of docKeys()) if (!state.docs.has(k)) missing.push(`Google Doc ${k.slice(4)}`);
  for (const k of boardKeys()) if (!state.trello.has(k)) missing.push(`Trello board ${k.slice(7)}`);
  if (!Array.from(state.wikiPages.keys()).some(k => !k.startsWith('skip:'))) missing.push('the SGC wiki');
  return missing;
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
    docs: loaded(state.docs, docKeys()).map(d => ({ title: d.title, updated: d.updated, chars: d.text.length })),
    trello: loaded(state.trello, boardKeys()).map(d => ({ title: d.title, updated: d.updated, chars: d.text.length })),
    missing: getMissingSources(),
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
  getMissingSources,
  setWikiExcluded
};
