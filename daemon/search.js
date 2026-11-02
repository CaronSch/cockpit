/**
 * Ranked search over conversations: a question in plain words ("in which session did we find
 * that Binance bundle exclusivity dropped…") finds the conversations that talk about it.
 *
 * Each conversation is indexed by its words (stemmed; title counted TITLE_WEIGHT times, so a
 * match in it ranks first) and kept as passages. A query is ranked with BM25: a word few
 * conversations use (Nova, exclusivity) counts far more than one most do (Binance, here), and
 * common English words are not words to search by at all. What a question asks is usually
 * said in one place, so a conversation counts for more the more of the query (by those
 * weights) one of its passages holds, and that passage is its snippet. The query's last word
 * may still be being typed, so it also matches words it begins. Conversations scoring well
 * below the best are left out: they share only the query's commonest words.
 */

/** Words that carry no meaning to search by. */
const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does done for from had has have how i if in into is it its ' +
    "it's me my no not of on or our so than that the their them then there these they this to too us was we were " +
    'what when where which while who why will with would you your about after again all also any because before ' +
    'between both each few find found more most other out over same should some such through under until up very ' +
    'session sessions conversation conversations'
  ).split(' '),
);

const TITLE_WEIGHT = 3;
const K1 = 1.2;
const B = 0.75;
/** A conversation is listed only if it scores at least this share of the best one. */
const MIN_SHARE = 0.25;
/** How much a passage holding all of the query lifts a conversation's score. */
const PASSAGE_BOOST = 2;
const SNIPPET_CHARS = 200;
const PASSAGE_CHARS = 400;

/**
 * A word with its commonest English endings taken off, so "dropped", "drops" and "drop" are
 * one word to search by (as are "bundles" and "bundle", "switched" and "switch"). A stem is
 * always the start of its word, so a page can find the words it came from.
 * @param {string} word
 */
export function stem(word) {
  if (word.length <= 3 || /\d/.test(word)) return word;
  let base = word.endsWith('ss') ? word : word.replace(/(?:ing|ed|s)$/, '');
  if (base.length < 3) return word;
  base = base.replace(/e$/, '');
  // "dropp(ed)" → "drop", but "fall" and "pass" keep theirs
  return base !== word && /([b-df-hj-km-rtv-z])\1$/.test(base) ? base.slice(0, -1) : base;
}

/** The words of `text` to search by: lowercased, two characters or more, not stopwords, stemmed. @param {string} text */
export const words = (text) => (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 1 && !STOPWORDS.has(w)).map(stem);

/**
 * A conversation's words, with how often each is used, and its passages with their words: the
 * title first, with no text, as it counts as a passage but is never the snippet (it is shown).
 * @typedef {{ terms: Map<string, number>, length: number, passages: { text: string | null, words: Set<string> }[] }} TextIndex
 */

/**
 * Indexes a conversation's text: its title, what names it (directory, id: searched, never a
 * snippet, as its row shows them), and what was said (prompts, replies).
 * @param {{ title: string, names?: string[], texts: string[] }} text @returns {TextIndex}
 */
export function indexText({ title, names = [], texts }) {
  /** @type {Map<string, number>} */
  const terms = new Map();
  let length = 0;
  /** @param {string} text @param {number} weight */
  const add = (text, weight) => {
    for (const w of words(text)) {
      terms.set(w, (terms.get(w) ?? 0) + weight);
      length += weight;
    }
  };
  add(title, TITLE_WEIGHT);
  for (const text of [...names, ...texts]) add(text, 1);
  const passages = [
    { text: null, words: new Set(words(title)) },
    ...texts
      .flatMap(passagesOf)
      .filter(Boolean)
      .map((text) => ({ text, words: new Set(words(text)) })),
  ];
  return { terms, length, passages };
}

/** A text as passages of at most PASSAGE_CHARS: its paragraphs, long ones cut at sentences. @param {string} text */
function passagesOf(text) {
  return text.split(/\n\s*\n|\n(?=[-*#>|] )/).flatMap((para) => {
    const flat = para.replace(/\s+/g, ' ').trim();
    if (flat.length <= PASSAGE_CHARS) return [flat];
    const out = [''];
    for (const sentence of flat.split(/(?<=[.!?])\s+/)) {
      if (out[out.length - 1].length + sentence.length > PASSAGE_CHARS) out.push('');
      out[out.length - 1] += `${out[out.length - 1] ? ' ' : ''}${sentence}`;
    }
    return out;
  });
}

/**
 * The query's words, each with the words of a conversation it matches: itself, and for the
 * last word while it may still be being typed, the words it begins.
 * @param {string} query @returns {{ word: string, prefix: boolean }[]}
 */
function queryWords(query) {
  const found = [...new Set(words(query))];
  const typing = !/\s$/.test(query);
  return found.map((word, i) => ({ word, prefix: typing && i === found.length - 1 }));
}

/**
 * Ranks `docs` for `query`, best first, leaving out those that score too little. Each comes
 * with its best passage (`snippet`) and the words of it that matched (`terms`).
 * @template {{ index: TextIndex }} D
 * @param {D[]} docs @param {string} query
 * @returns {{ doc: D, score: number, snippet: string, terms: string[] }[]}
 */
export function rank(docs, query) {
  const asked = queryWords(query);
  if (asked.length === 0 || docs.length === 0) return [];
  /** Whether query word `q` matches word `w`. @param {{ word: string, prefix: boolean }} q @param {string} w */
  const matches = (q, w) => (q.prefix ? w.startsWith(q.word) : w === q.word);
  /** The conversation's words that query word `q` matches. @param {TextIndex} index @param {{ word: string, prefix: boolean }} q */
  const matching = (index, q) => (q.prefix ? [...index.terms.keys()].filter((t) => matches(q, t)) : index.terms.has(q.word) ? [q.word] : []);
  const average = docs.reduce((sum, d) => sum + d.index.length, 0) / docs.length || 1;
  const idf = asked.map((q) => {
    const df = docs.filter((d) => matching(d.index, q).length > 0).length;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  });
  const weight = idf.reduce((sum, w) => sum + w, 0) || 1;

  const scored = docs.map((doc) => {
    const { index } = doc;
    let score = 0;
    /** @type {string[]} */
    const terms = [];
    asked.forEach((q, i) => {
      const hits = matching(index, q);
      if (hits.length === 0) return;
      terms.push(...hits);
      const tf = hits.reduce((sum, t) => sum + (index.terms.get(t) ?? 0), 0);
      score += (idf[i] * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * index.length) / average));
    });
    // The passage holding most of the query, by weight, lifts the score; the best one of text
    // is the snippet.
    let passage = '';
    let covered = 0;
    let shown = 0;
    if (score > 0) {
      for (const p of index.passages) {
        let held = 0;
        asked.forEach((q, i) => {
          if (q.prefix ? [...p.words].some((w) => matches(q, w)) : p.words.has(q.word)) held += idf[i];
        });
        covered = Math.max(covered, held);
        if (p.text !== null && held > shown) [passage, shown] = [p.text, held];
      }
    }
    return { doc, score: score * (1 + PASSAGE_BOOST * (covered / weight)), terms, passage };
  });
  const best = Math.max(...scored.map((s) => s.score));
  if (best <= 0) return [];
  return scored
    .filter((s) => s.score >= best * MIN_SHARE)
    .sort((a, b) => b.score - a.score)
    .map(({ doc, score, terms, passage }) => ({ doc, score, terms, snippet: snippet(passage, terms) }));
}

/**
 * `passage`, cut to SNIPPET_CHARS around the first of `terms` in it.
 * @param {string} passage @param {string[]} terms
 */
function snippet(passage, terms) {
  if (passage.length <= SNIPPET_CHARS) return passage;
  const lower = passage.toLowerCase();
  const found = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const first = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, Math.min(first - 40, passage.length - SNIPPET_CHARS));
  return `${start > 0 ? '…' : ''}${passage.slice(start, start + SNIPPET_CHARS).trim()}${start + SNIPPET_CHARS < passage.length ? '…' : ''}`;
}
