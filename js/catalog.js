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
    // The potential margin as a share of the highest buy order (js/money.js marginPct). null without either side,
    // so an item with no buy orders (no denominator) is never ranked, never as 0%.
    marginPct: (qt) => qt.marginPct,
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

  /**
   * The price filters, each named for the bound it sets on a quote (js/money.js quote()); a filter that is null or
   * missing is not set. All in whole numbers: prices and the margin in copper, quantities in units, and the margin
   * percentage in tenths of a percent (pctMin 105 is 10.5%), compared as margin * 1000 >= pctMin * buy so that no
   * rounding of a displayed percentage decides anything.
   *   buyMin, buyMax    the highest buy order, inclusive
   *   sellMin, sellMax  the lowest sell listing, inclusive
   *   marginMin         the potential margin after fees, at least
   *   pctMin            the potential margin as a share of the highest buy order, at least
   *   wantedMin         units wanted in ALL buy orders together, at least (the API's total, not depth near the best price)
   *   listedMin         units listed in ALL sell listings together, at least (the same)
   */
  const FILTER_KEYS = ['buyMin', 'buyMax', 'sellMin', 'sellMax', 'marginMin', 'pctMin', 'wantedMin', 'listedMin'];
  const setFilters = (f) => FILTER_KEYS.filter((k) => f && Number.isSafeInteger(f[k]));

  /** Whether one loaded quote passes every filter that is set. A side the item lacks fails any filter on it: it is never a price of 0. */
  function quotePasses(qt, f) {
    const has = (k) => Number.isSafeInteger(f[k]);
    if ((has('buyMin') || has('buyMax')) && qt.buy === null) return false;
    if (has('buyMin') && qt.buy < f.buyMin) return false;
    if (has('buyMax') && qt.buy > f.buyMax) return false;
    if ((has('sellMin') || has('sellMax')) && qt.sell === null) return false;
    if (has('sellMin') && qt.sell < f.sellMin) return false;
    if (has('sellMax') && qt.sell > f.sellMax) return false;
    if ((has('marginMin') || has('pctMin')) && qt.margin === null) return false;
    if (has('marginMin') && qt.margin < f.marginMin) return false;
    if (has('pctMin') && qt.margin * 1000 < f.pctMin * qt.buy) return false;
    if (has('wantedMin') && qt.buyQty < f.wantedMin) return false;
    if (has('listedMin') && qt.sellQty < f.listedMin) return false;
    return true;
  }

  /**
   * The indexes a search found, against the price filters: three answers, never two. priceOf(id) gives an item's
   * quote when its price is loaded, null when the API has answered that it has no price for it, and undefined when
   * no price is loaded (not asked for yet, on its way, or failed).
   * Returns { pass, unchecked, passed, failed, uncheckedCount, checked }: `pass` the indexes that pass, in the order
   * given; `unchecked` the ones with no price loaded, in the order given: they are not known to pass or to fail, and
   * are neither dropped nor counted as passing. An item the API has no price for fails. With no filter set, everything
   * passes and nothing is unchecked.
   */
  function priceFilter(cat, indexes, filters, priceOf) {
    const f = filters || {};
    if (!setFilters(f).length) return { pass: indexes.slice(), unchecked: [], passed: indexes.length, failed: 0, uncheckedCount: 0, checked: indexes.length };
    const pass = [], unchecked = [];
    let failed = 0;
    for (const i of indexes) {
      const qt = priceOf(cat.ids[i]);
      if (qt === undefined) unchecked.push(i);
      else if (qt !== null && quotePasses(qt, f)) pass.push(i);
      else failed++;
    }
    return { pass, unchecked, passed: pass.length, failed, uncheckedCount: unchecked.length, checked: pass.length + failed };
  }

  /** Item descriptions carry the game's markup ("<c=@flavor>...</c>", "<br>"): plain text, tags dropped. */
  function plainText(s) {
    return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  }

  const Catalog = { FORMAT, MAX_QUERY, MIN_QUERY, FILTER_KEYS, fold, parse, search, priceSort, setFilters, quotePasses, priceFilter, plainText };
  if (typeof module === 'object' && module.exports) module.exports = Catalog;
  else root.GW2Catalog = Catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this);
