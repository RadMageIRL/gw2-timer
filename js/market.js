// The Trading Post mode: search the item list, see each item's highest buy order and lowest sell listing from
// ArenaNet's API, sort, compare, keep favorites, open an item's details. Loaded by app.js the first time the
// Trading Post is opened, after js/money.js, js/catalog.js and js/api.js; never with the timer.
//
// What it promises, and the code keeps:
// - Prices come only from the API, with the time this page received them. That is the only time known: ArenaNet's
//   answers carry none, so when ArenaNet last updated a price, an order book or a gem rate is never claimed (v0.5.0).
//   When the API does not answer, no price is shown and nothing is estimated; an older price stays, with its time
//   and its age in words.
// - A price sort says what it covers: every match, or only the matches whose prices are loaded. It is never
//   presented as a ranking of the whole market unless the whole market was loaded, which only the reader starts.
// - Proceeds and margins are estimates for one unit: the fees' rounding is not documented, and an order that is
//   placed has not filled.
// - Favorites are the only thing saved (gw2-timer:v1:tp-favorites, item ids). The search, filters and sort live
//   in memory, so a switch to the timer and back keeps them; prices are never saved.
// - With nothing typed, no filter and no price sort, it shows its home: the item list's types to browse, and Market
//   Watch, a fixed hand-picked set of items whose prices are asked for when the home is shown (two requests: their
//   prices and their item records). It is never called a ranking. The timer itself still asks the API for nothing.
(function (root) {
  'use strict';

  const LIST_URL = 'data/tp-items.json';
  const PAGE = 50;
  /** A price sort loads the price of every match up to this many (5 requests); past it the reader narrows the search or loads the whole market. */
  const SORT_CAP = 1000;
  /** Prices are current under 5 minutes after this page received them, stale up to an hour, then old (decision D3). */
  const CURRENT_MS = 5 * 60000;
  const OLD_MS = 60 * 60000;
  /**
   * How long ArenaNet lets an answer be reused, in minutes, by its Cache-Control header (public, max-age; checked on
   * the real API 2026-11-15 and 2026-11-18): prices 120 s, an order book 1,200 s. The browser's cache may answer a
   * request with a copy that old, so what the page received at a time can date from before it; the page says so and
   * does not ask past the cache (decision D5). The gem exchange sends no such header, so no reuse is claimed for it.
   */
  const REUSE_MIN = { prices: 2, book: 20 };
  /** A whole-market load can be started again once this long has passed since the last one began. */
  const WHOLE_GAP_MS = 5 * 60000;
  const FAV_KEY = 'tp-favorites';
  const FAV_MAX = 500;
  const ICON_PREFIX = 'https://render.guildwars2.com/file/';
  const TYPE_LABEL = {
    Armor: 'Armor', Back: 'Back item', Bag: 'Bag', Consumable: 'Consumable', Container: 'Container', CraftingMaterial: 'Crafting material',
    Gizmo: 'Gizmo', JadeTechModule: 'Jade Tech module', MiniPet: 'Miniature', PowerCore: 'Power core', Relic: 'Relic', Tool: 'Tool',
    Trinket: 'Trinket', Trophy: 'Trophy', UpgradeComponent: 'Upgrade component', Weapon: 'Weapon',
  };
  const typeLabel = (t) => TYPE_LABEL[t] || String(t).replace(/([a-z])([A-Z])/g, '$1 $2');

  /**
   * Market Watch on the Trading Post's home: a fixed set of familiar items used in crafting, chosen by hand (each had
   * a buy order and a sell listing on 2026-11-16). It is not a ranking, and the page never presents it as one: there
   * is no evidence of how much any item trades. Their prices are asked for when the home is shown, in one request
   * (and their icons in one more); an id the item list no longer has is left out.
   */
  const WATCH = [19976, 19721, 68063, 24277, 24295, 19701, 19725, 19746];
  const watchIds = (cat) => WATCH.filter((id) => cat.byId.has(id));
  /** The home shows this many favorites, newest first; Show all opens every one as results. */
  const FAV_HOME = 8;
  const favHome = (favs) => favs.slice(-FAV_HOME).reverse();
  /** Saved favorite ids the item list no longer has (well-formed ones only, once each): said, not silently dropped. */
  const lostFavorites = (raw, known) => (Array.isArray(raw) ? [...new Set(raw.filter((x) => Number.isSafeInteger(x) && x > 0 && !known.has(x)))].length : 0);

  /**
   * The gem exchange on the home: two quotes, one for each direction, each for a fixed amount the line names:
   * what 100 gold (1,000,000 copper) buys in gems, and what 400 gems sell for. ArenaNet's API quotes gems for an
   * amount of gold, and gold for an amount of gems; the rate depends on the amount, and each direction is its own
   * price. So the page says what each quote is and never turns one into the other.
   */
  const GEM_GOLD = 1000000, GEM_GEMS = 400;

  /** Line drawings for the item list's types (24 x 24, stroked), made for this page; any other type gets the box. */
  const TYPE_ICON = {
    Armor: 'M9 3.5L6 4.5L3.5 8.5L6 10V20.5H18V10L20.5 8.5L18 4.5L15 3.5 M9 3.5c.6 1.7 1.6 2.6 3 2.6s2.4-.9 3-2.6 M12 6.1V20.5 M6 14h12',
    Back: 'M8 4h8l1.5 2.5L19 20l-3.5-1.5L12 20l-3.5-1.5L5 20L6.5 6.5z M10 4c0 1.3.9 2.2 2 2.2s2-.9 2-2.2',
    Bag: 'M5.5 9h13l1 11.5h-15z M9 9V7.5a3 3 0 0 1 6 0V9 M9 13h6',
    Consumable: 'M9.5 3h5 M10.5 3v5.2L5.8 16.4a2.8 2.8 0 0 0 2.4 4.1h7.6a2.8 2.8 0 0 0 2.4-4.1L13.5 8.2V3 M7.6 14h8.8',
    Container: 'M4 11V8.5A3.5 3.5 0 0 1 7.5 5h9A3.5 3.5 0 0 1 20 8.5V11 M4 11h16v8.5H4z M10.5 11v3h3v-3',
    CraftingMaterial: 'M3 19.5L5.5 14h13L21 19.5z M7 14l2-4.5h6L17 14 M18.5 3.5v3 M17 5h3',
    Gizmo: 'M12 2.5v3 M12 18.5v3 M2.5 12h3 M18.5 12h3 M5.3 5.3l2.1 2.1 M16.6 16.6l2.1 2.1 M5.3 18.7l2.1-2.1 M16.6 7.4l2.1-2.1 M6 12a6 6 0 1 0 12 0a6 6 0 1 0-12 0 M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0',
    JadeTechModule: 'M7 7h10v10H7z M10 10h4v4h-4z M9.5 4v3 M14.5 4v3 M9.5 17v3 M14.5 17v3 M4 9.5h3 M4 14.5h3 M17 9.5h3 M17 14.5h3',
    MiniPet: 'M12 12.5c-2.8 0-5 3.2-5 5.3 0 1.6 1.3 2.2 2.4 2.2 1.1 0 1.6-.6 2.6-.6s1.5.6 2.6.6c1.1 0 2.4-.6 2.4-2.2 0-2.1-2.2-5.3-5-5.3z M5.5 10.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M8.5 7a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M12.5 7a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0 M15.5 10.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
    PowerCore: 'M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z M13 7.5l-3 4.8h4L11 17',
    Relic: 'M12 3l5.5 6.5L12 21L6.5 9.5z M6.5 9.5h11 M9.5 9.5L12 3l2.5 6.5',
    Tool: 'M4 9.5C6.5 6.3 9 5 12 5s5.5 1.3 8 4.5 M12 5v15.5 M10 20.5h4',
    Trinket: 'M6.5 14.5a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0 M9.5 6.5L12 3.5l2.5 3L12 9z',
    Trophy: 'M8 4h8v5a4 4 0 0 1-8 0z M8 5.5H5.5a2.5 2.5 0 0 0 2.6 4 M16 5.5h2.5a2.5 2.5 0 0 1-2.6 4 M12 13v4 M8.5 20.5h7 M9.5 20.5l.5-3.5h4l.5 3.5',
    UpgradeComponent: 'M12 3l8.5 9-8.5 9-8.5-9z M12 8v8 M9.5 10.5L12 8l2.5 2.5',
    Weapon: 'M20 4l-3.5.2-9 9 3.3 3.3 9-9z M5.8 12.6l5.6 5.6 M7.5 16.5l-3 3',
  };
  const BOX_ICON = 'M5 5h14v14H5z M5 9h14';

  /** The types on the home, as the Type list orders them (by label): { index, type, label, count, icon }. */
  function typeTiles(cat) {
    const n = new Array(cat.types.length).fill(0);
    for (let i = 0; i < cat.count; i++) n[cat.type[i]]++;
    return cat.types.map((type, index) => ({ index, type, label: typeLabel(type), count: n[index], icon: TYPE_ICON[type] || BOX_ICON }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  }

  /** What the results show, for the line beside "Trading Post home": the filters and what is typed, or every item. */
  function crumbText(s, cat) {
    const parts = [];
    if (s.type >= 0 && s.type < cat.types.length) parts.push(typeLabel(cat.types[s.type]));
    if (s.rarity >= 0 && s.rarity < cat.rarities.length) parts.push(cat.rarities[s.rarity]);
    if (s.favOnly) parts.push('Favorites');
    const q = String(s.query || '').trim();
    if (q) parts.push(`“${q}”`);
    // The price filters are named last; alone, they are filters over every item.
    if (s.pfCount > 0) { if (!parts.length) parts.push('Every item'); parts.push(`${s.pfCount} price ${s.pfCount === 1 ? 'filter' : 'filters'}`); }
    return parts.length ? parts.join(' · ') : 'Every item';
  }

  /**
   * The price filters as the page offers them (v0.5.0 Phase 2): each field's key (js/catalog.js FILTER_KEYS), how it
   * is typed, and what it bounds, in the words the page uses for it. The two quantity filters are on the totals the
   * API reports for every buy order and every sell listing together: queued units at any price, not what can be
   * bought or sold near the best price, and each is named so wherever it appears.
   */
  const PF_FIELDS = [
    { key: 'buyMin', kind: 'coins', what: 'highest buy order from' },
    { key: 'buyMax', kind: 'coins', what: 'highest buy order to' },
    { key: 'sellMin', kind: 'coins', what: 'lowest sell listing from' },
    { key: 'sellMax', kind: 'coins', what: 'lowest sell listing to' },
    { key: 'marginMin', kind: 'coins', what: 'potential margin at least' },
    { key: 'pctMin', kind: 'percent', what: 'potential margin % at least' },
    { key: 'wantedMin', kind: 'count', what: 'total queued units wanted, in all buy orders, at least' },
    { key: 'listedMin', kind: 'count', what: 'total queued units listed, in all sell listings, at least' },
  ];
  const PF_RANGES = [['buyMin', 'buyMax', 'Highest buy order'], ['sellMin', 'sellMax', 'Lowest sell listing']];
  const upFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  /**
   * What is typed in the price filters, read: { filters, errors, set, said }. raw: key -> text. filters: key -> a
   * whole number (copper, units, or tenths of a percent for pctMin) for every field that holds a readable value, in
   * the shape js/catalog.js priceFilter() takes. errors: [{ key, text }] for every field that could not be read, and
   * for a range whose from is above its to (both ends named): such a field is NOT applied, and the text says so; it
   * is never bent into something that can be. set: how many filters are applied. said: the applied filters in one
   * sentence, or ''. Money is js/money.js (its parseCoins, coins and count).
   */
  function readFilters(raw, Money) {
    const filters = {}, errors = [];
    for (const fd of PF_FIELDS) {
      const v = raw ? raw[fd.key] : '';
      const text = String(v === undefined || v === null ? '' : v).trim();
      if (!text) continue;
      const shown = text.length > 24 ? `${text.slice(0, 24)}...` : text;
      if (fd.kind === 'coins') {
        const r = Money.parseCoins(text);
        if (r.error) errors.push({ key: fd.key, text: `${upFirst(fd.what)}: “${shown}” ${r.error === 'too-large' ? 'is more than this page can work with' : 'is not a coin amount. Type one like 2g 50s 10c, 75s or 40c'}. It is not applied.` });
        else filters[fd.key] = r.copper;
      } else if (fd.kind === 'percent') {
        const m = /^(\d{1,6})(?:\.(\d))?\s*%?$/.exec(text);
        if (!m) errors.push({ key: fd.key, text: `${upFirst(fd.what)}: “${shown}” is not a percentage. Type a number like 10 or 12.5. It is not applied.` });
        else filters[fd.key] = Number(m[1]) * 10 + (m[2] === undefined ? 0 : Number(m[2]));
      } else {
        const m = /^(?:\d{1,3}(?:,\d{3})+|\d{1,12})$/.exec(text);
        if (!m) errors.push({ key: fd.key, text: `${upFirst(fd.what)}: “${shown}” is not a whole number of units. It is not applied.` });
        else filters[fd.key] = Number(text.replace(/,/g, ''));
      }
    }
    for (const [lo, hi, name] of PF_RANGES) {
      if (filters[lo] !== undefined && filters[hi] !== undefined && filters[lo] > filters[hi]) {
        errors.push({ key: lo, also: hi, text: `${name}: from ${Money.coins(filters[lo]).text} is above to ${Money.coins(filters[hi]).text}, so nothing could pass. Neither is applied.` });
        delete filters[lo]; delete filters[hi];
      }
    }
    const parts = PF_FIELDS.filter((fd) => filters[fd.key] !== undefined).map((fd) => `${fd.what} ${fd.kind === 'coins' ? Money.coins(filters[fd.key]).text : fd.kind === 'percent' ? `${(filters[fd.key] / 10).toFixed(1)}%` : Money.count(filters[fd.key])}`);
    return { filters, errors, set: parts.length, said: parts.length ? `Applied: ${parts.join('; ')}.` : '' };
  }

  const SORTS = {
    relevance: { label: 'Best match' },
    name: { label: 'Name, A to Z' },
    'buy-desc': { key: 'buy', dir: 'desc', what: 'highest buy order', how: 'high to low', none: 'no buy orders' },
    'buy-asc': { key: 'buy', dir: 'asc', what: 'highest buy order', how: 'low to high', none: 'no buy orders' },
    'sell-desc': { key: 'sell', dir: 'desc', what: 'lowest sell listing', how: 'high to low', none: 'no sell listings' },
    'sell-asc': { key: 'sell', dir: 'asc', what: 'lowest sell listing', how: 'low to high', none: 'no sell listings' },
    'spread-desc': { key: 'spread', dir: 'desc', what: 'spread', how: 'largest first', none: 'no buy orders or no sell listings' },
    'margin-desc': { key: 'margin', dir: 'desc', what: 'potential margin after fees', how: 'largest first', none: 'no buy orders or no sell listings' },
    // The potential margin as a share of the highest buy order (what buying one unit costs); an item with no buy orders
    // has no such share and comes after the ranked ones, never as 0%.
    'marginpct-desc': { key: 'marginPct', dir: 'desc', short: 'Potential margin %', what: 'potential margin as a share of the highest buy order', how: 'largest first', none: 'no buy orders or no sell listings' },
  };

  /** Saved favorites: whole item ids the list has, once each, at most FAV_MAX. Anything else is dropped. */
  function sanitizeFavorites(raw, known) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const x of raw) {
      if (out.length >= FAV_MAX) break;
      if (Number.isSafeInteger(x) && x > 0 && (!known || known.has(x)) && !out.includes(x)) out.push(x);
    }
    return out;
  }

  /** 'current', 'stale' or 'old' for a price, order book or rate this page received at `at` (local ms), seen at `now`. */
  const freshness = (at, now) => (now - at < CURRENT_MS ? 'current' : now - at < OLD_MS ? 'stale' : 'old');
  const ago = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'just now' : m === 1 ? '1 minute ago' : m < 120 ? `${m} minutes ago` : `${Math.floor(m / 60)} hours ago`; };
  const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

  /**
   * The long form of the freshness words, for item details (v0.5.0 Phase 3). kind: 'prices' or 'book'; when: the
   * time this page received the answer, as the reader's clock writes it; ms: how long ago; f: freshness(). That
   * time is the only one known: ArenaNet's answers carry none, so when ArenaNet last updated what they hold is said
   * to be unknown, and its reuse window (REUSE_MIN) says how what was received can date from before it.
   */
  function receivedText(kind, when, ms, f) {
    const book = kind === 'book', it = book ? 'it' : 'them';
    return `${book ? 'Order book' : 'Prices'} received at ${when}, ${ago(ms)} (${f}). That is when this page got ${it}; when ArenaNet last updated ${it} is not known: `
      + `the answer carries no time, and ArenaNet lets an answer be reused for up to ${REUSE_MIN[book ? 'book' : 'prices']} minutes, so ${book ? 'it' : 'they'} may date from before ${when}${book ? ' and be older than the prices above' : ''}.`;
  }

  /**
   * What a sort covers, in words. s: { sort, matches, ranked, noSide, unpriced, loading, failed, wholeAll,
   * listCount, filtered }. A price sort over only some matches says so; only a load of the whole market that
   * priced every match makes it "all", and only with no search and no filter is that the whole market.
   */
  function scopeText(s) {
    const sort = SORTS[s.sort];
    if (!sort || !sort.key) return s.sort === 'name' ? 'Sorted by name.' : 'Best matches first, then by name.';
    const head = `Ranked by ${sort.what}, ${sort.how}`;
    // With price filters set, the ranking is of the items that pass them (all of which have a loaded price); while
    // some matches are not checked yet it is the ranking of those that pass so far, and says so.
    if (s.pf) {
      return `${head}, among the ${plural(s.matches, 'item that passes', 'items that pass')} the price filters${s.pf.unchecked ? ' so far' : ''}. Not a ranking of the whole market.`
        + (s.noSide ? ` ${plural(s.noSide, 'item', 'items')} with ${sort.none} come after the ranked ones.` : '');
    }
    const all = s.unpriced === 0;
    const everything = all && !s.filtered && s.matches === s.listCount;
    let t;
    if (everything) t = `${head}, across the whole market: all ${plural(s.matches, 'item', 'items')} in the item list${s.wholeAll ? ', from the whole-market load' : ''}.`;
    else if (all) t = `${head}, among all ${plural(s.matches, 'matching item', 'matching items')}. Not a ranking of the whole market.`;
    else {
      const have = s.ranked + s.noSide;
      t = `${head}, among only the ${have.toLocaleString('en-US')} of ${plural(s.matches, 'matching item', 'matching items')} whose prices are loaded. Not a ranking of every match, or of the whole market.`;
      if (s.loading) t += ' Loading the other prices...';
      else if (s.matches > SORT_CAP) t += ` To rank every match, narrow the search to ${SORT_CAP.toLocaleString('en-US')} items or fewer, or load the whole market.`;
      else if (s.failed) t += ' The other prices could not be loaded.';
    }
    if (s.noSide) t += ` ${plural(s.noSide, 'item', 'items')} with ${sort.none} come after the ranked ones.`;
    return t;
  }

  /**
   * What the price filters cover, in words: three counts, never two. s: { matches, passed, failed, unchecked,
   * loading, failedLoad, listCount, filtered, wholeAll }. Items whose price is not loaded are "not checked": they
   * are not known to pass or to fail, and the line never lets them stand as either. Only when every match was
   * checked does it say "all", and only with no search and no other filter is that the whole item list.
   */
  function filterText(s) {
    if (!s.matches) return '';
    const n = (x) => x.toLocaleString('en-US');
    if (s.unchecked === 0) {
      if (!s.filtered && s.matches === s.listCount) return `Price filters: ${n(s.passed)} of all ${plural(s.matches, 'item', 'items')} in the item list ${s.passed === 1 ? 'passes' : 'pass'}${s.wholeAll ? ', from the whole-market load' : ''}; ${n(s.failed)} ${s.failed === 1 ? 'does' : 'do'} not.`;
      return `Price filters: ${n(s.passed)} of all ${plural(s.matches, 'matching item', 'matching items')} ${s.passed === 1 ? 'passes' : 'pass'}; ${n(s.failed)} ${s.failed === 1 ? 'does' : 'do'} not. Every match was checked. Not a filter of the whole market.`;
    }
    let t = `Price filters: ${n(s.passed)} ${s.passed === 1 ? 'passes' : 'pass'} and ${n(s.failed)} ${s.failed === 1 ? 'does' : 'do'} not, among only the ${n(s.passed + s.failed)} of ${plural(s.matches, 'matching item', 'matching items')} whose prices are loaded. `
      + `The other ${n(s.unchecked)} ${s.unchecked === 1 ? 'is' : 'are'} not checked: listed after the ones that pass, and not known to pass or to fail.`;
    if (s.loading) t += ' Loading their prices...';
    else if (s.matches > SORT_CAP) t += ` To check every match, narrow the search to ${SORT_CAP.toLocaleString('en-US')} items or fewer, or load the whole market.`;
    else if (s.failedLoad) t += ' Their prices could not be loaded.';
    return t;
  }

  /** A sentence for prices that are no longer current, by the oldest one used (received at `oldest`); '' while all are current or none is used. */
  function ageNote(oldest, now) {
    if (!Number.isFinite(oldest)) return '';
    const f = freshness(oldest, now);
    return f === 'current' ? '' : ` The oldest price used was received ${ago(now - oldest)}: ${f}, and may have changed.`;
  }

  /** The quantity calculator's ready amounts; any other whole number up to one transaction's 250 can be typed. */
  const CALC_CHIPS = [1, 5, 10, 50, 100];
  /** The order book's tables show this many price levels a side, or as many as the amount reaches, up to BOOK_MOST. */
  const BOOK_ROWS = 5, BOOK_MOST = 12;
  /**
   * The amount the calculator works with: what is typed, or with nothing typed the chosen ready amount.
   * { n } for a whole number from 1 to `max`; { error: 'not-whole' } for anything that is not plain digits (a
   * fraction, a sign, letters, an exponent); { error: 'range' } for 0 or more than `max`. Never a guess.
   */
  function readAmount(text, chip, max) {
    const t = String(text === undefined || text === null ? '' : text).trim();
    if (!t) return { n: chip };
    if (!/^\d{1,9}$/.test(t)) return { error: 'not-whole' };
    const n = Number(t);
    return n >= 1 && n <= max ? { n } : { error: 'range' };
  }

  const API_SAYS = {
    'rate-limited': "ArenaNet's API asked for fewer requests (HTTP 429)",
    network: "ArenaNet's API could not be reached",
    timeout: "ArenaNet's API did not answer in time",
    server: "ArenaNet's API had an error",
    http: "ArenaNet's API refused the request",
    'bad-data': "ArenaNet's API sent something this page cannot read",
  };

  /**
   * What the Trading Post says when its item list does not load, and whether it offers Try again. error: 'network'
   * (no answer), 'HTTP <status>', or why the answer could not be read; protocol: the page's (location.protocol);
   * canonical: the site's address. On a page opened as a file (any address that is not http or https), no answer
   * for its own data means the browser refused the request, not that the connection failed (Chrome, Edge and WebKit
   * refuse it; Firefox allows it), so the reader is told what does work, and offered no retry that cannot.
   */
  function listFailure(error, protocol, canonical) {
    if (error === 'network' && !/^https?:$/.test(String(protocol))) {
      return { retry: false, text: `The Trading Post needs this site to be served over HTTP or HTTPS. This copy was opened as a file, and this browser does not let a page opened that way request its own data, such as the item list. Open ${canonical ? `${canonical}#market` : 'the site from its web address'} instead, or serve this folder with a local web server. The timer is not affected.` };
    }
    return { retry: true, text: error === 'network' || /^HTTP/.test(error)
          ? 'The item list could not be loaded. Check your connection and try again. The timer is not affected.'
          : 'The item list that arrived could not be read, so nothing is searched. Try again later. The timer is not affected.' };
  }

  function mount(ctx) {
    const Money = root.GW2Money, Catalog = root.GW2Catalog, Api = root.GW2Api;
    const { h, storage, Store, now, copyText, canonical, version } = ctx;
    const $ = (id) => document.getElementById(id);
    const view = $('market-view'), dialog = $('tp-item-dialog');
    // A 429 holds the queue: redraw, so the waiting rows and the price line say why they wait.
    const client = Api.createClient({ fetch: (u, i) => window.fetch(u, i), onRetry: (x) => { if (x.error === 'rate-limited') drawSoon(); } });
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

    let cat = null, listState = 'idle';
    const st = { query: '', type: -1, rarity: -1, sort: 'relevance', favOnly: false, shown: PAGE };
    // The price filters: what is typed in each field (st.pf, in memory like every other filter: never saved, never in
    // the address), and what that reads as (pf: js/market.js readFilters). fcounts: how the matches stand against
    // them (js/catalog.js priceFilter), or null with none set. uncheckedSet: the matches not checked, for their rows.
    const pfRaw = {};
    let pf = readFilters(pfRaw, Money), fcounts = null, uncheckedSet = new Set(), oldestUsed = NaN;
    let matches = [], order = [], counts = null, searchStatus = 'idle';
    const cache = new Map();     // id -> { at, q (Money.quote) } or { at, none: true }: prices, this tab only
    const items = new Map();     // id -> item record (icon, description, vendor value, chat code, flags)
    // A price is one of: loaded (cache q, current, stale or old), confirmed absent (cache none: the API answered
    // that it has no price), on its way (pending; "waiting" while a 429 holds the queue), failed (failed: id ->
    // the API error, kept beside an older price if there is one), or not requested yet (none of these).
    const pending = new Map(), itemPending = new Map(), failed = new Map();
    // pending and itemPending: id -> the signal of the request that holds it. An id is on its way only while that
    // request is not cancelled: a search or sort that cancels the requests before it asks again at once, so the ids
    // those requests held must count as free then, not only when their cancelled answer comes back (after the new
    // request was made, which left them never asked for). A request lets go only of the ids it still holds.
    const live = (m, id) => { const s = m.get(id); return Boolean(s) && !s.aborted; };
    const hold = (m, ids, signal) => { const own = signal || { aborted: false }; for (const id of ids) m.set(id, own); return own; };
    const release = (m, ids, own) => { for (const id of ids) if (m.get(id) === own) m.delete(id); };
    let lastError = null, viewCtl = null, sortCtl = null, wholeCtl = null, detailCtl = null;
    const whole = { state: 'idle', done: 0, total: 0, answered: 0, failedReq: 0, started: 0, ended: 0, all: false };
    let favs = [], favUnsaved = !storage, favLost = 0;
    // The gem exchange's two quotes (api.js exchange()), each with its own state, as a price has.
    const gem = { coins: null, gems: null }, gemPending = { coins: false, gems: false }, gemFailed = { coins: null, gems: null };
    let gemCtl = null;
    let detailId = null, opener = null, closingByHash = false, pendingRoute = '';
    let book = null, bookCtl = null;
    // The quantity calculator's choices: the ready amount, what is typed in its place, and how the units are got and
    // given. Kept here, not in the page, so no redraw can lose them; never saved, never in the address.
    const calc = { chip: 1, text: '', get: 'now', give: 'now' };
    // The details' own nodes: `main` is redrawn whole; `book` (the order book and the calculator) is kept and updated
    // in place, so its field keeps what is typed, its caret and its focus while prices arrive and the clock ticks.
    let detailEls = null;

    // ---- The item list ----

    function setBoot(text, retry) {
      $('tp-boot').hidden = !text;
      $('tp-boot').textContent = text || '';
      $('tp-retry').hidden = !retry;
    }
    async function loadList() {
      if (listState === 'loading' || listState === 'ready') return;
      listState = 'loading';
      setBoot('Loading the Trading Post item list (about 150 KB)...', false);
      let r = null;
      try {
        const res = await window.fetch(LIST_URL + (version || ''), { credentials: 'same-origin' });
        r = res.ok ? Catalog.parse(await res.text()) : { ok: false, error: `HTTP ${res.status}` };
      } catch (e) { r = { ok: false, error: 'network' }; }
      if (!r.ok) {
        listState = 'failed';
        const f = listFailure(r.error, location.protocol, canonical);
        setBoot(f.text, f.retry);
        return;
      }
      cat = r.catalog;
      listState = 'ready';
      favs = sanitizeFavorites(Store.read(storage, FAV_KEY), cat.byId);
      favLost = lostFavorites(Store.read(storage, FAV_KEY), cat.byId);
      $('tp-type').replaceChildren(h('option', { value: '-1', text: 'Any type' }), ...cat.types.map((t, i) => [t, i]).sort((a, b) => (typeLabel(a[0]) < typeLabel(b[0]) ? -1 : 1)).map(([t, i]) => h('option', { value: String(i), text: typeLabel(t) })));
      $('tp-rarity').replaceChildren(h('option', { value: '-1', text: 'Any rarity' }), ...cat.rarities.map((t, i) => h('option', { value: String(i), text: t })));
      $('tp-asof').textContent = `Item list as of ${day.format(Date.parse(cat.asOf))}: ${cat.count.toLocaleString('en-US')} items with a Trading Post price then. Items added to the game since then cannot be found until the list is updated.`;
      const tiles = typeTiles(cat);
      $('tp-cats-hint').textContent = `the item list's ${tiles.length} types`;
      $('tp-cat-grid').replaceChildren(...tiles.map((t) => h('li', {},
        h('button', { type: 'button', class: 'tp-cat', 'data-tp-cat': t.index, 'data-tpkey': `cat:${t.index}` }, glyph(t.icon),
          h('span', { class: 'tp-cat-name', text: t.label }), h('span', { class: 'tp-cat-count', text: plural(t.count, 'item', 'items') })))));
      setBoot('', false);
      $('tp-app').hidden = false;
      syncControls();
      apply(true);
      if (pendingRoute) { const p = pendingRoute; pendingRoute = ''; route(p); }
    }

    // ---- Search, filters and sort ----

    const filtered = () => st.type >= 0 || st.rarity >= 0 || st.favOnly;
    const quoteOf = (id) => { const c = cache.get(id); return c && c.q ? c.q : undefined; };
    /** For the price filters: an item's quote; null when the API has answered that it has no price for it; undefined when no price is loaded. */
    const priceOf = (id) => { const c = cache.get(id); return !c ? undefined : c.q ? c.q : null; };
    const sortDef = () => SORTS[st.sort];
    /** A price sort or a price filter is at work: both need every match's price, and both say what they cover. */
    const priceWork = () => { const s = sortDef(); return Boolean(s && s.key) || pf.set > 0; };

    /**
     * Recomputes what matches and its order; with `fetch`, asks for the prices and icons that are needed. `keep`
     * leaves the requests already on their way alone (a price filter being typed changes no search, so it cancels
     * nothing and asks only for what is not here).
     */
    function apply(fetch, keep) {
      if (!cat) return;
      const r = Catalog.search(cat, { query: st.query, type: st.type, rarity: st.rarity, only: st.favOnly ? new Set(favs) : null, sort: st.sort === 'name' ? 'name' : 'relevance' });
      // A price sort or a price filter with nothing typed and no other filter works on the whole list: across the
      // whole market once every price is loaded, otherwise among the loaded ones, and the lines under it say which.
      if (r.status === 'idle' && priceWork()) { searchStatus = 'ok'; matches = cat.order.slice(); }
      else { searchStatus = r.status; matches = r.indexes; }
      resort();
      draw();
      if (fetch) fetchNeeded(!keep);
    }
    /**
     * The order shown: the matches that pass the price filters (all of them with none set), ranked by the price sort
     * if there is one, then the matches the filters could not check, by name. A match that fails is not shown, and is
     * counted. Nothing unchecked is ever placed among the ones that pass.
     */
    function resort() {
      const s = sortDef();
      let base = matches;
      fcounts = null; uncheckedSet = new Set();
      if (pf.set > 0) { fcounts = Catalog.priceFilter(cat, matches, pf.filters, priceOf); base = fcounts.pass; uncheckedSet = new Set(fcounts.unchecked); }
      if (s && s.key) { const p = Catalog.priceSort(cat, base, s.key, s.dir, quoteOf); order = p.order; counts = p; }
      else { order = base; counts = null; }
      if (fcounts && fcounts.unchecked.length) order = order.concat(fcounts.unchecked);
      // The oldest price the sort or the filters used, so the lines can say when it is no longer current.
      oldestUsed = NaN;
      if (priceWork()) { let o = Infinity; for (const i of matches) { const c = cache.get(cat.ids[i]); if (c && c.q && c.at < o) o = c.at; } oldestUsed = o; }
    }
    const visibleIds = () => order.slice(0, st.shown).map((i) => cat.ids[i]);

    /**
     * Prices and icons for what is shown, and for a price sort or price filter every match up to SORT_CAP. `force`
     * asks again for the shown prices even when they are current (Refresh).
     */
    function fetchNeeded(restart, force) {
      if (!cat) return;
      if (restart && viewCtl) viewCtl.abort();
      if (restart || !viewCtl || viewCtl.signal.aborted) viewCtl = new AbortController();
      if (restart && sortCtl) { sortCtl.abort(); sortCtl = null; }
      const ids = visibleIds(), t = now();
      // Newly loaded prices join the ranking and the filters at once, so what is shown is always what the lines say.
      const redo = () => { if (priceWork()) resort(); draw(); };
      // A price sort or a price filter uses every match's price. With at most SORT_CAP matches they are all asked for
      // in ONE call, so at most 5 requests of 200 for a search, the shown rows and the ones a Refresh forces among
      // them. A price that is no longer current is asked for again too: nothing is ranked or filtered on a stale
      // price that could have been refreshed. Over SORT_CAP nothing beyond the shown rows is asked for: never a scan
      // of the market the reader did not start.
      if (priceWork() && matches.length <= SORT_CAP) {
        const all = matches.map((i) => cat.ids[i]);
        if (force || all.some((id) => { const c = cache.get(id); return (!c || t - c.at >= CURRENT_MS) && !failed.has(id); })) {
          if (!sortCtl) sortCtl = new AbortController();
          const sig = sortCtl.signal;
          loadPrices(all, sig, undefined, force ? new Set(ids) : false).then(() => { if (sig.aborted) return; redo(); loadItems(visibleIds(), viewCtl.signal); });
        }
      }
      loadPrices(ids, viewCtl.signal, undefined, force).then(redo);
      loadItems(ids, viewCtl.signal);
      if (searchStatus === 'idle') loadWatch(force);
    }

    /**
     * The home's prices and icons, while it is on screen: Market Watch's and the favorites shown there, together in
     * one request for the prices that are not current (none when all are) and one for the item records not yet here;
     * then the gem exchange's two quotes when they are not current. Its requests are not cancelled by a search, which
     * may show the same items: their answer serves both. Refresh (`force`) asks again for current prices too.
     */
    let watchCtl = null;
    const homeIds = () => [...new Set([...watchIds(cat), ...favHome(favs)])];
    function loadWatch(force) {
      if (!cat || searchStatus !== 'idle' || view.hidden) return;
      const ids = homeIds();
      if (!watchCtl || watchCtl.signal.aborted) watchCtl = new AbortController();
      loadPrices(ids, watchCtl.signal, undefined, force).then((r) => { if (!r) return; if (priceWork()) resort(); draw(); });
      loadItems(ids, watchCtl.signal);
      loadGems(false);
    }

    /** The gem exchange's two quotes, each asked for when it is not current (or always, with `force`). */
    async function loadGems(force) {
      const t = now(), ks = ['coins', 'gems'].filter((k) => !gemPending[k] && (force || !gem[k] || t - gem[k].at >= CURRENT_MS));
      if (!ks.length) return;
      if (!gemCtl || gemCtl.signal.aborted) gemCtl = new AbortController();
      for (const k of ks) gemPending[k] = true;
      drawSoon();
      await Promise.all(ks.map(async (k) => {
        const r = await client.exchange(k, k === 'coins' ? GEM_GOLD : GEM_GEMS, { signal: gemCtl.signal });
        gemPending[k] = false;
        if (r.ok) { gem[k] = r.quote; gemFailed[k] = null; } else if (r.error !== 'aborted') gemFailed[k] = r.error;
      }));
      draw();
    }

    // A price keeps the time this page received it until a new one replaces it: a forced refresh never touches it, so
    // the page can always say how long ago it received what it shows.
    async function loadPrices(ids, signal, onBatch, force) {
      const t = now();
      // force: true for every id, or a Set of the ids to ask for again even when their price is current.
      const again = (id) => force === true || Boolean(force && force.has && force.has(id));
      const need = ids.filter((id) => { const c = cache.get(id); return (again(id) || !c || t - c.at >= CURRENT_MS) && !live(pending, id); });
      if (!need.length) return null;
      const own = hold(pending, need, signal);
      drawSoon();
      const r = await client.prices(need, { signal, onBatch });
      release(pending, need, own);
      for (const [id, row] of r.rows) { cache.set(id, { at: row.at, q: Money.quote(row) }); failed.delete(id); }
      for (const id of r.missing) { cache.set(id, { at: now(), none: true }); failed.delete(id); }
      noteFailures(r);
      if (!failed.size) lastError = null;
      return r;
    }
    /** Each failed id keeps its own error (a cancelled request is not a failure). */
    function noteFailures(r) {
      if (!r.error || r.error === 'aborted') return;
      lastError = { error: r.error, at: now() };
      for (const id of r.failed) { const why = r.errors.get(id) || r.error; if (why !== 'aborted') failed.set(id, why); }
    }
    async function loadItems(ids, signal) {
      const need = ids.filter((id) => !items.has(id) && !live(itemPending, id));
      if (!need.length) return;
      const own = hold(itemPending, need, signal);
      const r = await client.items(need, { signal });
      release(itemPending, need, own);
      for (const [id, row] of r.rows) items.set(id, row);
      draw();
    }

    // ---- Drawing ----

    function coins(copper, cls) {
      const c = Money.coins(copper);
      return h('span', { class: `coins${c.neg ? ' neg' : ''}${cls ? ' ' + cls : ''}` },
        h('span', { 'aria-hidden': 'true' }, ...c.text.split(' ').map((p, k) => h('span', { class: `coin coin-${p.slice(-1)}`, text: (k ? ' ' : '') + p }))),
        h('span', { class: 'sr-only', text: c.spoken }));
    }
    const qty = (n, word) => h('span', { class: 'tp-q', text: `${Money.count(n)} ${word}` });
    /** A type's line drawing (TYPE_ICON), hidden from screen readers: the label beside it says the type. */
    function glyph(d) {
      const NS = 'http://www.w3.org/2000/svg', s = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path');
      for (const [k, v] of [['viewBox', '0 0 24 24'], ['width', '28'], ['height', '28'], ['class', 'tp-cat-ic'], ['aria-hidden', 'true'], ['focusable', 'false']]) s.setAttribute(k, v);
      p.setAttribute('d', d);
      s.append(p);
      return s;
    }
    /** An item's icon from the API's item record, only from ArenaNet's render host; none until the record is here. */
    const iconOf = (it, size, cls) => (it && typeof it.icon === 'string' && it.icon.startsWith(ICON_PREFIX)
      ? h('img', { class: cls, src: it.icon, alt: '', width: size, height: size, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }) : null);

    /** One price cell: the value, or why there is none. */
    function cell(id, cls, label, short, fill) {
      const c = cache.get(id), wrap = (...kids) => h('span', { class: `tp-cell ${cls}` }, h('span', { class: 'sr-only', text: `${label}: ` }), h('span', { class: 'tp-k', 'aria-hidden': 'true', text: short }), ...kids);
      if (c && c.q) { const v = fill(c.q); return wrap(...v); }
      if (c && c.none) return wrap(h('span', { class: 'tp-none', text: 'not on the Trading Post now' }));
      if (pending.has(id)) return wrap(h('span', { class: 'tp-none', text: client.paused() ? 'waiting' : 'loading...' }));
      if (failed.has(id)) return wrap(h('span', { class: 'tp-none', text: 'not loaded' }));
      return wrap(h('span', { class: 'tp-none', text: 'not requested yet' }));
    }

    /** A row's own note, under its name: why its price is missing or waiting, or how old a stale or old one is. */
    function rowNote(id, t) {
      const c = cache.get(id), why = failed.get(id);
      if (c && c.q) {
        const f = freshness(c.at, t), again = why ? ` A newer price could not be loaded: ${API_SAYS[why] || API_SAYS.network}.` : '';
        return { age: f, text: f === 'current' ? (why ? again.trim() : '') : `${f === 'stale' ? 'Stale' : 'Old'} price, received ${ago(t - c.at)}.${again}` };
      }
      if (c && c.none) return { age: '', text: '' };
      if (pending.has(id)) return { age: '', text: client.paused() ? "Waiting: ArenaNet's API asked for fewer requests (HTTP 429)." : '' };
      if (why) return { age: '', text: `No price: ${API_SAYS[why] || API_SAYS.network}.` };
      return { age: '', text: '' };
    }
    /** A result row's note: its price note, and first of all that the price filters could not check it, with why its price is not here. */
    function resultNote(i, id, t) {
      const note = rowNote(id, t);
      if (uncheckedSet.has(i)) note.text = `Not checked against the price filters: ${pending.has(id) ? 'its price is on its way' : failed.has(id) ? 'its price could not be loaded' : 'its price is not loaded'}.${note.text ? ` ${note.text}` : ''}`;
      return note;
    }
    const rowClass = (rar, age, base) => `${base || 'tp-row'} rarity-${rar.toLowerCase()}${age === 'stale' ? ' is-stale' : age === 'old' ? ' is-old' : ''}`;

    function row(i) {
      const id = cat.ids[i], name = cat.names[i], rar = cat.rarities[cat.rarity[i]], it = items.get(id);
      const on = favs.includes(id), lv = cat.level[i];
      const note = resultNote(i, id, now()), unchecked = uncheckedSet.has(i);
      return h('li', { class: rowClass(rar, note.age) + (unchecked ? ' is-unchecked' : ''), 'data-id': id, 'data-pf': pf.set > 0 ? (unchecked ? 'unchecked' : 'pass') : null },
        h('span', { class: 'tp-icon', 'aria-hidden': 'true' }, iconOf(it, 32)),
        h('span', { class: 'tp-item' },
          h('a', { class: 'tp-name', href: `#market/item/${id}`, 'aria-haspopup': 'dialog', 'data-tpkey': `name:${id}`, text: name }),
          h('span', { class: 'tp-meta' }, h('span', { class: 'tp-rarity', text: rar }), ` · ${typeLabel(cat.types[cat.type[i]])}${lv ? ` · level ${lv}` : ''}`),
          h('span', { class: 'tp-note', text: note.text, hidden: !note.text })),
        cell(id, 'tp-buy', 'Highest buy order', 'Buy', (q) => (q.buy === null ? [h('span', { class: 'tp-none', text: 'no buy orders' })] : [coins(q.buy), ' ', qty(q.buyQty, 'wanted')])),
        cell(id, 'tp-sell', 'Lowest sell listing', 'Sell', (q) => (q.sell === null ? [h('span', { class: 'tp-none', text: 'no sell listings' })] : [coins(q.sell), ' ', qty(q.sellQty, 'listed')])),
        // Spread and margin share one line on a narrow screen and wrap onto two when they do not fit; on a wide
        // one the wrapper steps aside (display: contents) and each is a column.
        h('span', { class: 'tp-extra' },
          cell(id, 'tp-spread', 'Spread', 'Spread', (q) => (q.spread === null ? [h('span', { class: 'tp-none', text: 'none' })] : [coins(q.spread)])),
          cell(id, 'tp-margin', 'Potential margin after fees', 'Margin', (q) => (q.margin === null ? [h('span', { class: 'tp-none', text: 'none' })] : [coins(q.margin), ' ', h('span', { class: 'tp-q tp-pct', text: `${Money.percent(q.marginPct)} of buy` })]))),
        h('button', { type: 'button', class: 'star-btn tp-fav' + (on ? ' on' : ''), 'data-tp-fav': id, 'data-tpkey': `fav:${id}`, 'aria-pressed': String(on), 'aria-label': `Favorite: ${name}` },
          h('span', { 'aria-hidden': 'true', text: on ? '★' : '☆' })));
    }

    /** One Market Watch card: icon, name (to its details), the two prices, and the same price notes as a row. */
    function watchCard(id, t, key) {
      const i = cat.byId.get(id), rar = cat.rarities[cat.rarity[i]], note = rowNote(id, t);
      const side = (v, none) => (v === null ? [h('span', { class: 'tp-none', text: none })] : [coins(v)]);
      return h('li', { class: rowClass(rar, note.age, 'tp-watch-card'), 'data-id': id },
        h('span', { class: 'tp-icon', 'aria-hidden': 'true' }, iconOf(items.get(id), 32)),
        h('a', { class: 'tp-name', href: `#market/item/${id}`, 'aria-haspopup': 'dialog', 'data-tpkey': `${key || 'watch'}:${id}`, text: cat.names[i] }),
        cell(id, 'tp-buy', 'Highest buy order', 'Buy', (q) => side(q.buy, 'no buy orders')),
        cell(id, 'tp-sell', 'Lowest sell listing', 'Sell', (q) => side(q.sell, 'no sell listings')),
        h('span', { class: 'tp-note', text: note.text, hidden: !note.text }));
    }

    let drawTimer = 0;
    function drawSoon() { if (!drawTimer) drawTimer = setTimeout(() => { drawTimer = 0; draw(); }, 0); }

    function draw() {
      if (!cat) return;
      const t = now();
      const focusKey = view.contains(document.activeElement) && document.activeElement.getAttribute('data-tpkey');
      const list = order.slice(0, st.shown);
      $('tp-results').replaceChildren(...list.map(row));
      $('tp-results').setAttribute('aria-busy', String(list.some((i) => pending.has(cat.ids[i]))));
      // Nothing typed, no filter, no price sort: the home (Market Watch and the types) instead of results, and the
      // way back to it beside the results otherwise.
      const home = searchStatus === 'idle';
      $('tp-home').hidden = !home;
      $('tp-crumbs').hidden = home;
      if (!home) $('tp-crumb').textContent = crumbText(Object.assign({ pfCount: pf.set }, st), cat);
      else { drawWatch(t); drawFavHome(t); drawGems(t); }
      const empty = $('tp-empty');
      empty.hidden = home || (searchStatus === 'ok' && order.length > 0);
      empty.textContent = searchStatus === 'ok' && matches.length > 0 ? `No item passes the price filters: ${plural(matches.length, 'match was', 'matches were')} checked, and none passes. Nothing is hidden for want of a price.`
        : searchStatus === 'short' ? 'Type at least 2 letters, or choose a type, a rarity or Favorites.'
          : st.favOnly && !favs.length ? 'No favorites yet. Use the star (☆) by an item to add it.'
            : 'No item in the list matches. The list holds only items with a Trading Post price when it was made.';
      $('tp-head').hidden = !list.length;
      const more = $('tp-more'), left = order.length - list.length;
      more.hidden = left <= 0;
      more.textContent = `Show ${Math.min(PAGE, left)} more (${list.length.toLocaleString('en-US')} of ${order.length.toLocaleString('en-US')} shown)`;
      drawCount();
      // The sort's coverage, right under the sort.
      const s = sortDef();
      const sorting = Boolean(s && s.key);
      $('tp-scope').textContent = searchStatus !== 'ok' || !matches.length ? '' : scopeText({
        sort: st.sort, matches: fcounts ? fcounts.passed : matches.length, ranked: counts ? counts.ranked : 0, noSide: counts ? counts.noSide : 0, unpriced: counts ? counts.unpriced : 0,
        pf: fcounts ? { unchecked: fcounts.uncheckedCount } : null,
        loading: s && s.key ? matches.some((i) => pending.has(cat.ids[i])) : false,
        failed: s && s.key ? matches.some((i) => failed.has(cat.ids[i])) : false,
        wholeAll: whole.all, listCount: cat.count, filtered: Boolean(st.query.trim()) || filtered(),
      }) + (sorting && !fcounts ? ageNote(oldestUsed, t) : '');
      drawFilters(t);
      drawPrices(list, t);
      drawWhole();
      $('tp-favs').textContent = `Favorites (${favs.length})`;
      $('tp-favs').setAttribute('aria-pressed', String(st.favOnly));
      $('tp-fav-unsaved').hidden = !favUnsaved;
      if (focusKey) { const el = view.querySelector(`[data-tpkey="${CSS.escape(focusKey)}"]`); if (el && el !== document.activeElement) el.focus(); }
      if (dialog.open && detailId !== null) drawDetail();
    }

    // The count is a status line, said once the typing stops.
    let countTimer = 0, countText = '';
    function drawCount() {
      const q = st.query.trim();
      const t = searchStatus !== 'ok' ? '' : `${plural(matches.length, 'item', 'items')}${q ? `${matches.length === 1 ? ' matches' : ' match'} “${q}”` : ''}${filtered() ? ' with these filters' : ''}.`;
      if (t === countText) return;
      countText = t;
      clearTimeout(countTimer);
      countTimer = setTimeout(() => { $('tp-count').textContent = countText; }, 400);
    }

    /** Market Watch: its cards and its own price line. Shown only on the home. */
    function drawWatch(t) {
      const ids = watchIds(cat);
      $('tp-watch-list').replaceChildren(...ids.map((id) => watchCard(id, t)));
      $('tp-watch-list').setAttribute('aria-busy', String(ids.some((id) => pending.has(id))));
      priceLine(ids, t, WATCH_LINE);
    }

    /** Your favorites on the home: the newest few, priced as Market Watch is, or what to do when there are none. */
    function drawFavHome(t) {
      const ids = favHome(favs), list = $('tp-favhome-list'), all = $('tp-favhome-all');
      list.replaceChildren(...ids.map((id) => watchCard(id, t, 'favhome')));
      list.hidden = !ids.length;
      list.setAttribute('aria-busy', String(ids.some((id) => pending.has(id))));
      $('tp-favhome-empty').hidden = ids.length > 0;
      $('tp-favhome-prices').hidden = !ids.length;
      if (ids.length) priceLine(ids, t, FAVHOME_LINE);
      all.hidden = favs.length <= ids.length;
      all.textContent = `Show all ${favs.length} favorites`;
      $('tp-favhome-hint').textContent = `saved in this browser, newest first${favLost ? `; ${plural(favLost, 'saved favorite is', 'saved favorites are')} no longer in the item list, so not shown` : ''}`;
    }

    /** The gem exchange: one line a direction, each saying what is given and what is got; no number without the API. */
    function drawGems(t) {
      const line = (k) => {
        const q = gem[k];
        if (q && k === 'coins') return [`${(q.give / 10000).toLocaleString('en-US')} gold buys ${plural(q.get, 'gem', 'gems')} (about `, coins(q.coinsPerGem), ' a gem)'];
        if (q) return [`${plural(q.give, 'gem', 'gems')} sell for `, coins(q.get), ' (about ', coins(q.coinsPerGem), ' a gem)'];
        const why = gemFailed[k];
        return [h('span', { class: 'tp-none', text: gemPending[k] ? (client.paused() ? 'waiting' : 'loading...') : why ? `no rate here: ${API_SAYS[why] || API_SAYS.network}.` : 'not asked for yet' })];
      };
      $('tp-gem-buy-v').replaceChildren(...line('coins'));
      $('tp-gem-sell-v').replaceChildren(...line('gems'));
      gemLine(t);
    }
    /** The gem exchange's line: loading, errors, and how fresh the rates are; Refresh. */
    function gemLine(t) {
      const ks = ['coins', 'gems'], loading = ks.some((k) => gemPending[k]), whys = ks.map((k) => gemFailed[k]).filter(Boolean);
      const ats = ks.map((k) => gem[k]).filter(Boolean).map((q) => q.at), parts = [];
      if (loading) parts.push(client.paused() ? "Loading the rates: ArenaNet's API asked for fewer requests (HTTP 429), so the page waits before asking again." : 'Loading the rates...');
      if (whys.length) {
        const why = whys.reduce((a, b) => (Api.ERRORS.indexOf(a) <= Api.ERRORS.indexOf(b) ? a : b)), none = ks.filter((k) => gemFailed[k] && !gem[k]).length;
        parts.push(`${API_SAYS[why] || API_SAYS.network}, so ${none === 2 ? 'neither rate is shown' : none ? 'one rate is not shown' : 'a rate could not be refreshed'}. Nothing is estimated in its place.`);
      }
      if (ats.length) {
        const oldest = Math.min(...ats), f = freshness(oldest, t), when = time.format(oldest), again = loading ? '' : ' Refresh for current rates.';
        parts.push(f === 'current' ? `Rates received ${when}, current.` : `Rates received ${when}, ${ago(t - oldest)}: ${f}.${again}`);
        $('tp-gem-prices').setAttribute('data-fresh', f);
      } else $('tp-gem-prices').removeAttribute('data-fresh');
      const text = parts.join(' ');
      if ($('tp-gem-text').textContent !== text) $('tp-gem-text').textContent = text;
      $('tp-gem-refresh').hidden = loading;
      $('tp-gem-refresh').textContent = ks.some((k) => gemFailed[k] && !gem[k]) ? 'Try again' : 'Refresh rates';
    }

    /** The price line under the controls, for the rows shown. */
    const RESULTS_LINE = { line: 'tp-prices', text: 'tp-prices-text', btn: 'tp-refresh' };
    const WATCH_LINE = { line: 'tp-watch-prices', text: 'tp-watch-text', btn: 'tp-watch-refresh' };
    const FAVHOME_LINE = { line: 'tp-favhome-prices', text: 'tp-favhome-text', btn: 'tp-favhome-refresh' };
    const drawPrices = (list, t) => priceLine(list.map((i) => cat.ids[i]), t, RESULTS_LINE);

    /** A price line: loading, errors (with what is kept), and how fresh the given items' prices are. */
    function priceLine(ids, t, el) {
      const loading = ids.filter((id) => pending.has(id)).length;
      const missing = ids.filter((id) => failed.has(id) && !cache.has(id)).length;
      const ats = ids.map((id) => cache.get(id)).filter((c) => c && c.q).map((c) => c.at);
      const parts = [];
      const btn = $(el.btn), said = $(el.text);
      if (loading) parts.push(client.paused() ? `Loading prices for ${plural(loading, 'item', 'items')}: ArenaNet's API asked for fewer requests (HTTP 429), so the page waits before asking again.` : `Loading prices for ${plural(loading, 'item', 'items')}...`);
      // The reason given is the worst among the shown rows' own errors, not just the last one seen.
      const whys = ids.map((id) => failed.get(id)).filter(Boolean);
      if (lastError && whys.length) {
        const why = whys.reduce((a, b) => (Api.ERRORS.indexOf(a) <= Api.ERRORS.indexOf(b) ? a : b));
        parts.push(`${API_SAYS[why] || API_SAYS.network}, so ${missing ? `${plural(missing, 'item has', 'items have')} no price here` : 'some prices could not be refreshed'}. Nothing is estimated in its place.`);
      }
      if (ats.length) {
        const oldest = Math.min(...ats), newest = Math.max(...ats), f = freshness(oldest, t);
        const when = time.format(oldest) === time.format(newest) ? time.format(oldest) : `${time.format(oldest)} to ${time.format(newest)}`;
        // "Refresh" only when the Refresh button is there: not while a refresh is already on its way.
        const again = loading ? '' : ' Refresh for current prices.';
        parts.push(f === 'current' ? `Prices received ${when}, current.` : f === 'stale' ? `Prices received ${when}, ${ago(t - oldest)}: stale.${again}`
          : `Prices received ${when}, ${ago(t - oldest)}: old, shown faded.${again}`);
        $(el.line).setAttribute('data-fresh', f);
      } else $(el.line).removeAttribute('data-fresh');
      const text = parts.join(' ');
      if (said.textContent !== text) said.textContent = text;
      btn.hidden = !ids.length || loading > 0;
      btn.textContent = missing && lastError ? 'Try again' : 'Refresh prices';
    }

    // ---- Load the whole market: only when the reader asks, with progress and Cancel ----

    function drawWhole() {
      const box = $('tp-whole'), conf = $('tp-whole-confirm'), prog = $('tp-whole-progress');
      const n = client.requestsFor(cat.ids);
      box.hidden = false;
      // Hidden while it runs, and for 5 minutes after a complete load: those prices are still current.
      $('tp-whole-btn').hidden = whole.state === 'loading' || whole.state === 'confirm' || (whole.state === 'done' && whole.all && now() - whole.started < WHOLE_GAP_MS);
      $('tp-whole-btn').textContent = whole.ended ? 'Load the whole market again' : 'Load whole market';
      $('tp-whole-btn').setAttribute('aria-expanded', String(whole.state === 'confirm'));
      conf.hidden = whole.state !== 'confirm';
      $('tp-whole-start').textContent = `Load ${n} pages of prices`;
      $('tp-whole-explain').textContent = `This asks ArenaNet's API for the price of every item in the list: ${cat.count.toLocaleString('en-US')} items, `
        + `${n} requests of 200 (Phase A measured about 142 for the whole Trading Post), paced to stay inside the API's limits, so it takes about ${Math.ceil(n / 4 / 10) * 10} seconds. `
        + 'Then price sorts can rank every match. The prices are kept only while this page is open, and nothing is saved.';
      prog.hidden = whole.state !== 'loading';
      $('tp-whole-bar').max = Math.max(1, whole.total);
      $('tp-whole-bar').value = whole.done;
      $('tp-whole-count').textContent = `${whole.done} of ${whole.total} requests`;
    }
    function wholeSay(text) { $('tp-whole-status').textContent = text; }
    async function startWhole() {
      if (whole.state === 'loading') return;
      wholeCtl = new AbortController();
      const sig = wholeCtl.signal;
      Object.assign(whole, { state: 'loading', done: 0, total: client.requestsFor(cat.ids), answered: 0, failedReq: 0, started: now(), all: false });
      wholeSay(`Loading the whole market: ${whole.total} requests.`);
      draw();
      $('tp-whole-cancel').focus();
      // Every id, even ones with a current price: the point is one consistent set of prices.
      const ids = cat.ids.filter((id) => !live(pending, id));
      const t0 = now();
      const own = hold(pending, ids, sig);
      const r = await client.prices(ids, { signal: sig, onBatch: (p) => { whole.done = p.done; whole.answered = p.answered; whole.failedReq = p.done - p.answered; drawWhole(); } });
      release(pending, ids, own);
      for (const [id, row] of r.rows) { cache.set(id, { at: row.at, q: Money.quote(row) }); failed.delete(id); }
      for (const id of r.missing) { cache.set(id, { at: now(), none: true }); failed.delete(id); }
      noteFailures(r);
      whole.ended = now();
      // "A price": a loaded one; an item the API says has none is not counted as priced.
      const priced = cat.ids.filter((id) => { const c = cache.get(id); return c && c.q; }).length;
      const range = `${time.format(t0)} to ${time.format(whole.ended)}`;
      if (sig.aborted) {
        whole.state = 'cancelled';
        wholeSay(`Cancelled after ${whole.done} of ${whole.total} requests. ${plural(priced, 'item has', 'items have')} a price loaded; price sorts cover only those.`);
      } else if (r.failed.length) {
        whole.state = 'done'; whole.all = false;
        // Requests that failed, or (all answered) prices that could not be read.
        const lost = r.requests > r.answered ? `${r.requests - r.answered} of ${r.requests} requests failed` : `${plural(r.failed.length, 'price', 'prices')} could not be read`;
        wholeSay(`Partly loaded (${range}): ${lost} (${API_SAYS[r.error] || r.error}). ${plural(priced, 'item has', 'items have')} a price; price sorts are partial. Load again to try the rest.`);
      } else {
        whole.state = 'done'; whole.all = true;
        wholeSay(`Whole market loaded (${range}): prices for every item in the list.${r.missing.size ? ` ${plural(r.missing.size, 'item has', 'items have')} no Trading Post price now.` : ''} It can be loaded again from ${time.format(whole.started + WHOLE_GAP_MS)}.`);
      }
      wholeCtl = null;
      resort();
      draw();
      loadItems(visibleIds(), viewCtl ? viewCtl.signal : undefined);
      // Cancel has gone: focus moves to the whole-market line, never into the void.
      const f = document.activeElement;
      if (!view.hidden && (!f || f === document.body || !f.getClientRects().length)) ($('tp-whole-btn').hidden ? $('tp-whole-status') : $('tp-whole-btn')).focus();
    }

    // ---- Favorites ----

    function toggleFav(id) {
      favs = favs.includes(id) ? favs.filter((x) => x !== id) : favs.concat(id).slice(-FAV_MAX);
      if (!Store.write(storage, FAV_KEY, favs)) favUnsaved = true;
      if (st.favOnly) apply(false); else draw();
    }
    window.addEventListener('storage', (ev) => {
      if (!cat || ev.key !== Store.PREFIX + FAV_KEY) return;
      favs = sanitizeFavorites(Store.read(storage, FAV_KEY), cat.byId);
      favLost = lostFavorites(Store.read(storage, FAV_KEY), cat.byId);
      if (st.favOnly) apply(true); else { draw(); loadWatch(false); }
    });

    // ---- One item's details: "#market/item/<id>" ----

    function detailBody(id) {
      const i = cat.byId.get(id), it = items.get(id), c = cache.get(id), q = c && c.q, t = now();
      const name = cat.names[i], rar = cat.rarities[cat.rarity[i]], lv = cat.level[i];
      const fact = (k, ...v) => [h('dt', { text: k }), h('dd', {}, ...v)];
      const on = favs.includes(id);
      const icon = iconOf(it, 48, 'tp-big-icon');
      const sub = it && it.details && typeof it.details.type === 'string' ? ` (${it.details.type.replace(/([a-z])([A-Z])/g, '$1 $2')})` : '';
      const prices = [];
      // The three figures a trader looks for first, large, with when this page received them; the arithmetic and
      // the caveats follow in the list below them, smaller.
      let stats = null;
      if (q) {
        const f = freshness(c.at, t), why = failed.get(id);
        const stat = (cls, label, value, note) => h('div', { class: `tp-stat ${cls}` }, h('span', { class: 'tp-stat-k', text: label }), h('span', { class: 'tp-stat-v' }, ...value), note ? h('span', { class: 'tp-stat-sub', text: note }) : null);
        stats = h('div', { class: 'tp-stats-wrap' },
          h('div', { class: `tp-stats${f === 'old' ? ' is-old' : ''}` },
            stat('tp-stat-buy', 'Highest buy order', q.buy === null ? [none('No buy orders.')] : [coins(q.buy)], q.buy === null ? '' : `${Money.count(q.buyQty)} units wanted in all buy orders`),
            stat('tp-stat-sell', 'Lowest sell listing', q.sell === null ? [none('No sell listings.')] : [coins(q.sell)], q.sell === null ? '' : `${Money.count(q.sellQty)} units listed in all`),
            stat('tp-stat-margin', 'Potential margin', q.margin === null ? [none('None: one side has no orders.')] : [coins(q.margin)], q.margin === null ? '' : `${Money.percent(q.marginPct)} of the highest buy order, after fees`),
            stat('tp-stat-even', 'Break-even listing price', q.breakEven === null ? [none('None: no buy orders to cost it.')] : [coins(q.breakEven)], q.breakEven === null ? '' : 'the lowest that gives back the buy price after fees')),
          h('p', { class: `tp-stat-when${f === 'current' ? '' : ' is-' + f}`, text: `${receivedText('prices', time.format(c.at), t - c.at, f)}${why ? ` A newer price could not be loaded: ${API_SAYS[why] || API_SAYS.network}.` : ''}` }));
        prices.push(...fact('Spread', ...(q.spread === null ? [none('None: one side has no orders.')] : [coins(q.spread), ' (lowest sell listing minus highest buy order)'])));
        // At a price of a few copper the two fees (at least 1 copper each) take all of it: said in words, not left
        // as "about 0c" or "about -1c".
        const allFees = (p) => (p.net <= 0 ? ' At this price the fees, at least 1 copper each, take all of it.' : '');
        prices.push(...fact('Sell one now', ...(q.sellNow ? ['Selling to the highest buy order would give you about ', coins(q.sellNow.net), ' after the listing fee of ', coins(q.sellNow.listing), ' and the exchange fee of ', coins(q.sellNow.exchange), `.${allFees(q.sellNow)}`] : [none('No buy orders to sell to.')])));
        prices.push(...fact('List one', ...(q.listAtLowest ? ['Listing at the lowest sell listing would give you about ', coins(q.listAtLowest.net), ` after fees, only if it sells: someone may list lower, and it may not sell.${allFees(q.listAtLowest)}`] : [none('No sell listings to match.')])));
        prices.push(...fact('Potential margin', ...(q.margin === null ? [none('None: one side has no orders.')]
          : ['Buying at the highest buy order and listing at the lowest sell listing, after fees. The percentage is of the highest buy order, what buying one costs. A potential margin, not a profit: neither order has filled, and prices move.'])));
        // Break-even: by the same fees as everything above (Money.breakEven runs proceeds()), for one unit bought at the
        // highest buy order. Where the lowest sell listing stands against it is said in words.
        if (q.breakEven !== null) {
          const gain = Money.breakEven(q.buy + 1);
          const vs = q.sell === null ? 'There are no sell listings to compare it with.'
            : q.sell >= q.breakEven ? ['The lowest sell listing, ', coins(q.sell), ', is at or above it.'] : ['The lowest sell listing, ', coins(q.sell), ', is below it: listing there now would lose.'];
          prices.push(...fact('Break-even', 'Listing one unit at ', coins(q.breakEven), ' or more would give back at least the highest buy order, ', coins(q.buy), ', after both fees; any lower would lose. A gain of 1 copper or more starts at ', coins(gain), '. ', ...[].concat(vs),
            " An estimate: the fees' rounding is assumed, and an order fills only if someone takes it."));
        }
      } else if (c && c.none) prices.push(...fact('Prices', none('Not on the Trading Post now: the API has no price for it.')));
      else if (pending.has(id)) prices.push(...fact('Prices', none(client.paused() ? "Waiting: ArenaNet's API asked for fewer requests (HTTP 429). The page asks again shortly." : 'Loading...')));
      else if (failed.has(id)) prices.push(...fact('Prices', none(`${API_SAYS[failed.get(id)] || API_SAYS.network}. No price is shown; nothing is estimated.`)));
      else prices.push(...fact('Prices', none('Not requested yet.')));
      const vendor = it && Number.isSafeInteger(it.vendor_value) ? (Array.isArray(it.flags) && it.flags.includes('NoSell') ? 'Merchants do not buy it.' : it.vendor_value > 0 ? ['A merchant pays ', coins(it.vendor_value), '.'] : 'Merchants pay nothing for it.') : null;
      const desc = it ? Catalog.plainText(it.description) : '';
      const chat = it && typeof it.chat_link === 'string' && /^\[&[A-Za-z0-9+/=]+\]$/.test(it.chat_link) ? it.chat_link : null;
      return [
        h('div', { class: 'tp-detail-head' }, icon, h('p', { class: 'badges' },
          h('span', { class: `badge tp-rarity-badge rarity-${rar.toLowerCase()}`, text: rar }), ' ',
          h('span', { class: 'badge', text: typeLabel(cat.types[cat.type[i]]) + sub }), lv ? ' ' : null, lv ? h('span', { class: 'badge', text: `Level ${lv}` }) : null)),
        stats,
        desc ? h('p', { class: 'tp-desc', text: desc }) : null,
        h('div', { class: 'actions ed-actions' },
          h('button', { type: 'button', class: 'btn small ed-star' + (on ? ' on' : ''), 'data-tp-fav': id, 'data-tpkey': 'dlg:fav', 'aria-pressed': String(on), 'aria-label': `Favorite: ${name}` }, h('span', { 'aria-hidden': 'true', text: on ? '★' : '☆' }), ' Favorite'),
          h('button', { type: 'button', class: 'btn small', 'data-tp-refresh-one': id, 'data-tpkey': 'dlg:refresh', text: 'Refresh price' }),
          chat ? h('button', { type: 'button', class: 'btn small', 'data-tp-copy': chat, 'data-tpkey': 'dlg:chat', 'aria-label': `Copy chat code for ${name}: ${chat}`, text: 'Copy chat code' }) : null,
          h('button', { type: 'button', class: 'btn small', 'data-tp-link': id, 'data-tpkey': 'dlg:link', 'aria-label': `Copy link to ${name}`, text: 'Copy link' }),
          h('a', { class: 'btn small', href: `https://wiki.guildwars2.com/wiki/Special:Search/${encodeURIComponent(name)}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${name} on the Guild Wars 2 Wiki (opens a new tab)`, text: 'Wiki' })),
        h('dl', { class: 'ed-facts tp-facts' }, ...prices, ...(vendor ? fact('Merchant', ...[].concat(vendor)) : []), ...fact('Item id', String(id)), ...(chat ? fact('Chat code', chat) : [])),
      ].filter(Boolean);
    }
    // ---- The order book and the quantity calculator ----
    //
    // One request, only when the reader asks for it (the button), and one more for each Refresh: choosing an amount or
    // a way to trade works on the book already here and asks ArenaNet for nothing. Everything is worked out by
    // js/money.js plan() from the order book alone, never mixed with the prices above (the two are separate answers
    // of the API and can disagree). What is at once (buying from sell listings, selling to buy orders) is told apart
    // from what only might happen (a buy order filling, a listing selling), and nothing is promised: the book has
    // its own time, and it may have changed since.

    const FEE_NOTE = `Estimates. The figures above the order book are for one unit; the calculator's are for the amount chosen. Fees as ArenaNet documents them: a ${Money.LISTING_PCT}% listing fee and a ${Money.EXCHANGE_PCT}% exchange fee, each at least 1 copper; how a fraction of a copper is rounded is not published, so this page rounds to the nearest copper. Whether the fees of a sale that crosses several prices are worked out on the whole sale or on each price is not published either, so the calculator shows both when they differ.`;
    const AMOUNT_SAYS = {
      'not-whole': `That is not a whole number. Type 1 to ${Money.MAX_UNITS}, in digits only.`,
      range: `Type a whole number from 1 to ${Money.MAX_UNITS}: one Trading Post transaction holds at most ${Money.MAX_UNITS} units.`,
    };
    const units = (n) => `${Money.count(n)} ${n === 1 ? 'unit' : 'units'}`;
    const none = (text) => h('span', { class: 'tp-none', text });
    /** An estimate after fees: one figure, or both when the two ways of working out the fees differ. */
    const about = (lo, hi) => (lo === hi ? ['about ', coins(lo)] : ['about ', coins(hi), ' or ', coins(lo)]);

    function calcNodes(id) {
      const radio = (name, value, textId) => h('label', { class: 'rm-option tp-calc-opt' }, h('input', { type: 'radio', name, value, checked: calc[name === 'tp-calc-get' ? 'get' : 'give'] === value }), ' ', h('span', { id: textId }));
      return [
        h('h3', { id: 'tp-calc-title', tabindex: '-1', text: 'Order book and quantity calculator' }),
        h('p', { class: 'tp-book-when', id: 'tp-book-when' }),
        h('p', { class: 'tp-book-actions' }, h('button', { type: 'button', class: 'btn small', id: 'tp-book-refresh', 'data-tp-book': id, text: 'Refresh the order book' })),
        h('div', { class: 'tp-book-warn', id: 'tp-book-warn', hidden: true }),
        h('div', { class: 'tp-calc-units', role: 'group', 'aria-labelledby': 'tp-calc-units-k' },
          h('span', { class: 'tp-calc-k', id: 'tp-calc-units-k', text: 'Units' }),
          ...CALC_CHIPS.map((v) => h('button', { type: 'button', class: 'btn small tp-calc-chip', 'data-tp-calc-n': v, 'aria-pressed': 'false', text: String(v) })),
          h('label', { class: 'tp-calc-custom' }, 'Other amount ', h('input', { type: 'text', id: 'tp-calc-n', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: '9', size: '5', value: calc.text, 'aria-describedby': 'tp-calc-hint tp-calc-err' }))),
        h('p', { class: 'hint tp-calc-hint', id: 'tp-calc-hint', text: `1 to ${Money.MAX_UNITS}: one Trading Post transaction holds at most ${Money.MAX_UNITS} units. Changing the amount asks ArenaNet for nothing.` }),
        h('p', { class: 'tp-calc-err', id: 'tp-calc-err', role: 'alert', hidden: true }),
        h('fieldset', { class: 'tp-calc-way' }, h('legend', { text: 'Getting the units' }), radio('tp-calc-get', 'now', 'tp-calc-get-now'), radio('tp-calc-get', 'order', 'tp-calc-get-order')),
        h('fieldset', { class: 'tp-calc-way' }, h('legend', { text: 'Then' }), radio('tp-calc-give', 'now', 'tp-calc-give-now'), radio('tp-calc-give', 'list', 'tp-calc-give-list')),
        h('div', { class: 'tp-calc-out', id: 'tp-calc-out' }),
        h('p', { class: 'sr-only', id: 'tp-calc-said', role: 'status' }),
      ];
    }

    /** What is wrong or unsure about the order book that is here, each in a sentence; nothing is left unsaid. */
    function bookWarnings(id) {
      const out = [], pq = quoteOf(id);
      const top = (s) => (s.levels.length ? s.levels[0].price : null), bid = top(book.buys), ask = top(book.sells);
      // A side one answer has and the other lacks is a difference too.
      if (pq && (pq.buy !== bid || pq.sell !== ask)) {
        out.push(h('p', { 'data-tp-warn': 'differs' }, 'The order book and the prices above are separate answers from ArenaNet, and here they differ: the book has ',
          ...(bid === null ? ['no buy orders'] : ['buy orders from ', coins(bid)]), ' and ', ...(ask === null ? ['no sell listings'] : ['sell listings from ', coins(ask)]),
          '. Neither says which is newer. The calculator uses the order book only.'));
      }
      for (const s of [book.buys, book.sells]) {
        const what = s.side === 'buys' ? 'buy orders' : 'sell listings';
        if (s.repeats) out.push(h('p', { 'data-tp-warn': 'repeats', text: `ArenaNet's answer repeated ${plural(s.repeats, 'price', 'prices')} among the ${what}. Each price is counted once here, and where the answer repeats one, another may be missing: past the best ${plural(s.sure, 'price', 'prices')} the ${what} are uncertain, and so is their total.` }));
        if (s.unsorted) out.push(h('p', { 'data-tp-warn': 'unsorted', text: `The ${what} did not arrive in price order. They are sorted here, and figures from them are marked uncertain.` }));
        if (s.dropped) out.push(h('p', { 'data-tp-warn': 'dropped', text: `${plural(s.dropped, 'row', 'rows')} of the ${what} could not be read and ${s.dropped === 1 ? 'is' : 'are'} left out, so figures from them are marked uncertain.` }));
      }
      return out;
    }

    /** One side's table: its best prices, as many as the amount reaches (up to BOOK_MOST), with what the amount takes of each. */
    function bookTable(side, w, cap, unitWord, n) {
      const used = w ? w.fills.length : 0, shown = Math.min(side.levels.length, Math.max(BOOK_ROWS, Math.min(BOOK_MOST, used)));
      const rows = side.levels.slice(0, shown).map((l, i) => h('tr', { class: i < used ? 'is-taken' : null },
        h('td', {}, coins(l.price)), h('td', { text: Money.count(l.quantity) }), h('td', { text: l.orders === null ? '' : Money.count(l.orders) }), h('td', { text: i < used ? Money.count(w.fills[i].take) : '' })));
      if (used > shown) rows.push(h('tr', { class: 'is-taken' }, h('td', { colspan: 4 }, `and ${plural(used - shown, 'more price', 'more prices')} reached, the last at `, coins(w.worst), ' each')));
      if (!side.levels.length) rows.push(h('tr', {}, h('td', { colspan: 4, text: 'None.' })));
      return h('table', { class: 'tp-book-table' },
        h('caption', { text: `${cap}: ${units(side.depth)} at ${plural(side.levels.length, 'price', 'prices')} in all${side.repeats || side.dropped ? ' (uncertain)' : ''}` }),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Price each' }), h('th', { scope: 'col', text: unitWord }), h('th', { scope: 'col', text: 'Orders' }), h('th', { scope: 'col', text: n ? `Taken for ${Money.count(n)}` : 'Taken' }))),
        h('tbody', {}, ...rows));
    }

    /**
     * Depth near the best price (v0.5.0 Phase 3): for each side, the units the order book showed queued within
     * NEAR_PCT% of its own best price (js/money.js near()), with the prices that is and the range, beside the side's
     * whole depth. Observed book depth, said so, never offered as what can be traded: the book is a snapshot, and its
     * repeated, unreadable or disordered rows mark the figure uncertain as they mark the walk. It depends on the book
     * alone, not on the amount or the ways chosen.
     */
    function nearBlock() {
      const fact = (k, key, ...v) => [h('dt', { text: k }), h('dd', { 'data-tp-near': key }, ...v)];
      const unsure = ' Uncertain: it reaches prices where the order book is not sure (see above).';
      const facts = [];
      for (const s of [book.buys, book.sells]) {
        const buys = s.side === 'buys', d = Money.near(s), what = buys ? 'buy orders' : 'sell listings';
        const k = `${buys ? 'Buy orders' : 'Sell listings'} within ${Money.NEAR_PCT}%`;
        if (!d) { facts.push(...fact(k, s.side, none(`None: the order book has no ${what}.`))); continue; }
        // The range is the best price and the limit, not the last level in it: a level need not stand at the limit.
        facts.push(...fact(k, s.side, `${units(d.units)} ${buys ? 'wanted' : 'listed'} at `,
          ...(d.limit === d.best ? [coins(d.best)] : [`${plural(d.prices, 'price', 'prices')} between `, coins(d.best), ' and ', coins(d.limit)]),
          `, of ${Money.count(s.depth)} in the whole order book.`,
          d.limit === d.best ? ` At this price ${Money.NEAR_PCT}% is less than 1 copper, so only this price counts.` : '',
          d.uncertain ? unsure : ''));
      }
      return h('div', { class: 'tp-near', id: 'tp-book-near' },
        h('h4', { text: 'Observed book depth near the best price' }),
        h('dl', { class: 'ed-facts tp-facts tp-near-facts' }, ...facts),
        h('p', { class: 'hint tp-near-note', text: `What this order book showed queued at prices within ${Money.NEAR_PCT}% of its own best price, both ends included. Not a guarantee that this many can be bought or sold: orders come and go, others trade first, and the book may have changed since this page received it.` }));
    }

    /** The calculator's figures for a plan (js/money.js plan()), as a list of facts; every number says what it is. */
    function calcFacts(p, f, t) {
      const fact = (k, key, ...v) => [h('dt', { text: k }), h('dd', { 'data-tp-fig': key }, ...v)];
      const out = [], N = units(p.n), b = p.buyNow, s = p.sellNow;
      const each = (avg) => (avg.exact ? [coins(avg.value), ' each'] : ['about ', coins(avg.value), ' each']);
      const unsure = ' Uncertain: it reaches prices where the order book is not sure (see above).';
      if (p.get === 'now') {
        out.push(...fact(`Buy ${N} now`, 'buy-now', ...(!b.filled ? [none('No sell listings in the order book.')]
          : b.short ? [`Only ${Money.count(b.filled)} of ${Money.count(p.n)} are listed in the whole order book. Those ${Money.count(b.filled)} would cost `, coins(b.total), `; nothing is worked out for the other ${Money.count(b.short)}.${b.uncertain ? unsure : ''}`]
            : [coins(b.total), ' in all, ', ...each(b.avg), b.fills.length > 1 ? [`, across ${b.fills.length} prices, up to `, coins(b.worst), ' each'] : ', all at one price', `. No fee to buy.${b.uncertain ? unsure : ''}`].flat())));
      } else {
        out.push(...fact(`Buy order for ${N}`, 'buy-order', ...(p.order ? [`At the highest buy order in the book, `, coins(p.order.price), ' each: ', coins(p.order.total), ', paid when the order is placed, no fee. Not something the order book fills now: it fills only if sellers come to it, and it may never fill.'] : [none('No buy orders in the order book to match.')])));
      }
      if (p.give === 'now') {
        const fe = s.fees;
        out.push(...fact(`Sell ${N} now`, 'sell-now', ...(!s.filled ? [none('No buy orders in the order book.')]
          : s.short ? [`Only ${Money.count(s.filled)} of ${Money.count(p.n)} are wanted in the whole order book. Those ${Money.count(s.filled)} would sell for `, coins(s.total), ` before fees; nothing is worked out for the other ${Money.count(s.short)}.${s.uncertain ? unsure : ''}`]
            : [coins(s.total), ' before fees, ', ...each(s.avg), s.fills.length > 1 ? [`, across ${s.fills.length} prices, down to `, coins(s.worst), ' each'] : ', all at one price', '. ',
              ...(fe.differ ? ['After fees, two estimates: about ', coins(fe.whole.net), ' if both fees are worked out on the whole sale (', coins(fe.whole.listing), ' and ', coins(fe.whole.exchange), '), or about ', coins(fe.byLevel.net), ' if on each price (', coins(fe.byLevel.listing), ' and ', coins(fe.byLevel.exchange), '). ArenaNet does not publish which applies, and neither is a limit.']
                : ['After the listing fee of ', coins(fe.whole.listing), ' and the exchange fee of ', coins(fe.whole.exchange), ': about ', coins(fe.whole.net), '.']),
              fe.high <= 0 ? ' At this price the fees, at least 1 copper each, take all of it.' : '', s.uncertain ? unsure : ''].flat())));
      } else {
        out.push(...fact(`List ${N}`, 'list', ...(p.list ? ['At the lowest sell listing in the book, ', coins(p.list.price), ' each: about ', coins(p.list.net), ' after the listing fee of ', coins(p.list.listing), ' (paid when listing, not returned) and the exchange fee of ', coins(p.list.exchange),
          `. Not something the order book fills now: only if it sells. Someone may list lower, and it may not sell.${p.list.net <= 0 ? ' At this price the fees, at least 1 copper each, take all of it.' : ''}`] : [none('No sell listings in the order book to match.')])));
      }
      const WHY = {
        'no-sells': 'None: the order book has no sell listings.', 'no-buys': 'None: the order book has no buy orders.',
        'short-sells': `None: the order book lists only ${Money.count(b.filled)} of the ${Money.count(p.n)} to buy.`, 'short-buys': `None: the order book wants only ${Money.count(s.filled)} of the ${Money.count(p.n)}.`,
      };
      if (!p.gain) { out.push(...fact('Profit or loss', 'gain', none(WHY[p.why] || 'None.'))); return out; }
      const two = p.gain.low !== p.gain.high;
      const hopes = [p.get === 'order' ? 'the buy order fills' : '', p.give === 'list' ? 'the listing sells' : ''].filter(Boolean);
      const cond = p.executable ? ` if the order book is still as ${f === 'current' ? 'ArenaNet reported it' : `it was in the answer received ${ago(t - book.at)}`}. An estimate, never a promise: the book may have changed.`
        : ` only if ${hopes.join(' and ')}: ${hopes.length > 1 ? 'neither is' : 'that is not'} certain, and prices move.`;
      // A figure worked out from a walk that reaches what the book is not sure of says so, as the walk's own line does.
      const from = ' Uncertain: worked out from prices where the order book is not sure (see above).';
      out.push(...fact('Profit or loss', 'gain', ...about(p.gain.low, p.gain.high), two ? ' (the two fee estimates)' : '', ': ', ...about(p.back.low, p.back.high), ' after fees, less the cost of ', coins(p.cost), ',', cond, p.uncertain ? from : ''));
      // Return on cost (v0.5.0 Phase 3): the profit or loss above as a share of the cost, for the amount and the two
      // ways chosen, with the two numbers it is made of and the same conditions; both fee estimates when they differ.
      const pc = Money.percent, rTwo = two && pc(p.roi.low) !== pc(p.roi.high);
      const how = `${N} ${p.get === 'now' ? 'bought now' : 'bought by a buy order'} and ${p.give === 'now' ? 'sold now' : 'listed'}`;
      out.push(...fact('Return on cost', 'roi', `about ${pc(p.roi.high)}${rTwo ? ` or ${pc(p.roi.low)} (the two fee estimates)` : ''}: the profit or loss (`, ...about(p.gain.low, p.gain.high), ') divided by the cost (', coins(p.cost), `), for ${how},`, cond, p.uncertain ? from : ''));
      const e = p.breakEven;
      if (e && e.kind === 'list') out.push(...fact('Break-even', 'even', `Listing the ${N} at `, coins(e.price), ' each or more would give back the cost after both fees; any lower would lose.',
        p.ask === null ? '' : p.ask >= e.price ? ' The lowest sell listing in the book is at or above it.' : ' The lowest sell listing in the book is below it: listing there would lose.', p.get === 'now' && p.buyNow.uncertain ? from : ''));
      else if (e) out.push(...fact('Break-even', 'even', 'Selling now gives back ', ...about(e.low, e.high), ' each after fees: having paid more than that for each, selling now would lose.', p.sellNow.uncertain ? from : ''));
      return out;
    }

    function updateCalc(id) {
      const el = detailEls.book, q = (sel) => el.querySelector(sel), t = now(), f = freshness(book.at, t);
      const when = q('#tp-book-when');
      const whenText = receivedText('book', time.format(book.at), t - book.at, f)
        + (book.refreshing ? ' Asking again...' : book.error ? ` A newer order book could not be loaded: ${API_SAYS[book.error] || API_SAYS.network}. This one stays, with its time.` : '')
        + (f === 'current' ? '' : ' Refresh it before relying on these figures.');
      if (when.textContent !== whenText) when.textContent = whenText;
      const whenClass = `tp-book-when${f === 'current' ? '' : ' is-' + f}`;
      if (when.className !== whenClass) when.className = whenClass;
      const amt = readAmount(calc.text, calc.chip, Money.MAX_UNITS);
      const pq = quoteOf(id);
      // Redrawn only when something it shows has changed: not on every tick, so nothing is read out or reflowed for nothing.
      const sig = JSON.stringify([book.at, amt, calc.get, calc.give, pq ? [pq.buy, pq.sell] : null, f]);
      if (detailEls.sig === sig) return;
      detailEls.sig = sig;
      const p = amt.error ? null : Money.plan(book, amt.n, calc);
      for (const b of el.querySelectorAll('[data-tp-calc-n]')) b.setAttribute('aria-pressed', String(!calc.text.trim() && Number(b.getAttribute('data-tp-calc-n')) === calc.chip));
      const err = q('#tp-calc-err'), errText = amt.error ? AMOUNT_SAYS[amt.error] : '';
      if (err.textContent !== errText) err.textContent = errText;
      err.hidden = !errText;
      if (errText) q('#tp-calc-n').setAttribute('aria-invalid', 'true'); else q('#tp-calc-n').removeAttribute('aria-invalid');
      const warns = bookWarnings(id);
      q('#tp-book-warn').replaceChildren(...warns);
      q('#tp-book-warn').hidden = !warns.length;
      // The four ways, each with its own figure, so every one can be compared before it is chosen.
      const b = p && p.buyNow, s = p && p.sellNow;
      q('#tp-calc-get-now').replaceChildren('Buy now from the sell listings', ...(!p ? [] : !b.filled ? [': none are listed'] : b.short ? [`: only ${Money.count(b.filled)} of ${Money.count(p.n)} are listed`] : [': ', coins(b.total)]));
      q('#tp-calc-get-order').replaceChildren('Place a buy order', ...(!p ? [] : !p.order ? [': there is no buy order to match'] : [' at the highest, ', coins(p.order.price), ' each: ', coins(p.order.total), ', only if it fills']));
      q('#tp-calc-give-now').replaceChildren('Sell now to the buy orders', ...(!p ? [] : !s.filled ? [': none are wanted'] : s.short ? [`: only ${Money.count(s.filled)} of ${Money.count(p.n)} are wanted`] : [': ', ...about(s.fees.low, s.fees.high), ' after fees']));
      q('#tp-calc-give-list').replaceChildren('List them', ...(!p ? [] : !p.list ? [': there is no sell listing to match'] : [' at the lowest, ', coins(p.list.price), ' each: about ', coins(p.list.net), ' after fees, only if it sells']));
      const stale = f === 'current' ? null : h('p', { class: 'tp-calc-stale', text: `This order book was received ${ago(t - book.at)}: ${f}. The figures below are what it showed then, not what can be traded now. Refresh it first.` });
      q('#tp-calc-out').replaceChildren(...[
        stale,
        p ? h('dl', { class: 'ed-facts tp-facts tp-calc-facts' }, ...calcFacts(p, f, t)) : h('p', { class: 'tp-none', text: 'No figures: the amount is not one this page can work with.' }),
        nearBlock(),
        h('div', { class: 'tp-book-sides' }, bookTable(book.buys, p && p.give === 'now' ? s : null, 'Buy orders, highest first', 'Units wanted', p && p.give === 'now' ? p.n : 0), bookTable(book.sells, p && p.get === 'now' ? b : null, 'Sell listings, lowest first', 'Units listed', p && p.get === 'now' ? p.n : 0)),
      ].filter(Boolean));
      const said = !p ? '' : `${units(p.n)}: ${p.gain ? `profit or loss ${Money.coins(p.gain.high).spoken}${p.gain.low !== p.gain.high ? ` or ${Money.coins(p.gain.low).spoken}` : ''}, an estimate` : 'no result, the order book cannot fill it'}.`;
      if (q('#tp-calc-said').textContent !== said) q('#tp-calc-said').textContent = said;
    }

    function drawBook(id) {
      const el = detailEls.book;
      const state = !book || book.id !== id ? 'closed' : book.state;
      const key = `${id}:${state}:${state === 'failed' ? book.error : ''}`;
      if (detailEls.key !== key) {
        const had = el.contains(document.activeElement);
        detailEls.key = key;
        detailEls.sig = '';
        const btn = (text) => h('button', { type: 'button', class: 'btn small', 'data-tp-book': id, text });
        if (state === 'closed') el.replaceChildren(btn('Show the order book and quantity calculator'));
        else if (state === 'loading') el.replaceChildren(h('p', { class: 'tp-none', id: 'tp-book-loading', tabindex: '-1', text: 'Loading the order book...' }));
        else if (state === 'failed') el.replaceChildren(h('p', { text: `${API_SAYS[book.error] || API_SAYS.network}. The order book is not shown, and nothing is worked out without it.` }), btn('Try again'));
        else if (state === 'none') el.replaceChildren(h('p', { id: 'tp-book-none', tabindex: '-1', text: 'The API has no order book for this item now.' }));
        else el.replaceChildren(...calcNodes(id));
        // Focus was on what has just gone (the button, or the loading line): it goes to what took its place.
        if (had) { const to = el.querySelector('#tp-calc-title, #tp-book-loading, #tp-book-none, button'); if (to) to.focus(); }
      }
      if (state === 'ok') updateCalc(id);
    }
    async function loadBook(id) {
      if (bookCtl) bookCtl.abort();
      bookCtl = new AbortController();
      // Asked for again: the book that is here stays, with its time, until a newer one replaces it.
      const prev = book && book.id === id && book.state === 'ok' ? book : null;
      book = prev ? Object.assign({}, prev, { refreshing: true, error: null }) : { id, state: 'loading' };
      detailEls.sig = '';
      drawDetail();
      const r = await client.listings(id, { signal: bookCtl.signal });
      if (!book || book.id !== id) return;
      if (!r.ok) { if (r.error === 'aborted') return; book = prev ? Object.assign({}, prev, { refreshing: false, error: r.error }) : { id, state: 'failed', error: r.error }; }
      else if (r.notFound) book = { id, state: 'none' };
      else {
        const lost = r.book.dropped || {};
        book = { id, state: 'ok', at: r.book.at, buys: Money.cleanSide(r.book.buys, 'buys', lost.buys), sells: Money.cleanSide(r.book.sells, 'sells', lost.sells) };
      }
      if (detailEls) detailEls.sig = '';
      drawDetail();
    }
    function drawDetail() {
      if (detailId === null) return;
      const body = $('tp-item-body');
      if (!detailEls || detailEls.id !== detailId || detailEls.main.parentNode !== body) {
        detailEls = { id: detailId, main: h('div', { class: 'tp-detail-main' }), book: h('div', { class: 'tp-book' }), key: null, sig: '' };
        body.replaceChildren(detailEls.main, detailEls.book, h('p', { class: 'tp-fee-note', text: FEE_NOTE }));
      }
      const main = detailEls.main;
      const focusKey = main.contains(document.activeElement) && document.activeElement.getAttribute('data-tpkey');
      $('tp-item-title').textContent = cat.names[cat.byId.get(detailId)];
      main.replaceChildren(...detailBody(detailId));
      if (focusKey) { const el = main.querySelector(`[data-tpkey="${CSS.escape(focusKey)}"]`); if (el) el.focus(); }
      drawBook(detailId);
    }
    function openItem(id) {
      if (!dialog.open) {
        const el = document.activeElement;
        opener = { el, key: el && el.getAttribute ? el.getAttribute('data-tpkey') : null };
      }
      detailId = id;
      if (!book || book.id !== id) { book = null; if (bookCtl) { bookCtl.abort(); bookCtl = null; } }
      $('tp-item-status').textContent = '';
      if (detailCtl) detailCtl.abort();
      detailCtl = new AbortController();
      drawDetail();
      if (!dialog.open) dialog.showModal();
      $('tp-item-title').focus();
      loadPrices([id], detailCtl.signal).then(() => { draw(); drawDetail(); });
      loadItems([id], detailCtl.signal).then(() => drawDetail());
    }
    const shownEl = (el) => (el && el.isConnected && el.getClientRects().length ? el : null);
    dialog.addEventListener('close', () => {
      if (dialog.open) { closingByHash = false; return; }
      const id = detailId;
      detailId = null; book = null; detailEls = null;
      if (detailCtl) { detailCtl.abort(); detailCtl = null; }
      if (bookCtl) { bookCtl.abort(); bookCtl = null; }
      if (!closingByHash && /^#market\/item\//.test(location.hash)) {
        if (history.state && history.state.gw2Item === id) history.back();
        else { try { history.replaceState(null, '', location.pathname + location.search + '#market'); } catch (e) { /* the address keeps it */ } }
      }
      closingByHash = false;
      const o = opener; opener = null;
      const back = o && (shownEl(o.el) || (o.key && shownEl(view.querySelector(`[data-tpkey="${CSS.escape(o.key)}"]`))) || shownEl(view.querySelector(`[data-tpkey="name:${id}"]`)) || $('market-title'));
      if (back && o && o.el !== document.body) back.focus();
    });

    // The calculator's own controls: typing an amount, and choosing how the units are got and given. Nothing here
    // asks ArenaNet for anything.
    dialog.addEventListener('input', (ev) => { if (ev.target && ev.target.id === 'tp-calc-n' && detailId !== null) { calc.text = ev.target.value; drawBook(detailId); } });
    dialog.addEventListener('change', (ev) => {
      const el = ev.target;
      if (!el || el.type !== 'radio' || detailId === null) return;
      if (el.name === 'tp-calc-get') calc.get = el.value === 'order' ? 'order' : 'now';
      else if (el.name === 'tp-calc-give') calc.give = el.value === 'list' ? 'list' : 'now';
      else return;
      drawBook(detailId);
    });

    /** What "#market..." asks for: the list, or one item's details. Called by app.js on every change of the address. */
    function route(hash) {
      const m = /^#market\/item\/(\d{1,9})\/?$/.exec(hash || '');
      if (!m) {
        if (dialog.open) { closingByHash = true; dialog.close(); }
        if (/^#market\/./.test(hash || '')) say('That link to a Trading Post item could not be read. Nothing of yours was changed.');
        return;
      }
      if (!cat) { pendingRoute = hash; return; }
      const id = Number(m[1]);
      if (!cat.byId.has(id)) { if (dialog.open) { closingByHash = true; dialog.close(); } say(`That link names an item that is not in the Trading Post item list (as of ${day.format(Date.parse(cat.asOf))}). Nothing of yours was changed.`); return; }
      openItem(id);
    }
    function say(text) { $('tp-link-notice').hidden = !text; $('tp-link-notice-text').textContent = text; }

    // ---- Controls ----

    function syncControls() {
      $('tp-find').value = st.query;
      $('tp-find-clear').hidden = !st.query;
      $('tp-type').value = String(st.type);
      $('tp-rarity').value = String(st.rarity);
      $('tp-sort').value = st.sort;
      for (const fd of PF_FIELDS) { const el = $(`tp-pf-${fd.key}`); if (el && el.value !== (pfRaw[fd.key] || '')) el.value = pfRaw[fd.key] || ''; }
    }
    let typing = 0;
    $('tp-find').addEventListener('input', (ev) => {
      $('tp-find-clear').hidden = !ev.target.value;
      clearTimeout(typing);
      typing = setTimeout(() => { st.query = ev.target.value; st.shown = PAGE; apply(true); }, 100);
    });
    $('tp-find').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { clearTimeout(typing); st.query = ev.target.value; st.shown = PAGE; apply(true); } });
    const onSelect = (id, key) => $(id).addEventListener('change', (ev) => { st[key] = key === 'sort' ? ev.target.value : Number(ev.target.value); st.shown = PAGE; apply(true); });
    onSelect('tp-type', 'type'); onSelect('tp-rarity', 'rarity'); onSelect('tp-sort', 'sort');

    // A type on the home opens its results at once, as the Type list would; focus goes to the line that names them,
    // beside the way back. No history entry: like every filter, it lives in this tab's memory.
    function pickType(index) {
      clearTimeout(typing);
      Object.assign(st, { query: '', type: index, rarity: -1, favOnly: false, shown: PAGE });
      syncControls();
      apply(true);
      $('tp-crumb').focus();
    }
    // Show all favorites, from the home: the Favorites filter's results, as the Favorites button gives them.
    function pickFavorites() {
      clearTimeout(typing);
      Object.assign(st, { query: '', type: -1, rarity: -1, favOnly: true, shown: PAGE });
      syncControls();
      apply(true);
      $('tp-crumb').focus();
    }
    // Back to the home: nothing typed, no filter, Best match. Focus goes to the Trading Post's heading, at the top.
    function goHome() {
      clearTimeout(typing);
      Object.assign(st, { query: '', type: -1, rarity: -1, favOnly: false, sort: 'relevance', shown: PAGE });
      clearFilters();
      syncControls();
      apply(true);
      $('market-title').focus();
    }
    // The price filters: read as they are typed (after a pause), applied without cancelling anything on its way, and
    // never saved. A field that cannot be read is said and not applied; the others still are.
    let pfTyping = 0;
    function clearFilters() { clearTimeout(pfTyping); for (const k of Object.keys(pfRaw)) delete pfRaw[k]; pf = readFilters(pfRaw, Money); }
    function setFilters() { pf = readFilters(pfRaw, Money); st.shown = PAGE; apply(true, true); }
    function drawFilters(t) {
      const on = searchStatus === 'ok' && Boolean(fcounts) && matches.length > 0;
      const text = !on ? '' : filterText({
        matches: matches.length, passed: fcounts.passed, failed: fcounts.failed, unchecked: fcounts.uncheckedCount,
        loading: fcounts.unchecked.some((i) => pending.has(cat.ids[i])), failedLoad: fcounts.unchecked.some((i) => failed.has(cat.ids[i])),
        listCount: cat.count, filtered: Boolean(st.query.trim()) || filtered(), wholeAll: whole.all,
      }) + ageNote(oldestUsed, t);
      if ($('tp-fscope').textContent !== text) $('tp-fscope').textContent = text;
      $('tp-fscope').hidden = !text;
      const btn = $('tp-pf-toggle'), label = `Price filters${pf.set ? ` (${pf.set} set)` : ''}`;
      if (btn.textContent !== label) btn.textContent = label;
      const errs = pf.errors.map((e) => e.text).join(' ');
      if ($('tp-pf-err').textContent !== errs) $('tp-pf-err').textContent = errs;
      $('tp-pf-err').hidden = !errs;
      if ($('tp-pf-said').textContent !== pf.said) $('tp-pf-said').textContent = pf.said;
      const bad = new Set(pf.errors.flatMap((e) => [e.key, e.also]).filter(Boolean));
      for (const fd of PF_FIELDS) { const el = $(`tp-pf-${fd.key}`); if (bad.has(fd.key)) el.setAttribute('aria-invalid', 'true'); else el.removeAttribute('aria-invalid'); }
      $('tp-pf-clear').hidden = !Object.values(pfRaw).some((v) => String(v || '').trim());
    }
    $('tp-pf-panel').addEventListener('input', (ev) => {
      const k = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-tp-pf');
      if (!k) return;
      pfRaw[k] = ev.target.value;
      clearTimeout(pfTyping);
      pfTyping = setTimeout(setFilters, 300);
    });
    $('tp-pf-panel').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target && ev.target.getAttribute('data-tp-pf')) { clearTimeout(pfTyping); setFilters(); } });

    /** The notes' pills: one panel open at a time; a second press, or Escape inside them, closes it. */
    function pill(btn, open) {
      for (const b of view.querySelectorAll('[data-tp-pill]')) {
        const on = open && b === btn;
        b.setAttribute('aria-expanded', String(on));
        $(b.getAttribute('data-tp-pill')).hidden = !on;
      }
    }
    $('tp-notes').addEventListener('keydown', (ev) => {
      const b = $('tp-notes').querySelector('[data-tp-pill][aria-expanded="true"]');
      if (ev.key === 'Escape' && b) { pill(b, false); b.focus(); }
    });

    view.addEventListener('click', (ev) => {
      const a = ev.target.closest ? ev.target.closest('a[href^="#market/item/"]') : null;
      if (a && !ev.defaultPrevented && ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) {
        const id = Number(a.getAttribute('href').slice('#market/item/'.length));
        if (cat && cat.byId.has(id)) {
          ev.preventDefault();
          try { history.pushState({ gw2Item: id }, '', `#market/item/${id}`); } catch (e) { /* the details still open */ }
          openItem(id);
        }
      }
    });
    document.addEventListener('click', async (ev) => {
      const t = ev.target.closest ? ev.target.closest('button') : null;
      if (!t || !(view.contains(t) || dialog.contains(t))) return;
      const a = (n) => t.getAttribute(n);
      if (a('data-tp-fav')) toggleFav(Number(a('data-tp-fav')));
      else if (t.id === 'tp-find-clear') { $('tp-find').value = ''; st.query = ''; st.shown = PAGE; syncControls(); apply(true); $('tp-find').focus(); }
      else if (t.id === 'tp-pf-toggle') { const open = t.getAttribute('aria-expanded') !== 'true'; t.setAttribute('aria-expanded', String(open)); $('tp-pf-panel').hidden = !open; if (open) $('tp-pf-buyMin').focus(); }
      else if (t.id === 'tp-pf-clear') { clearFilters(); syncControls(); st.shown = PAGE; apply(true, true); $('tp-pf-toggle').focus(); }
      else if (t.id === 'tp-favs') { st.favOnly = !st.favOnly; st.shown = PAGE; apply(true); }
      else if (t.id === 'tp-more') { st.shown += PAGE; draw(); fetchNeeded(false); }
      else if (t.id === 'tp-refresh') { for (const id of visibleIds()) failed.delete(id); lastError = null; fetchNeeded(true, true); }
      else if (t.id === 'tp-retry') { listState = 'idle'; loadList(); }
      else if (t.id === 'tp-whole-btn') { whole.state = 'confirm'; draw(); $('tp-whole-start').focus(); }
      else if (t.id === 'tp-whole-no') { whole.state = whole.ended ? 'done' : 'idle'; draw(); $('tp-whole-btn').focus(); }
      else if (t.id === 'tp-whole-start') startWhole();
      else if (t.id === 'tp-whole-cancel') { if (wholeCtl) wholeCtl.abort(); }
      else if (a('data-tp-cat')) pickType(Number(a('data-tp-cat')));
      else if (t.id === 'tp-home-btn') goHome();
      else if (t.id === 'tp-watch-refresh' || t.id === 'tp-favhome-refresh') { for (const id of homeIds()) failed.delete(id); lastError = null; loadWatch(true); }
      else if (t.id === 'tp-gem-refresh') { gemFailed.coins = gemFailed.gems = null; loadGems(true); }
      else if (t.id === 'tp-favhome-all') pickFavorites();
      else if (a('data-tp-pill')) pill(t, a('aria-expanded') !== 'true');
      else if (t.id === 'tp-link-notice-dismiss') { say(''); try { history.replaceState(null, '', location.pathname + location.search + '#market'); } catch (e) { /* kept */ } }
      else if (a('data-tp-calc-n')) { calc.chip = Number(a('data-tp-calc-n')); calc.text = ''; const f = $('tp-calc-n'); if (f) f.value = ''; drawBook(detailId); }
      else if (a('data-tp-book')) loadBook(Number(a('data-tp-book')));
      else if (a('data-tp-refresh-one')) { const id = Number(a('data-tp-refresh-one')); failed.delete(id); loadPrices([id], detailCtl ? detailCtl.signal : undefined, undefined, true).then(() => { draw(); drawDetail(); }); drawDetail(); }
      else if (a('data-tp-copy')) { const ok = await copyText(a('data-tp-copy')); $('tp-item-status').textContent = ok ? `Copied ${a('data-tp-copy')}. Paste it in game chat.` : `Copy did not work here. The code is ${a('data-tp-copy')}`; }
      else if (a('data-tp-link')) { const url = `${canonical}#market/item/${a('data-tp-link')}`; const ok = await copyText(url); $('tp-item-status').textContent = ok ? 'Copied the link to this item.' : `Copy did not work here. The link is ${url}`; }
    });

    // Back on screen after a while away: the shown prices are refreshed if they are no longer current.
    function shown() {
      if (listState === 'idle' || listState === 'failed') { loadList(); return; }
      if (!cat || view.hidden) return;
      const t = now(), ids = visibleIds();
      if (ids.some((id) => { const c = cache.get(id); return c && t - c.at >= CURRENT_MS; })) fetchNeeded(false);
      loadWatch(false); // on the home: only what is not current, so nothing when it all is
      draw();
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !view.hidden) shown(); });
    // The age words ("12 minutes ago") and each row's stale or old mark follow the clock while the Trading Post is
    // on screen. Rows are updated in place, not redrawn, so focus and the reading position stay put.
    function tick() {
      const t = now();
      drawPrices(order.slice(0, st.shown), t);
      if (fcounts) drawFilters(t);
      if (searchStatus === 'idle') { priceLine(watchIds(cat), t, WATCH_LINE); if (favHome(favs).length) priceLine(favHome(favs), t, FAVHOME_LINE); gemLine(t); }
      for (const li of [...$('tp-results').children, ...$('tp-watch-list').children, ...$('tp-favhome-list').children]) {
        const id = Number(li.getAttribute('data-id')), i = cat.byId.get(id);
        if (i === undefined) continue;
        const base = li.classList.contains('tp-watch-card') ? 'tp-watch-card' : 'tp-row';
        const result = base === 'tp-row';
        const note = result ? resultNote(i, id, t) : rowNote(id, t), cls = rowClass(cat.rarities[cat.rarity[i]], note.age, base) + (result && uncheckedSet.has(i) ? ' is-unchecked' : ''), el = li.querySelector('.tp-note');
        if (li.className !== cls) li.className = cls;
        if (el && el.textContent !== note.text) { el.textContent = note.text; el.hidden = !note.text; }
      }
      if (dialog.open) drawDetail();
    }
    setInterval(() => { if (cat && !view.hidden && document.visibilityState === 'visible') tick(); }, 30000);

    syncControls();
    return {
      route, shown,
      /** For the browser checks: what this tab holds, never the reader's data beyond favorites. */
      debug: () => ({ listState, home: searchStatus === 'idle', query: st.query, type: st.type, rarity: st.rarity, sort: st.sort, favOnly: st.favOnly, shown: st.shown, matches: matches.length, pf: Object.assign({}, pf.filters), pfSet: pf.set, pfCounts: fcounts ? { passed: fcounts.passed, failed: fcounts.failed, unchecked: fcounts.uncheckedCount } : null, cached: cache.size, whole: Object.assign({}, whole), stats: client.stats() }),
    };
  }

  const Market = { LIST_URL, PAGE, SORT_CAP, CURRENT_MS, OLD_MS, REUSE_MIN, receivedText, CALC_CHIPS, BOOK_ROWS, BOOK_MOST, readAmount, PF_FIELDS, readFilters, filterText, ageNote, FAV_KEY, FAV_MAX, SORTS, TYPE_LABEL, TYPE_ICON, WATCH, FAV_HOME, GEM_GOLD, GEM_GEMS, typeLabel, watchIds, favHome, lostFavorites, typeTiles, crumbText, sanitizeFavorites, freshness, scopeText, listFailure, mount };
  if (typeof module === 'object' && module.exports) module.exports = Market;
  else root.GW2Market = Market;
})(typeof globalThis !== 'undefined' ? globalThis : this);
