// The Trading Post mode: search the item list, see each item's highest buy order and lowest sell listing from
// ArenaNet's API, sort, compare, keep favorites, open an item's details. Loaded by app.js the first time the
// Trading Post is opened, after js/money.js, js/catalog.js and js/api.js; never with the timer.
//
// What it promises, and the code keeps:
// - Prices come only from the API, with the time they were fetched. When the API does not answer, no price is
//   shown and nothing is estimated; an older price stays, with its time and its age in words.
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
  /** Prices are current under 5 minutes old, stale up to an hour, then old (decision D3). */
  const CURRENT_MS = 5 * 60000;
  const OLD_MS = 60 * 60000;
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
    return parts.length ? parts.join(' · ') : 'Every item';
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

  /** 'current', 'stale' or 'old' for a price fetched at `at` (local ms), seen at `now`. */
  const freshness = (at, now) => (now - at < CURRENT_MS ? 'current' : now - at < OLD_MS ? 'stale' : 'old');
  const ago = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m < 1 ? 'just now' : m === 1 ? '1 minute ago' : m < 120 ? `${m} minutes ago` : `${Math.floor(m / 60)} hours ago`; };
  const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

  /**
   * What a sort covers, in words. s: { sort, matches, ranked, noSide, unpriced, loading, failed, wholeAll,
   * listCount, filtered }. A price sort over only some matches says so; only a load of the whole market that
   * priced every match makes it "all", and only with no search and no filter is that the whole market.
   */
  function scopeText(s) {
    const sort = SORTS[s.sort];
    if (!sort || !sort.key) return s.sort === 'name' ? 'Sorted by name.' : 'Best matches first, then by name.';
    const head = `Ranked by ${sort.what}, ${sort.how}`;
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
    let book = null;

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
    const sortDef = () => SORTS[st.sort];

    /** Recomputes what matches and its order; with `fetch`, asks for the prices and icons that are needed. */
    function apply(fetch) {
      if (!cat) return;
      const r = Catalog.search(cat, { query: st.query, type: st.type, rarity: st.rarity, only: st.favOnly ? new Set(favs) : null, sort: st.sort === 'name' ? 'name' : 'relevance' });
      // A price sort with nothing typed and no filter ranks the whole list: across the whole market once
      // every price is loaded, otherwise among the loaded ones, and the scope line says which.
      const s = sortDef();
      if (r.status === 'idle' && s && s.key) { searchStatus = 'ok'; matches = cat.order.slice(); }
      else { searchStatus = r.status; matches = r.indexes; }
      resort();
      draw();
      if (fetch) fetchNeeded(true);
    }
    function resort() {
      const s = sortDef();
      if (s && s.key) { const p = Catalog.priceSort(cat, matches, s.key, s.dir, quoteOf); order = p.order; counts = p; }
      else { order = matches; counts = null; }
    }
    const visibleIds = () => order.slice(0, st.shown).map((i) => cat.ids[i]);

    /** Prices and icons for what is shown, and for a price sort every match up to SORT_CAP. `force` asks again for the shown prices even when they are current (Refresh). */
    function fetchNeeded(restart, force) {
      if (!cat) return;
      if (restart && viewCtl) viewCtl.abort();
      if (restart || !viewCtl || viewCtl.signal.aborted) viewCtl = new AbortController();
      const ids = visibleIds();
      // Under a price sort, newly loaded prices join the ranking at once, so the order shown is always the
      // ranking of every loaded price, as the scope line says.
      loadPrices(ids, viewCtl.signal, undefined, force).then(() => { const s = sortDef(); if (s && s.key) resort(); draw(); });
      loadItems(ids, viewCtl.signal);
      const s = sortDef();
      if (restart && sortCtl) { sortCtl.abort(); sortCtl = null; }
      if (s && s.key && matches.length <= SORT_CAP) {
        const all = matches.map((i) => cat.ids[i]);
        if (all.some((id) => !cache.has(id) && !failed.has(id))) {
          if (!sortCtl) sortCtl = new AbortController();
          const sig = sortCtl.signal;
          loadPrices(all, sig).then(() => { if (sig.aborted) return; resort(); draw(); loadItems(visibleIds(), viewCtl.signal); });
        }
      }
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
      loadPrices(ids, watchCtl.signal, undefined, force).then((r) => { if (!r) return; const s = sortDef(); if (s && s.key) resort(); draw(); });
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

    // A price keeps the time it was fetched until a new one replaces it: a forced refresh never touches it, so the
    // page can always say how old what it shows is.
    async function loadPrices(ids, signal, onBatch, force) {
      const t = now();
      const need = ids.filter((id) => { const c = cache.get(id); return (force || !c || t - c.at >= CURRENT_MS) && !live(pending, id); });
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
        return { age: f, text: f === 'current' ? (why ? again.trim() : '') : `${f === 'stale' ? 'Stale' : 'Old'} price, fetched ${ago(t - c.at)}.${again}` };
      }
      if (c && c.none) return { age: '', text: '' };
      if (pending.has(id)) return { age: '', text: client.paused() ? "Waiting: ArenaNet's API asked for fewer requests (HTTP 429)." : '' };
      if (why) return { age: '', text: `No price: ${API_SAYS[why] || API_SAYS.network}.` };
      return { age: '', text: '' };
    }
    const rowClass = (rar, age, base) => `${base || 'tp-row'} rarity-${rar.toLowerCase()}${age === 'stale' ? ' is-stale' : age === 'old' ? ' is-old' : ''}`;

    function row(i) {
      const id = cat.ids[i], name = cat.names[i], rar = cat.rarities[cat.rarity[i]], it = items.get(id);
      const on = favs.includes(id), lv = cat.level[i];
      const note = rowNote(id, now());
      return h('li', { class: rowClass(rar, note.age), 'data-id': id },
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
      if (!home) $('tp-crumb').textContent = crumbText(st, cat);
      else { drawWatch(t); drawFavHome(t); drawGems(t); }
      const empty = $('tp-empty');
      empty.hidden = home || (searchStatus === 'ok' && matches.length > 0);
      empty.textContent = searchStatus === 'short' ? 'Type at least 2 letters, or choose a type, a rarity or Favorites.'
          : st.favOnly && !favs.length ? 'No favorites yet. Use the star (☆) by an item to add it.'
            : 'No item in the list matches. The list holds only items with a Trading Post price when it was made.';
      $('tp-head').hidden = !list.length;
      const more = $('tp-more'), left = order.length - list.length;
      more.hidden = left <= 0;
      more.textContent = `Show ${Math.min(PAGE, left)} more (${list.length.toLocaleString('en-US')} of ${order.length.toLocaleString('en-US')} shown)`;
      drawCount();
      // The sort's coverage, right under the sort.
      const s = sortDef();
      $('tp-scope').textContent = searchStatus !== 'ok' || !matches.length ? '' : scopeText({
        sort: st.sort, matches: matches.length, ranked: counts ? counts.ranked : 0, noSide: counts ? counts.noSide : 0, unpriced: counts ? counts.unpriced : 0,
        loading: s && s.key ? matches.some((i) => pending.has(cat.ids[i])) : false,
        failed: s && s.key ? matches.some((i) => failed.has(cat.ids[i])) : false,
        wholeAll: whole.all, listCount: cat.count, filtered: Boolean(st.query.trim()) || filtered(),
      });
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
        parts.push(f === 'current' ? `Rates from ${when}, current.` : `Rates from ${when}, ${ago(t - oldest)}: ${f}.${again}`);
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
        parts.push(f === 'current' ? `Prices from ${when}, current.` : f === 'stale' ? `Prices from ${when}, ${ago(t - oldest)}: stale.${again}`
          : `Prices from ${when}, ${ago(t - oldest)}: old, shown faded.${again}`);
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
      const none = (text) => h('span', { class: 'tp-none', text });
      const on = favs.includes(id);
      const icon = iconOf(it, 48, 'tp-big-icon');
      const sub = it && it.details && typeof it.details.type === 'string' ? ` (${it.details.type.replace(/([a-z])([A-Z])/g, '$1 $2')})` : '';
      const prices = [];
      // The three figures a trader looks for first, large, with when they were fetched; the arithmetic and the
      // caveats follow in the list below them, smaller.
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
          h('p', { class: `tp-stat-when${f === 'current' ? '' : ' is-' + f}`, text: `Prices fetched ${time.format(c.at)}, ${ago(t - c.at)} (${f}). ArenaNet's API may itself be up to 2 minutes behind.${why ? ` A newer price could not be loaded: ${API_SAYS[why] || API_SAYS.network}.` : ''}` }));
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
          chat ? h('button', { type: 'button', class: 'btn small', 'data-tp-copy': chat, 'data-tpkey': 'dlg:chat', 'aria-label': `Copy the chat code for ${name}: ${chat}`, text: 'Copy chat code' }) : null,
          h('button', { type: 'button', class: 'btn small', 'data-tp-link': id, 'data-tpkey': 'dlg:link', 'aria-label': `Copy a link to ${name}`, text: 'Copy link' }),
          h('a', { class: 'btn small', href: `https://wiki.guildwars2.com/wiki/Special:Search/${encodeURIComponent(name)}`, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${name} on the Guild Wars 2 Wiki (opens a new tab)`, text: 'Wiki' })),
        h('dl', { class: 'ed-facts tp-facts' }, ...prices, ...(vendor ? fact('Merchant', ...[].concat(vendor)) : []), ...fact('Item id', String(id)), ...(chat ? fact('Chat code', chat) : [])),
        drawBook(id),
        h('p', { class: 'tp-fee-note', text: `Estimates for one unit. Fees as ArenaNet documents them: a ${Money.LISTING_PCT}% listing fee and a ${Money.EXCHANGE_PCT}% exchange fee, each at least 1 copper; how a fraction of a copper is rounded is not published, so this page rounds to the nearest copper.` }),
      ].filter(Boolean);
    }
    function drawBook(id) {
      const wrap = h('div', { class: 'tp-book' });
      if (!book || book.id !== id) { wrap.append(h('button', { type: 'button', class: 'btn small', 'data-tp-book': id, 'data-tpkey': 'dlg:book', text: 'Show the order book' })); return wrap; }
      if (book.state === 'loading') { wrap.append(h('p', { class: 'tp-none', text: 'Loading the order book...' })); return wrap; }
      if (book.state === 'failed') { wrap.append(h('p', { text: `${API_SAYS[book.error] || API_SAYS.network}. The order book is not shown.` }), h('button', { type: 'button', class: 'btn small', 'data-tp-book': id, 'data-tpkey': 'dlg:book', text: 'Try again' })); return wrap; }
      if (book.state === 'none') { wrap.append(h('p', { text: 'The API has no order book for this item now.' })); return wrap; }
      const table = (rows, cap, unitWord) => h('table', { class: 'tp-book-table' }, h('caption', { text: cap }),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Price each' }), h('th', { scope: 'col', text: unitWord }), h('th', { scope: 'col', text: 'Orders' }))),
        h('tbody', {}, ...(rows.length ? rows.slice(0, 5).map((r) => h('tr', {}, h('td', {}, coins(r.unit_price)), h('td', { text: Money.count(r.quantity) }), h('td', { text: Money.count(r.listings) }))) : [h('tr', {}, h('td', { colspan: 3, text: 'None.' }))])));
      wrap.append(h('h3', { text: 'Order book (best 5 prices each side)' }),
        h('div', { class: 'tp-book-sides' }, table(book.buys, 'Buy orders, highest first', 'Units wanted'), table(book.sells, 'Sell listings, lowest first', 'Units listed')),
        h('p', { class: 'tp-none', text: `Fetched ${time.format(book.at)}. ArenaNet's API keeps the order book for up to 20 minutes, so it can be older than the prices above.` }));
      return wrap;
    }
    async function loadBook(id) {
      if (detailCtl) detailCtl.abort();
      detailCtl = new AbortController();
      book = { id, state: 'loading' };
      drawDetail();
      const r = await client.listings(id, { signal: detailCtl.signal });
      if (!book || book.id !== id) return;
      if (!r.ok) { if (r.error === 'aborted') return; book = { id, state: 'failed', error: r.error }; }
      else if (r.notFound) book = { id, state: 'none' };
      else book = { id, state: 'ok', buys: r.book.buys, sells: r.book.sells, at: r.book.at };
      drawDetail();
    }
    function drawDetail() {
      if (detailId === null) return;
      const focusKey = dialog.contains(document.activeElement) && document.activeElement.getAttribute('data-tpkey');
      $('tp-item-title').textContent = cat.names[cat.byId.get(detailId)];
      $('tp-item-body').replaceChildren(...detailBody(detailId));
      if (focusKey) { const el = dialog.querySelector(`[data-tpkey="${CSS.escape(focusKey)}"]`); if (el) el.focus(); }
    }
    function openItem(id) {
      if (!dialog.open) {
        const el = document.activeElement;
        opener = { el, key: el && el.getAttribute ? el.getAttribute('data-tpkey') : null };
      }
      detailId = id;
      if (!book || book.id !== id) book = null;
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
      detailId = null; book = null;
      if (detailCtl) { detailCtl.abort(); detailCtl = null; }
      if (!closingByHash && /^#market\/item\//.test(location.hash)) {
        if (history.state && history.state.gw2Item === id) history.back();
        else { try { history.replaceState(null, '', location.pathname + location.search + '#market'); } catch (e) { /* the address keeps it */ } }
      }
      closingByHash = false;
      const o = opener; opener = null;
      const back = o && (shownEl(o.el) || (o.key && shownEl(view.querySelector(`[data-tpkey="${CSS.escape(o.key)}"]`))) || shownEl(view.querySelector(`[data-tpkey="name:${id}"]`)) || $('market-title'));
      if (back && o && o.el !== document.body) back.focus();
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
      syncControls();
      apply(true);
      $('market-title').focus();
    }
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
      if (searchStatus === 'idle') { priceLine(watchIds(cat), t, WATCH_LINE); if (favHome(favs).length) priceLine(favHome(favs), t, FAVHOME_LINE); gemLine(t); }
      for (const li of [...$('tp-results').children, ...$('tp-watch-list').children, ...$('tp-favhome-list').children]) {
        const id = Number(li.getAttribute('data-id')), i = cat.byId.get(id);
        if (i === undefined) continue;
        const base = li.classList.contains('tp-watch-card') ? 'tp-watch-card' : 'tp-row';
        const note = rowNote(id, t), cls = rowClass(cat.rarities[cat.rarity[i]], note.age, base), el = li.querySelector('.tp-note');
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
      debug: () => ({ listState, home: searchStatus === 'idle', query: st.query, type: st.type, rarity: st.rarity, sort: st.sort, favOnly: st.favOnly, shown: st.shown, matches: matches.length, cached: cache.size, whole: Object.assign({}, whole), stats: client.stats() }),
    };
  }

  const Market = { LIST_URL, PAGE, SORT_CAP, CURRENT_MS, OLD_MS, FAV_KEY, FAV_MAX, SORTS, TYPE_LABEL, TYPE_ICON, WATCH, FAV_HOME, GEM_GOLD, GEM_GEMS, typeLabel, watchIds, favHome, lostFavorites, typeTiles, crumbText, sanitizeFavorites, freshness, scopeText, listFailure, mount };
  if (typeof module === 'object' && module.exports) module.exports = Market;
  else root.GW2Market = Market;
})(typeof globalThis !== 'undefined' ? globalThis : this);
