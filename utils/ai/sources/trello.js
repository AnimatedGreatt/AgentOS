const axios = require('axios');
const config = require('../../../config');
const { describeImage } = require('../imageReader');

// Reads the configured Trello boards (open lists and cards only). Card labels
// are kept because they carry punishment/infraction categories, and image
// attachments are passed through the image reader since several cards keep
// their tables in images.

// The boards use "mathematical monospace" letters (𝙸𝙽𝚃𝚁𝙾) for decoration; NFKC
// folds them back to plain text so names are readable and searchable.
function clean(text) {
  return String(text || '').normalize('NFKC').replace(/ㅤ|ᅟ|ᅠ/g, '').trim();
}

function isSeparatorCard(card) {
  return !clean(card.desc) && /^[-–—_=\s]*$/.test(clean(card.name));
}

function authParams() {
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  return key && token ? { key, token } : {};
}

async function downloadAttachment(att) {
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  const headers = key && token ? { Authorization: `OAuth oauth_consumer_key="${key}", oauth_token="${token}"` } : {};
  const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: 20000, headers });
  return Buffer.from(res.data);
}

async function fetchBoard(boardId) {
  const res = await axios.get(`https://api.trello.com/1/boards/${boardId}`, {
    timeout: 20000,
    params: {
      ...authParams(),
      fields: 'name,url,dateLastActivity',
      lists: 'open',
      list_fields: 'name,pos',
      cards: 'visible',
      card_fields: 'name,desc,idList,labels,shortUrl,pos',
      card_attachments: 'true',
      card_attachment_fields: 'id,name,mimeType,isUpload,url,bytes'
    }
  });
  const board = res.data;
  const boardName = clean(board.name);
  const lists = (board.lists || []).slice().sort((a, b) => a.pos - b.pos);

  const sections = [];
  for (const list of lists) {
    const cards = (board.cards || [])
      .filter(c => c.idList === list.id && !isSeparatorCard(c))
      .sort((a, b) => a.pos - b.pos);
    if (!cards.length) continue;

    const listName = clean(list.name);
    const cardTexts = [];
    for (const card of cards) {
      const name = clean(card.name) || '(untitled card)';
      const parts = [`#### ${name}`];
      const labels = (card.labels || []).map(l => clean(l.name)).filter(Boolean);
      if (labels.length) parts.push(`Labels: ${labels.join(', ')}`);
      if (clean(card.desc)) parts.push(clean(card.desc));

      for (const att of card.attachments || []) {
        if (!att.isUpload || !/^image\//.test(att.mimeType || '')) continue;
        try {
          const desc = await describeImage(await downloadAttachment(att), `${boardName} › ${listName} › ${name}`);
          if (desc) parts.push(desc);
        } catch (e) {
          console.warn(`AI trello: could not read image on card "${name}":`, e.message || e);
        }
      }
      if (parts.length > 1) cardTexts.push(parts.join('\n'));
    }
    if (cardTexts.length) sections.push(`### List: ${listName}\n\n${cardTexts.join('\n\n')}`);
  }

  return {
    key: `trello:${boardId}`,
    title: boardName,
    updated: board.dateLastActivity ? String(board.dateLastActivity).slice(0, 10) : null,
    url: board.url || `https://trello.com/b/${boardId}`,
    text: sections.join('\n\n')
  };
}

async function fetchTrelloBoards() {
  const results = [];
  for (const id of config.AI_TRELLO_BOARD_IDS_LIST) results.push(await fetchBoard(id));
  return results;
}

module.exports = { fetchTrelloBoards, clean };
