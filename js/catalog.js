// The Trading Post item list and its search. Pure, so the page and the Node tests share it. Loaded only when
// the Trading Post is opened, together with the list itself (data/tp-items.json, made by tools/build-items.mjs).
//
// The list holds every item with a Trading Post price when it was built: its id, name, type, rarity and level,
// and nothing that changes (prices are asked for live). parse() checks it as a whole and refuses a list that
// is not exactly what the tool writes, so a damaged download is never searched.
//
// Search is forgiving the way people type: case, accents, apostrophes and punctuation do not matter, and every
// word typed has to appear in the name ("ecto glob" finds Glob of Ectoplasm). Matches are ranked: the whole
// name, then names that start with what was typed, then names where every word typed starts a word, then the
// rest; within a rank by name. An item's id finds it too.
(function (root) {
  'use strict';

  const FORMAT = 1;
  const MAX_QUERY = 60;
  /** Typed text shorter than this searches only together with a filter: one letter matches most of the list. */
  const MIN_QUERY = 2;
  const MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
  const APOSTROPHES = new RegExp("['`\\u2018\\u2019]", 'g');
  const OTHER = new RegExp('[^\\p{L}\\p{N}]+', 'gu');

  /** Lower case, accents and apostrophes dropped, anything that is not a letter or a digit turned into a space. */
  function fold(text) {
    return String(text === null || text === undefined ? '' : text).slice(0, 200).normalize('NFD').replace(MARKS, '')
      .toLowerCase().replace(APOSTROPHES, '').replace(OTHER, ' ').trim();
  }

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const fail = (why) => ({ ok: false, error: why });
  const nameKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  /**
   * The list from the JSON the tool writes:
   *   { ok: true, catalog: { asOf, build, lang, count, types, rarities, ids, names, type, rarity, level, folded, pos, byId } }
   *   { ok: false, error }   anything else: wrong format, a count that does not match, ids out of order, a bad row
   * Rows are "<id minus the previous id>\t<name>\t<type>\t<rarity>\t<level>", one per line, in id order.
   */
  function parse(json) {
    let d = json;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { return fail('not JSON'); } }
    if (!isObj(d) || d.format !== FORMAT) return fail('not a list of this format');
    const { types, rarities } = d;
    if (!Array.isArray(types) || !types.length || !types.every((t) => typeof t === 'string' && t)) return fail('types');
    if (!Array.isArray(rarities) || !rarities.length || !rarities.every((t) => typeof t === 'string' && t)) return fail('rarities');
    if (typeof d.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(d.asOf)) return fail('asOf');
    if (!Number.isSafeInteger(d.count) || d.count < 1 || typeof d.rows !== 'string') return fail('count');
    const lines = d.rows.split('\n');
    if (lines.length !== d.count) return fail(`count ${d.count} but ${lines.length} rows`);
    const n = lines.length;
    const ids = new Array(n), names = new Array(n), type = new Uint8Array(n), rarity = new Uint8Array(n), level = new Uint16Array(n), folded = new Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const f = lines[i].split('\t');
      if (f.length !== 5) return fail(`row ${i + 1}`);
      const step = Number(f[0]), t = Number(f[2]), r = Number(f[3]), lv = Number(f[4]);
      if (!/^[1-9]\d*$/.test(f[0])) return fail(`row ${i + 1}: id`);
      const id = prev + step;
      if (!Number.isSafeInteger(id)) return fail(`row ${i + 1}: id`);
      if (!f[1] || f[1] !== f[1].trim()) return fail(`row ${i + 1}: name`);
      if (!/^\d+$/.test(f[2]) || t >= types.length || !/^\d+$/.test(f[3]) || r >= rarities.length) return fail(`row ${i + 1}: type or rarity`);
      if (!/^\d{1,3}$/.test(f[4]) || lv > 80) return fail(`row ${i + 1}: level`);
      ids[i] = id; names[i] = f[1]; type[i] = t; rarity[i] = r; level[i] = lv; folded[i] = fold(f[1]);
      prev = id;
    }
    // Name order: folded name, then the name as written, then id. Code-unit order, so it is the same everywhere.
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => nameKey(folded[a], folded[b]) || nameKey(names[a], names[b]) || ids[a] - ids[b]);
    const pos = new Int32Array(n);
    order.forEach((i, k) => { pos[i] = k; });
    const byId = new Map(ids.map((id, i) => [id, i]));
    return { ok: true, catalog: { asOf: d.asOf, build: d.build, lang: d.lang, count: n, types: types.slice(), rarities: rarities.slice(), ids, names, type, rarity, level, folded, pos, order, byId } };
  }

  /**
   * The items a search finds, as indexes into the list, best first:
   *   { status: 'idle' }    nothing typed and no filter: the page asks for a search
   *   { status: 'short' }   one letter and no filter
   *   { status: 'ok', query, indexes }   (indexes may be empty)
   * opts: query, type and rarity (an index into catalog.types / catalog.rarities, or -1 for any), only (a Set of
   * item ids, or null), and sort: 'relevance' (the default with a query) or 'name'.
   */
  function search(cat, opts) {
    const o = opts || {};
    const q = fold(String(o.query || '').slice(0, MAX_QUERY));
    const type = Number.isInteger(o.type) && o.type >= 0 ? o.type : -1;
    const rarity = Number.isInteger(o.rarity) && o.rarity >= 0 ? o.rarity : -1;
    const only = o.only instanceof Set ? o.only : null;
    const filtered = type >= 0 || rarity >= 0 || only !== null;
    if (!q && !filtered) return { status: 'idle', query: '', indexes: [] };
    if (q && q.length < MIN_QUERY && !filtered) return { status: 'short', query: q, indexes: [] };
    const words = q ? q.split(' ') : [];
    const idQuery = /^\d+$/.test(q) ? Number(q) : -1;
    const hits = [], rank = [];
    for (let i = 0; i < cat.count; i++) {
      if (type >= 0 && cat.type[i] !== type) continue;
      if (rarity >= 0 && cat.rarity[i] !== rarity) continue;
      if (only && !only.has(cat.ids[i])) continue;
      if (!words.length) { hits.push(i); rank.push(0); continue; }
      const name = cat.folded[i];
      if (cat.ids[i] === idQuery) { hits.push(i); rank.push(-1); continue; }
      let all = true;
      for (const w of words) if (name.indexOf(w) === -1) { all = false; break; }
      if (!all) continue;
      let r = 3;
      if (name === q) r = 0;
      else if (name.startsWith(q)) r = 1;
      else {
        const spaced = ' ' + name;
        if (words.every((w) => spaced.indexOf(' ' + w) !== -1)) r = 2;
      }
      hits.push(i); rank.push(r);
    }
    const byName = o.sort === 'name' || !words.length;
    const idx = hits.map((_, k) => k);
    idx.sort(byName ? (a, b) => cat.pos[hits[a]] - cat.pos[hits[b]] : (a, b) => rank[a] - rank[b] || cat.pos[hits[a]] - cat.pos[hits[b]]);
    return { status: 'ok', query: q, indexes: idx.map((k) => hits[k]) };
  }

  /** The sortable value of one item's quote for a price sort key, or null when that side is missing. */
  const KEYS = {
    buy: (qt) => qt.buy,
    sell: (qt) => qt.sell,
    spread: (qt) => qt.spread,
    margin: (qt) => qt.margin,
  };

  /**
   * A price sort of the indexes a search found. quoteOf(id) gives an item's quote (js/money.js) when its price
   * is loaded, else undefined. Returns { order, ranked, noSide, unpriced }: first the items with that value,
   * by value (dir 'desc' or 'asc'), ties by name; then the items whose price is loaded but lack that side
   * (no buy orders, or no sell listings), by name; then the items with no price loaded, by name. A missing
   * side is never sorted as a price of 0.
   */
  function priceSort(cat, indexes, key, dir, quoteOf) {
    const val = KEYS[key];
    if (!val) throw new Error(`unknown sort ${key}`);
    const ranked = [], noSide = [], unpriced = [];
    const v = new Map();
    for (const i of indexes) {
      const qt = quoteOf(cat.ids[i]);
      if (!qt) { unpriced.push(i); continue; }
      const x = val(qt);
      if (x === null || x === undefined) noSide.push(i); else { v.set(i, x); ranked.push(i); }
    }
    const sign = dir === 'asc' ? 1 : -1;
    ranked.sort((a, b) => sign * (v.get(a) - v.get(b)) || cat.pos[a] - cat.pos[b]);
    const byName = (a, b) => cat.pos[a] - cat.pos[b];
    noSide.sort(byName); unpriced.sort(byName);
    return { order: ranked.concat(noSide, unpriced), ranked: ranked.length, noSide: noSide.length, unpriced: unpriced.length };
  }

  /** Item descriptions carry the game's markup ("<c=@flavor>...</c>", "<br>"): plain text, tags dropped. */
  function plainText(s) {
    return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  }

  const Catalog = { FORMAT, MAX_QUERY, MIN_QUERY, fold, parse, search, priceSort, plainText };
  if (typeof module === 'object' && module.exports) module.exports = Catalog;
  else root.GW2Catalog = Catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this);
