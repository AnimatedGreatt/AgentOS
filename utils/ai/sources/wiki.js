const axios = require('axios');
const crypto = require('crypto');
const config = require('../../../config');

// Reads the community wiki (wikidot). Pages are discovered through the sitemap,
// tales/system pages are skipped, and unfinished pages ("WIP", placeholders,
// near-empty) are dropped. The site-changes RSS feed is used to learn when a
// page was last edited and to re-fetch only changed pages between full crawls.

const HEADERS = { 'User-Agent': 'AgentOS-Discord-Bot (knowledge sync)' };
const REQUEST_DELAY_MS = 400;
const MIN_CONTENT_CHARS = 200;

// Wikidot system/meta pages and the "Tales" (fiction) section.
const EXCLUDE_PATTERNS = [
  /\/(system|help|forum|css|admincss|component|deleted|legal|nav|search|admin|home|template|test)[:/-]/i,
  /\/(_admin|test-env(-\d+)?)$/i,
  /tale/i,
  /canon/i,
  /fan-submission/i,
  // Superseded copies kept around by editors, e.g. main:medical-operations-agency-old
  /-old$/i
];
const EXCLUDE_TAGS = [/tale/i, /fiction/i, /story/i];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Tab-view headers ("Shield", "GFX") are UI chrome.
    .replace(/<ul class="yui-nav">[\s\S]*?<\/ul>/gi, '')
    // Source newlines are insignificant in HTML; structure comes from the tags below.
    .replace(/\s+/g, ' ');
  s = s
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Math.min(Number(n) + 1, 4))} `)
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n---\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<tr[^>]*>/gi, '\n|')
    .replace(/<\/t[hd]>/gi, ' |')
    .replace(/<\/(p|div|ul|ol|table|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\|\n+\|/g, '|\n|')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractPage(html) {
  const titleMatch = html.match(/<div id="page-title"[^>]*>([\s\S]*?)<\/div>/);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '')).trim() : null;

  const start = html.indexOf('id="page-content"');
  if (start < 0) return { title, text: '', tags: [] };
  const contentStart = html.indexOf('>', start) + 1;
  const ends = ['class="page-tags"', 'id="page-info"', 'id="page-options-bottom"', 'id="footer"']
    .map(m => html.indexOf(m, contentStart))
    .filter(i => i > 0);
  const contentEnd = ends.length ? Math.min(...ends) : html.length;
  // Back up to the opening "<div" of the end marker.
  const cut = html.lastIndexOf('<', contentEnd);

  const tagsBlock = html.slice(contentEnd, contentEnd + 2000).match(/class="page-tags"[\s\S]*?<\/div>/);
  const tags = tagsBlock ? Array.from(tagsBlock[0].matchAll(/>([^<>]+)<\/a>/g)).map(m => m[1].trim()) : [];

  return { title, text: htmlToText(html.slice(contentStart, cut > contentStart ? cut : contentEnd)), tags };
}

function isUnfinished(text) {
  const plain = text.replace(/[#|\-\s]+/g, ' ').trim();
  if (plain.length < MIN_CONTENT_CHARS) return true;
  if (/^(wip|work in progress|coming soon|tbd|under construction)\b/i.test(plain) && plain.length < 400) return true;
  if (/lorem ipsum/i.test(plain) && plain.length < 1500) return true;
  return false;
}

function pageKey(url) {
  return url.replace(/\/+$/, '').replace(/^https?:\/\//, '');
}

async function listPageUrls(base) {
  const res = await axios.get(`${base}/sitemap.xml`, { headers: HEADERS, timeout: 20000 });
  const urls = Array.from(String(res.data).matchAll(/<loc>([^<]+)<\/loc>/g)).map(m => m[1].trim().replace(/^http:/, 'https:'));
  return Array.from(new Set(urls)).filter(u => u !== `${base}/` && !EXCLUDE_PATTERNS.some(p => p.test(u)));
}

/**
 * Returns [{ link, editedAt }] from the site-changes feed (newest first).
 */
async function fetchRecentChanges(base) {
  const res = await axios.get(`${base}/feed/site-changes.xml`, { headers: HEADERS, timeout: 20000 });
  const items = Array.from(String(res.data).matchAll(/<item>([\s\S]*?)<\/item>/g)).map(m => m[1]);
  return items.map(item => {
    const link = (item.match(/<link>([^<]+)<\/link>/) || [])[1];
    const date = (item.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1];
    return link && date ? { link: link.trim().replace(/^http:/, 'https:'), editedAt: new Date(date).toISOString().slice(0, 10) } : null;
  }).filter(Boolean);
}

async function fetchPage(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  return extractPage(String(res.data));
}

/**
 * Crawls (or incrementally refreshes) the wiki.
 * @param {object} opts
 * @param {Map} opts.previous - previous pages by key ({ url, title, text, tags, hash })
 * @param {boolean} opts.full - re-fetch every page instead of only changed ones
 * @param {string|null} opts.since - ISO date of the last successful sync (for incremental mode)
 * @param {Set<string>} opts.excluded - page keys excluded by staff
 * @param {object} opts.editDates - persisted { pageKey: 'YYYY-MM-DD' }
 * @returns {Promise<{ pages: Map, editDates: object, skipped: string[] }>}
 */
async function syncWiki({ previous, full, since, excluded, editDates }) {
  const base = config.AI_WIKI_BASE_URL.replace(/\/+$/, '');
  const dates = { ...(editDates || {}) };

  let changes = [];
  try {
    changes = await fetchRecentChanges(base);
    for (const c of changes) {
      const k = pageKey(c.link);
      if (!dates[k] || dates[k] < c.editedAt) dates[k] = c.editedAt;
    }
  } catch (e) {
    console.warn('AI wiki: could not read changes feed:', e.message || e);
  }

  const urls = await listPageUrls(base);
  // An outage can serve an empty sitemap; treating that as "every page was deleted" would wipe the wiki.
  if (urls.length === 0) throw new Error('Wiki sitemap returned no pages');
  const toFetch = full || !previous || previous.size === 0
    ? urls
    : urls.filter(u => {
      const k = pageKey(u);
      if (!previous.has(k) && !previous.has(`skip:${k}`)) return true; // new page
      return changes.some(c => pageKey(c.link) === k && (!since || c.editedAt >= since.slice(0, 10)));
    });

  const pages = new Map(previous || []);
  const skipped = [];
  for (const url of toFetch) {
    const k = pageKey(url);
    try {
      const page = await fetchPage(url);
      pages.delete(k);
      pages.delete(`skip:${k}`);
      if (page.tags.some(t => EXCLUDE_TAGS.some(p => p.test(t)))) {
        pages.set(`skip:${k}`, { reason: 'tale' });
      } else if (isUnfinished(page.text)) {
        pages.set(`skip:${k}`, { reason: 'unfinished' });
      } else {
        pages.set(k, {
          url,
          title: page.title || k,
          text: page.text,
          hash: crypto.createHash('sha1').update(page.text).digest('hex')
        });
      }
    } catch (e) {
      console.warn(`AI wiki: failed to fetch ${url}:`, e.message || e);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  // Drop pages removed from the sitemap.
  const live = new Set(urls.map(pageKey));
  for (const k of Array.from(pages.keys())) {
    const bare = k.replace(/^skip:/, '');
    if (!live.has(bare)) pages.delete(k);
  }

  // If most previously usable pages vanished in one sync, the wiki is more likely broken than edited
  // (maintenance pages, rate limiting). Keep the previous copy instead; the caller records the error.
  const countKept = (m) => Array.from(m.keys()).filter(k => !k.startsWith('skip:')).length;
  const before = previous ? countKept(previous) : 0;
  const after = countKept(pages);
  if (before >= 5 && after < before * 0.5) {
    throw new Error(`Wiki sync dropped from ${before} to ${after} usable pages; keeping the previous copy`);
  }

  for (const k of pages.keys()) if (k.startsWith('skip:')) skipped.push(k.slice(5));

  // Staff exclusions are applied at render time so they can be toggled without a re-crawl.
  return { pages, editDates: dates, skipped, excluded };
}

/**
 * Renders kept wiki pages as knowledge-base documents, de-duplicating pages
 * that are reachable under two URLs (e.g. /divisions and /main:divisions).
 */
function renderWikiDocs(pages, editDates, excluded) {
  const seen = new Set();
  const docs = [];
  const keys = Array.from(pages.keys()).filter(k => !k.startsWith('skip:')).sort();
  for (const k of keys) {
    if (excluded && excluded.has(k)) continue;
    const page = pages.get(k);
    if (seen.has(page.hash)) continue;
    seen.add(page.hash);
    docs.push({
      key: `wiki:${k}`,
      title: page.title,
      updated: editDates[k] || null,
      url: page.url,
      text: page.text
    });
  }
  return docs;
}

module.exports = { syncWiki, renderWikiDocs, pageKey, htmlToText, extractPage };
