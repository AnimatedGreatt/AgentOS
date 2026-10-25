/**
 * Application spam detection.
 * Every written answer is checked on its own: it must be at least
 * `minAnswerChars` long and must not be repetitive junk ("aaaaa", "wordwordword").
 * Identity/short-answer fields (usernames, IDs, timezone, yes/no, ratings) are skipped.
 */

const DEFAULT_MIN_ANSWER_CHARS = 50;

// Questions whose answers are expected to be short. Kept narrow on purpose so
// written questions are never accidentally exempted.
const SHORT_ANSWER_QUESTION_PATTERNS = [
  /username/i,
  /user\s*id/i,
  /discord\s*id/i,
  /time\s*zone/i,
  /\bgmt\b/i,
  /how active/i,
  /are you pending/i
];

// A single letter repeated 5+ times in a row ("aaaaa", "nooooo").
const REPEATED_CHAR_RE = /([a-z])\1{4,}/;
// A chunk of 2-40 characters repeated 4+ times in a row ("wordwordwordword", "hahahaha").
const REPEATED_CHUNK_RE = /(.{2,40}?)\1{3,}/;

function isShortAnswerQuestion(question) {
  return SHORT_ANSWER_QUESTION_PATTERNS.some(re => re.test(String(question || '')));
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isRepetitiveSpam(answer) {
  const lower = answer.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');

  // Nothing but punctuation/symbols (e.g. ".", "..........", "?!?!").
  if (!compact) return true;

  // Letters only, so numbers like "100000000" don't count as repetition.
  const letters = compact.replace(/[^a-z]/g, '');
  if (REPEATED_CHAR_RE.test(letters)) return true;
  if (REPEATED_CHUNK_RE.test(letters)) return true;

  // Same few words over and over ("i want to join i want to join i want to join").
  const words = lower.split(/[^a-z0-9']+/).filter(Boolean);
  if (words.length >= 10 && new Set(words).size / words.length < 0.35) return true;

  return false;
}

/**
 * @returns {{ isSpam: boolean, reason: 'spam'|'too_short'|null, flagged: Array<{question: string, reason: string}> }}
 * `reason` is 'spam' if any answer is repetitive junk, otherwise 'too_short' if any answer is under the minimum.
 */
function analyzeSpamAnswers(answers, options) {
  const minAnswerChars = Number((options && options.minAnswerChars) || DEFAULT_MIN_ANSWER_CHARS);
  const flagged = [];

  for (const [question, rawAnswer] of Object.entries(answers || {})) {
    if (isShortAnswerQuestion(question)) continue;

    const answer = collapseWhitespace(rawAnswer);
    // A lone "." or "n/a"-style filler under the minimum reads as too short rather than spam.
    const shortFiller = answer.length < minAnswerChars && !/[a-z0-9]{2}/i.test(answer);
    if (!shortFiller && isRepetitiveSpam(answer)) {
      flagged.push({ question, reason: 'spam' });
    } else if (answer.length < minAnswerChars) {
      flagged.push({ question, reason: 'too_short' });
    }
  }

  let reason = null;
  if (flagged.some(f => f.reason === 'spam')) reason = 'spam';
  else if (flagged.length) reason = 'too_short';

  return { isSpam: reason !== null, reason, flagged };
}

function isSpamAnswers(answers, options) {
  return analyzeSpamAnswers(answers, options).isSpam;
}

module.exports = { isSpamAnswers, analyzeSpamAnswers, isShortAnswerQuestion };
