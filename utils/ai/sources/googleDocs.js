const axios = require('axios');
const { google } = require('googleapis');
const config = require('../../../config');
const { describeImage } = require('../imageReader');

// Reads the configured Google Docs (all tabs, including nested ones) through the
// Docs API and converts them to markdown-ish text. Images are passed through
// the image reader and inlined as text.

const HEADING_PREFIX = {
  TITLE: '# ',
  HEADING_1: '## ',
  HEADING_2: '### ',
  HEADING_3: '#### ',
  HEADING_4: '#### ',
  HEADING_5: '#### ',
  HEADING_6: '#### '
};

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: config.GOOGLE_SERVICE_ACCOUNT_JSON,
    keyFilename: config.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/documents.readonly']
  });
}

function flattenTabs(tabs, depth = 0, acc = []) {
  for (const tab of tabs || []) {
    acc.push({ tab, depth });
    flattenTabs(tab.childTabs, depth + 1, acc);
  }
  return acc;
}

async function downloadImage(uri, auth) {
  try {
    const res = await axios.get(uri, { responseType: 'arraybuffer', timeout: 20000 });
    return Buffer.from(res.data);
  } catch (e) {
    // Content URIs are usually public for a short time; retry with credentials.
    const token = await auth.getAccessToken();
    const res = await axios.get(uri, { responseType: 'arraybuffer', timeout: 20000, headers: { Authorization: `Bearer ${token}` } });
    return Buffer.from(res.data);
  }
}

function imageUri(documentTab, objectId) {
  const inline = documentTab.inlineObjects && documentTab.inlineObjects[objectId];
  const positioned = documentTab.positionedObjects && documentTab.positionedObjects[objectId];
  const props = inline ? inline.inlineObjectProperties : positioned ? positioned.positionedObjectProperties : null;
  return props && props.embeddedObject && props.embeddedObject.imageProperties
    ? props.embeddedObject.imageProperties.contentUri
    : null;
}

async function tabToText(tab, docTitle, auth) {
  const documentTab = tab.documentTab || {};
  const where = `${docTitle} › ${tab.tabProperties.title}`;
  const lines = [];

  const renderImage = async (objectId) => {
    const uri = imageUri(documentTab, objectId);
    if (!uri) return '';
    try {
      const desc = await describeImage(await downloadImage(uri, auth), where);
      return desc ? `\n${desc}\n` : '';
    } catch (e) {
      console.warn(`AI docs: could not read image in ${where}:`, e.message || e);
      return '';
    }
  };

  const paragraphText = async (paragraph) => {
    let text = '';
    for (const el of paragraph.elements || []) {
      if (el.textRun && el.textRun.content) text += el.textRun.content;
      else if (el.inlineObjectElement) text += await renderImage(el.inlineObjectElement.inlineObjectId);
    }
    for (const id of paragraph.positionedObjectIds || []) text += await renderImage(id);
    return text.replace(/\u000b/g, '\n').replace(/\s+$/, '');
  };

  const walk = async (elements) => {
    for (const el of elements || []) {
      if (el.paragraph) {
        const text = await paragraphText(el.paragraph);
        if (!text.trim()) { lines.push(''); continue; }
        const style = el.paragraph.paragraphStyle && el.paragraph.paragraphStyle.namedStyleType;
        if (el.paragraph.bullet) {
          const level = el.paragraph.bullet.nestingLevel || 0;
          lines.push(`${'  '.repeat(level)}- ${text.trim()}`);
        } else if (HEADING_PREFIX[style]) {
          lines.push('', `${HEADING_PREFIX[style]}${text.trim()}`);
        } else {
          lines.push(text);
        }
      } else if (el.table) {
        lines.push('');
        for (const row of el.table.tableRows || []) {
          const cells = [];
          for (const cell of row.tableCells || []) {
            const parts = [];
            for (const c of cell.content || []) {
              if (c.paragraph) {
                const t = (await paragraphText(c.paragraph)).trim();
                if (t) parts.push(t);
              }
            }
            cells.push(parts.join(' / ').replace(/\|/g, '\\|').replace(/\n+/g, ' '));
          }
          if (cells.some(c => c)) lines.push(`| ${cells.join(' | ')} |`);
        }
        lines.push('');
      }
    }
  };

  await walk(documentTab.body && documentTab.body.content);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @returns {Promise<Array<{ key, title, updated, text, url }>>}
 */
async function fetchGoogleDocs() {
  if (!config.GOOGLE_SERVICE_ACCOUNT_JSON && !config.GOOGLE_SERVICE_ACCOUNT_PATH) {
    throw new Error('Google service account is not configured');
  }
  const auth = getAuth();
  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth: new google.auth.GoogleAuth({
    credentials: config.GOOGLE_SERVICE_ACCOUNT_JSON,
    keyFilename: config.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.metadata.readonly']
  }) });

  const results = [];
  for (const id of config.AI_GOOGLE_DOC_IDS_LIST) {
    const res = await docs.documents.get({ documentId: id, includeTabsContent: true });
    const title = String(res.data.title || id).replace(/^\[OSI\]\s*/, '').trim();

    let updated = null;
    try {
      const meta = await drive.files.get({ fileId: id, fields: 'modifiedTime', supportsAllDrives: true });
      updated = meta.data.modifiedTime ? meta.data.modifiedTime.slice(0, 10) : null;
    } catch (e) {
      // modifiedTime is informational only
    }

    const sections = [];
    for (const { tab, depth } of flattenTabs(res.data.tabs)) {
      const body = await tabToText(tab, title, auth);
      if (!body) continue;
      sections.push(`${'#'.repeat(Math.min(depth + 2, 4))} Tab: ${tab.tabProperties.title}\n\n${body}`);
    }

    results.push({
      key: `doc:${id}`,
      title,
      updated,
      url: `https://docs.google.com/document/d/${id}`,
      text: sections.join('\n\n')
    });
  }
  return results;
}

module.exports = { fetchGoogleDocs };
