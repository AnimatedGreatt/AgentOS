const crypto = require('crypto');
const config = require('../../config');
const aiStore = require('./aiStore');
const { getClient } = require('./anthropicClient');

// Turns images embedded in the knowledge sources (Docs, Trello) into text so the
// assistant can use them. Descriptions are cached by image content hash, so an
// image is only sent to the model again when it actually changes.

const DECORATIVE = 'DECORATIVE';
const CAPTION_PREFIX = 'CAPTION:';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Bump when the prompt changes so cached descriptions are regenerated.
const PROMPT_VERSION = 'v2';

const memoryCache = new Map();

function detectMediaType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Returns text to embed in place of the image, or null when the image is
 * decorative, unsupported, or could not be read. Illustrations come back as a
 * one-line "[Illustration: …]"; informational images as a full transcription
 * wrapped in [Image content] markers.
 * @param {Buffer} buf - raw image bytes
 * @param {string} where - human-readable location, e.g. "Operational Guidelines › S1 | Structure"
 */
async function describeImage(buf, where) {
  const mediaType = detectMediaType(buf);
  if (!mediaType || buf.length > MAX_IMAGE_BYTES) return null;

  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const key = `img:${PROMPT_VERSION}:${hash}`;
  if (memoryCache.has(key)) return memoryCache.get(key);

  try {
    const cached = await aiStore.cacheGet(key);
    if (cached && typeof cached.text === 'string') {
      const value = format(cached.text);
      memoryCache.set(key, value);
      return value;
    }
  } catch (e) {
    console.warn('AI image cache read failed:', e.message || e);
  }

  const client = getClient();
  if (!client) return null;

  let text = null;
  try {
    const response = await client.messages.create({
      model: config.AI_MODEL,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } },
          {
            type: 'text',
            text: `This image is embedded in "${where}", part of a Roblox roleplay community's guidelines. Decide which kind of image it is and reply in that format only:\n\n` +
              `1. Decorative: a logo, banner, divider, emblem, or title art. Reply with exactly ${DECORATIVE}\n` +
              `2. Illustration: a game screenshot or picture used as an example or for atmosphere (a character in uniform, a location, a scene), where any readable text is incidental (name tags, signs) rather than a rule, table or list. Reply "${CAPTION_PREFIX} " followed by one short neutral sentence saying what it shows. Do not mention usernames or people's names.\n` +
              '3. Informational: a table, chart, rank structure, list of rules or values, or a diagram. Transcribe all text exactly (markdown tables for tables), then briefly note any information conveyed only visually (such as colour coding). No other commentary.'
          }
        ]
      }]
    });
    if (response.stop_reason === 'refusal') return null;
    text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (e) {
    console.warn(`AI image read failed for ${where}:`, e.message || e);
    return null;
  }

  if (!text) return null;
  if (text.replace(/[^A-Z]/g, '') === DECORATIVE) text = DECORATIVE;
  try {
    await aiStore.cacheSet(key, { text, where });
  } catch (e) {
    console.warn('AI image cache write failed:', e.message || e);
  }
  const value = format(text);
  memoryCache.set(key, value);
  return value;
}

function format(raw) {
  const text = String(raw || '').trim();
  if (!text || text === DECORATIVE) return null;
  if (text.startsWith(CAPTION_PREFIX)) {
    const caption = text.slice(CAPTION_PREFIX.length).trim().split('\n')[0];
    return caption ? `[Illustration: ${caption}]` : null;
  }
  return `[Image content]\n${text}\n[/Image content]`;
}

module.exports = { describeImage };
