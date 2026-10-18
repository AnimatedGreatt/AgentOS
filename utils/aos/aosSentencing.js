const fs = require('fs');
const path = require('path');

const SENTENCING_PATH = path.join(__dirname, '..', '..', 'data', 'aos-sentencing.json');

function loadSentencingPolicy() {
  try {
    const raw = fs.readFileSync(SENTENCING_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lawInfractionLevels: parsed && typeof parsed.lawInfractionLevels === 'object' ? parsed.lawInfractionLevels : {},
      infractionMinutes: parsed && typeof parsed.infractionMinutes === 'object' ? parsed.infractionMinutes : {}
    };
  } catch (err) {
    return { lawInfractionLevels: {}, infractionMinutes: {} };
  }
}

function normalizeLevel(level) {
  return String(level || '').trim().toLowerCase();
}

function normalizeLawCode(code) {
  return String(code || '').trim().toUpperCase();
}

function extractChargeCodes(chargesText) {
  const text = String(chargesText || '');
  const allCodes = [];

  // Supports both `2x [1.5A]` and `2x 1.5A`
  const multiplierPattern = /(\d+)\s*x\s*(?:\[\s*)?([0-9]+\.[0-9]+[A-Za-z]?)(?:\s*\])?/gi;
  const consumedRanges = [];

  let match;
  while ((match = multiplierPattern.exec(text)) !== null) {
    const qty = Math.max(0, Number(match[1]));
    const code = normalizeLawCode(match[2]);
    if (!code || !Number.isFinite(qty) || qty <= 0) continue;
    for (let i = 0; i < qty; i += 1) allCodes.push(code);
    consumedRanges.push([match.index, match.index + match[0].length]);
  }

  // Supports standalone law codes in both bracketed and plain forms.
  const standalonePattern = /\[\s*([0-9]+\.[0-9]+[A-Za-z]?)\s*\]|\b([0-9]+\.[0-9]+[A-Za-z]?)\b/gi;
  while ((match = standalonePattern.exec(text)) !== null) {
    const idx = match.index;
    const insideConsumed = consumedRanges.some(([start, end]) => idx >= start && idx < end);
    if (insideConsumed) continue;
    const code = normalizeLawCode(match[1] || match[2]);
    if (code) allCodes.push(code);
  }

  return allCodes;
}

function computeJailTimeFromCharges(chargesText) {
  const policy = loadSentencingPolicy();
  const lawMapRaw = policy.lawInfractionLevels || {};
  const lawMap = {};
  for (const [code, level] of Object.entries(lawMapRaw)) {
    lawMap[normalizeLawCode(code)] = normalizeLevel(level);
  }
  const levelMinutes = policy.infractionMinutes || {};

  const codes = extractChargeCodes(chargesText);
  const breakdown = {};
  const unknownCodes = new Set();
  let totalMinutes = 0;

  for (const code of codes) {
    breakdown[code] = (breakdown[code] || 0) + 1;

    const level = normalizeLevel(lawMap[normalizeLawCode(code)]);
    const minutesRaw = level ? levelMinutes[level] : undefined;
    const minutes = Number(minutesRaw);

    if (!level || !Number.isFinite(minutes) || minutes < 0) {
      unknownCodes.add(code);
      continue;
    }

    totalMinutes += minutes;
  }

  return {
    totalMinutes,
    codes,
    breakdown,
    unknownCodes: Array.from(unknownCodes)
  };
}

module.exports = {
  extractChargeCodes,
  computeJailTimeFromCharges,
  loadSentencingPolicy
};
