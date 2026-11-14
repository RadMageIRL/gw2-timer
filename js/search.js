// Event search. Forgiving the way people type: case, accents, apostrophes and punctuation do not
// matter ("serpents ire" finds Serpents' Ire), a word typed in part matches ("teq" finds Tequatl the
// Sunless), and in a whole word of four letters or more one wrong, missing, extra or swapped letter is
// allowed ("shaterer" finds The Shatterer). Every word of the query has to match. Pure, so the page
// and the Node tests share it. Carried over from WoW Tracker.
//
// find() is what the page uses. A typed word that begins a word of any event is taken as typed, with
// no typo allowed, so a real word never also finds look-alikes: "mega" finds Megadestroyer and not
// every meta event, "cove" finds Southsun Cove and not every Core Tyria event.
(function (root) {
  'use strict';

  /** A query longer than this is cut: no event needs more, and the work stays bounded. */
  const MAX_QUERY = 60;
  const MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
  const APOSTROPHES = new RegExp("['`\\u2018\\u2019]", 'g');
  const KIND_WORDS = { 'world-boss': 'world boss', meta: 'meta event' };

  /** Lower case, accents and apostrophes dropped, any other punctuation turned into a space. */
  function normalize(text) {
    return String(text === null || text === undefined ? '' : text).slice(0, 400).normalize('NFD').replace(MARKS, '')
      .toLowerCase().replace(APOSTROPHES, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  const words = (text) => normalize(text).split(' ').filter(Boolean);

  /** Edit distance where swapping two neighbouring letters counts once (optimal string alignment). */
  function distance(a, b) {
    const d = [];
    for (let i = 0; i <= a.length; i++) d.push([i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }

  /**
   * One typed word against one whole word of the event, one typo allowed when both have four letters
   * or more. A typo is not looked for against the beginning of a longer word: that made "worm" find
   * every world boss (by "worl") and "meta" find Metrica Province.
   */
  function typoMatches(typed, word) {
    return typed.length >= 4 && word.length >= 4 && distance(typed, word) <= 1;
  }

  /** One typed word against one word of the event: a prefix, or the whole word with one typo. */
  function wordMatches(typed, word) {
    return word.startsWith(typed) || typoMatches(typed, word);
  }

  /** The words an event can be found by, from any number of texts (name, map, region, ...). */
  function index(texts) {
    const out = new Set();
    for (const t of texts) for (const w of words(t)) out.add(w);
    // Two words also match typed as one ("wizardstower" finds Wizard's Tower), and a whole name as one word.
    for (const t of texts) {
      const ws = words(t);
      for (let i = 1; i < ws.length; i++) out.add(ws[i - 1] + ws[i]);
      if (ws.length > 2) out.add(ws.join(''));
    }
    return [...out];
  }

  /** The index for one event of the dataset: its name, its map, its region (name and short name) and its kind. */
  function forEvent(event, region) {
    return index([event.name, event.map, region ? region.name : '', region ? region.short : '', KIND_WORDS[event.kind] || '']);
  }

  const queryWords = (query) => words(String(query === null || query === undefined ? '' : query).slice(0, MAX_QUERY));

  /** True when every word of the query matches a word in the index. An empty query matches all. */
  function matches(indexed, query) {
    const typed = queryWords(query);
    if (!typed.length) return true;
    const joined = typed.join('');
    if (typed.length > 1 && indexed.some((w) => wordMatches(joined, w))) return true;
    return typed.every((t) => indexed.some((w) => wordMatches(t, w)));
  }

  /**
   * The ids of the entries ({ id, index }) the query finds, in their order. As matches(), except that a
   * typed word that begins a word of any entry is matched only by beginnings: typos are looked for only
   * for a word that begins nothing. An empty query finds every entry.
   */
  function find(entries, query) {
    const list = Array.isArray(entries) ? entries : [];
    const typed = queryWords(query);
    if (!typed.length) return list.map((e) => e.id);
    const all = list.flatMap((e) => e.index);
    const real = (t) => all.some((w) => w.startsWith(t));
    const test = (t) => (real(t) ? (w) => w.startsWith(t) : (w) => typoMatches(t, w));
    const each = typed.map(test);
    const joined = typed.length > 1 ? test(typed.join('')) : null;
    return list.filter((e) => (joined && e.index.some(joined)) || each.every((m) => e.index.some(m))).map((e) => e.id);
  }

  const Search = { MAX_QUERY, normalize, words, distance, typoMatches, wordMatches, index, forEvent, matches, find };
  if (typeof module === 'object' && module.exports) module.exports = Search;
  else root.GW2Search = Search;
})(typeof globalThis !== 'undefined' ? globalThis : this);
