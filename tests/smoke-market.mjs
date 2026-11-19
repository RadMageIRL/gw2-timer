// Browser checks for v0.4.0 Phase C: the two modes (Event Timers and Trading Post) and the Trading Post itself.
// Run by tests/smoke.mjs, in the same Chrome, with its helpers. Every API answer comes from here: real answers
// cut from the Phase A snapshot (tests/fixtures/tp-sample.json) for a few items, and made-up but fixed prices
// for every other item, so nothing depends on ArenaNet's servers and every run sees the same numbers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** A made-up but fixed quote for an item outside the sample: some have no buy orders, a few no sell listings. */
export function synthPrice(id) {
  const h = Math.imul(id, 2654435761) >>> 0;
  const buy = (h % 400000) + 3, gap = ((h >>> 9) % 20000) + 1;
  const noBuy = id % 23 === 0, noSell = id % 97 === 0;
  return {
    id, whitelisted: id % 5 === 0,
    buys: noBuy ? { quantity: 0, unit_price: 0 } : { quantity: (h % 9000) + 1, unit_price: buy },
    sells: noSell ? { quantity: 0, unit_price: 0 } : { quantity: ((h >>> 3) % 9000) + 1, unit_price: buy + gap },
  };
}

export function marketChecks(h) {
  const { check, open, click, text, key, settle, sleep, utc, unexpected, lowContrast, BASE, ROOT, DIR, SHOTS } = h;
  const SAMPLE = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'tp-sample.json'), 'utf8'));
  const Catalog = require(join(DIR, 'js', 'catalog.js'));
  const Money = require(join(DIR, 'js', 'money.js'));
  const CAT = Catalog.parse(readFileSync(join(DIR, 'data', 'tp-items.json'), 'utf8')).catalog;
  const PRICE = new Map(SAMPLE.prices.map((p) => [p.id, p]));
  const ITEM = new Map(SAMPLE.items.map((i) => [i.id, i]));
  const BOOK = new Map(SAMPLE.listings.map((l) => [l.id, l]));
  const priceOf = (id) => PRICE.get(id) || synthPrice(id);
  const FAV = 'gw2-timer:v1:tp-favorites';
  // The committed list's own figures (its count, the requests a whole-market load takes, its date), so a reviewed
  // refresh of the list needs no check rewritten.
  const COUNT = CAT.count.toLocaleString('en-US'), REQS = Math.ceil(CAT.count / 200);
  const ASOF = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(CAT.asOf));
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const AT = utc('2026-11-15T13:00:00Z');
  // Problems a check may provoke on purpose: refused requests show up as failed loads.
  const NET = [/^failed: net::ERR_/, /^HTTP (429|500|503|400) https:\/\/api\.guildwars2\.com/, /^log: Failed to load resource/, /^log: Access to fetch at 'https:\/\/api\.guildwars2\.com\/.* has been blocked by CORS policy/];

  /**
   * The API as this page sees it. opts.answer(n, url) can return 'ok', 'offline', 'hold', 'no-cors-429', or an
   * HTTP status, for the n-th request (from 1); opts.delay holds each answer that many ms (opts.delayFor(url), one answer its own time). opts.prices (id -> row)
   * replaces an item's prices; opts.mangle(rows) may spoil the rows of a prices answer. opts.books (id -> order book) and
   * opts.bookFor(id) (a book, or nothing) replace an item's order book.
   */
  function api(opts = {}) {
    return async (page, p) => {
      const url = new URL(p.request.url), n = page.apiRequests.length;
      // What each request carried (v0.5.0 Phase 3): its method and headers, so a check can show none asks past the browser's cache.
      (page.apiSent = page.apiSent || []).push({ url: p.request.url, method: p.request.method, headers: p.request.headers || {} });
      page.apiLive = (page.apiLive || 0) + 1;
      page.apiMaxLive = Math.max(page.apiMaxLive || 0, page.apiLive);
      try {
        const how = opts.answer ? opts.answer(n, url) : 'ok';
        const wait = opts.delayFor ? opts.delayFor(url) : opts.delay;
        if (wait) await sleep(wait);
        if (how === 'hold') return;
        if (how === 'offline') { await page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' }).catch(() => {}); return; }
        // A request the page has cancelled meanwhile can no longer be answered: that is fine.
        const send = (status, body, cors = true) => page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: status, body: Buffer.from(JSON.stringify(body)).toString('base64'),
          responseHeaders: [{ name: 'Content-Type', value: 'application/json; charset=utf-8' }, ...(cors ? [{ name: 'Access-Control-Allow-Origin', value: '*' }] : [])] }).catch(() => { page.apiGone = (page.apiGone || 0) + 1; });
        if (how === 'no-cors-429') { await send(429, { text: 'too many requests' }, false); return; }
        if (typeof how === 'number') { await send(how, { text: 'error' }); return; }
        const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean).map(Number);
        const missing = opts.missing || new Set();
        if (url.pathname === '/v2/commerce/prices') {
          let rows = ids.filter((id) => !missing.has(id) && CAT.byId.has(id)).map((id) => (opts.prices && opts.prices.get(id)) || priceOf(id));
          if (opts.mangle) rows = opts.mangle(rows);
          if (!rows.length) await send(404, { text: 'all ids provided are invalid' }); else await send(rows.length < ids.length ? 206 : 200, rows);
        } else if (url.pathname === '/v2/items') {
          const rows = ids.filter((id) => CAT.byId.has(id)).map((id) => ITEM.get(id) || { id, name: CAT.names[CAT.byId.get(id)], description: '', type: CAT.types[CAT.type[CAT.byId.get(id)]], rarity: CAT.rarities[CAT.rarity[CAT.byId.get(id)]], level: 0, vendor_value: 10, flags: [], chat_link: '[&AgEAAAAA]', icon: `https://render.guildwars2.com/file/0000/${id}.png` });
          await send(rows.length < ids.length ? 206 : 200, rows);
        } else if (url.pathname === '/v2/commerce/listings') {
          const bid = Number(url.searchParams.get('id'));
          const b = (opts.bookFor && opts.bookFor(bid)) || (opts.books && opts.books.get(bid)) || BOOK.get(bid);
          if (b) await send(200, b); else await send(404, { text: 'no such id' });
        } else if (url.pathname === '/v2/commerce/exchange/coins') {
          await send(200, { coins_per_gem: 4444, quantity: Math.floor(Number(url.searchParams.get('quantity')) / 4444) });
        } else if (url.pathname === '/v2/commerce/exchange/gems') {
          await send(200, { coins_per_gem: 2993, quantity: Number(url.searchParams.get('quantity')) * 2993 });
        } else await send(404, { text: 'not found' });
      } finally { page.apiLive--; }
    };
  }

  const market = (page) => page.waitFor("!document.getElementById('tp-app').hidden && document.getElementById('tp-boot').hidden");
  const typeTp = async (page, t) => {
    await page.eval(`(() => { const i = document.getElementById('tp-find'); i.focus(); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(250);
  };
  const shownIds = (page) => page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((r) => Number(r.dataset.id))");
  const rowsText = (page) => page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((r) => r.innerText.replace(/\\s+/g, ' ').trim())");
  const select = (page, id, value) => page.eval(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const idle = (page) => page.waitFor("!document.querySelector('#tp-results[aria-busy=\"true\"]') && !/Loading/.test(document.getElementById('tp-scope').textContent)", 15000);
  const MARKET_CODE = /\/(js\/(money|catalog|api|market)\.js|data\/tp-items\.json)/;
  // The home's Market Watch: its eight ids, and its requests (prices and item records ask for exactly those ids, sorted).
  const Market = require(join(DIR, 'js', 'market.js'));
  const WATCH = Market.watchIds(CAT), WATCH_Q = [...WATCH].sort((a, b) => a - b).join(',');
  const isWatch = (u) => new URL(u).searchParams.get('ids') === WATCH_Q;
  // The home's other requests: the gem exchange's two quotes. isHome: anything the home asks for with no favorites.
  const isGem = (u) => /\/v2\/commerce\/exchange\/(coins|gems)\?/.test(u);
  const isHome = (u) => isWatch(u) || isGem(u);
  const asked = (page) => page.apiRequests.map((u) => { const x = new URL(u); return `${x.pathname} ${x.searchParams.get('ids') || `quantity=${x.searchParams.get('quantity')}`}`; }).sort();
  const HOME_ASKED = [`/v2/commerce/exchange/coins quantity=1000000`, `/v2/commerce/exchange/gems quantity=400`, `/v2/commerce/prices ${WATCH_Q}`, `/v2/items ${WATCH_Q}`];
  const watchReady = (page) => page.waitFor("/current\\./.test(document.getElementById('tp-watch-text').textContent) && document.querySelectorAll('#tp-watch-list .tp-icon img').length === 8 && /current\\./.test(document.getElementById('tp-gem-text').textContent)", 15000);
  const later = (page, ms) => page.eval(`(() => { const prev = Date.now; Date.now = () => prev() + ${ms}; })()`);

  // ---- The two modes ----

  check('Modes: the timer\'s first load asks the API for nothing and loads no Trading Post code or item list; Event Timers is pressed', async () => {
    const page = await open({ at: AT, api: api() });
    try {
      await sleep(1500);
      assert.deepEqual(page.apiRequests, [], 'no API request');
      assert.equal(page.iconRequests, 0, 'no icon');
      assert.deepEqual(page.requests.filter((u) => MARKET_CODE.test(u)), [], 'no Trading Post code or list');
      const s = await page.eval("({ pressed: [...document.querySelectorAll('[data-mode]')].map((b) => b.dataset.mode + ':' + b.getAttribute('aria-pressed')), timers: document.getElementById('timers-view').hidden, market: document.getElementById('market-view').hidden, label: document.querySelector('.mode-switch').getAttribute('aria-label'), role: document.querySelector('.mode-switch').getAttribute('role'), names: [...document.querySelectorAll('[data-mode]')].map((b) => b.textContent), hash: location.hash, skip: [...document.querySelectorAll('.skip')].filter((a) => !a.hidden).map((a) => a.textContent) })");
      assert.deepEqual(s, { pressed: ['timers:true', 'market:false'], timers: false, market: true, label: 'Mode', role: 'group', names: ['Event Timers', 'Trading Post'], hash: '', skip: ['Skip to Scheduled now', 'Skip to Coming up'] });
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Modes: switching to the Trading Post loads it once, without reloading; switching back and forth keeps each mode\'s search, filters, sort and place', async () => {
    const page = await open({ at: AT, api: api() });
    try {
      await page.eval('window.__same = 1');
      await page.eval("(() => { const i = document.getElementById('find'); i.focus(); i.value = 'jungle'; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await click(page, '[data-filter="world-boss"]');
      await sleep(400);
      await page.eval('window.scrollTo(0, 400)');
      const timersY = await page.eval('scrollY');
      await click(page, '[data-mode="market"]');
      await market(page);
      assert.equal(await page.eval('location.hash'), '#market');
      assert.equal(await page.eval('window.__same'), 1, 'the page did not reload');
      assert.deepEqual(await page.eval("[document.getElementById('timers-view').hidden, document.getElementById('market-view').hidden, document.querySelector('button[data-mode=\"market\"]').getAttribute('aria-pressed'), document.querySelector('button[data-mode=\"timers\"]').getAttribute('aria-pressed')]"),
        [true, false, 'true', 'false'], 'one view at a time, and the switch says which');
      await typeTp(page, 'glob');
      await select(page, 'tp-sort', 'sell-desc');
      await idle(page);
      const before = await shownIds(page);
      assert.ok(before.length > 0, 'results');
      await page.eval('window.scrollTo(0, 200)');
      const marketY = await page.eval('scrollY');
      await click(page, '[data-mode="timers"]');
      await settle();
      const t = await page.eval("({ find: document.getElementById('find').value, filter: document.querySelector('[data-filter][aria-pressed=\"true\"]').dataset.filter, y: scrollY, hidden: document.getElementById('market-view').hidden, hash: location.hash })");
      assert.deepEqual(t, { find: 'jungle', filter: 'world-boss', y: timersY, hidden: true, hash: '' });
      assert.deepEqual(await page.eval("[...document.querySelectorAll('.skip')].filter((a) => !a.hidden).map((a) => a.textContent)"), ['Skip to Scheduled now', 'Skip to Coming up'], 'the timer\'s skip links again');
      const clock1 = await text(page, '#local-time'); await sleep(1100);
      assert.notEqual(await text(page, '#local-time'), clock1, 'the timer keeps ticking');
      await click(page, '[data-mode="market"]');
      await settle();
      const m = await page.eval("({ q: document.getElementById('tp-find').value, sort: document.getElementById('tp-sort').value, y: scrollY })");
      assert.deepEqual(m, { q: 'glob', sort: 'sell-desc', y: marketY });
      assert.deepEqual(await page.eval("[...document.querySelectorAll('.skip')].filter((a) => !a.hidden).map((a) => a.textContent)"), ['Skip to the item search'], 'the skip links follow the mode');
      // The skip link keeps the Trading Post: its target is in this view.
      await page.eval("document.querySelector('.skip[data-skip=\"market\"]').click()"); await settle();
      assert.deepEqual(await page.eval("[location.hash, document.getElementById('market-view').hidden, document.activeElement.id]"), ['#tp-find', false, 'tp-find']);
      await page.eval('history.back()'); await settle();
      assert.deepEqual(await shownIds(page), before, 'the same results');
      assert.equal(page.requests.filter((u) => /js\/market\.js/.test(u)).length, 1, 'market.js loaded once');
      assert.equal(page.requests.filter((u) => /tp-items\.json/.test(u)).length, 1, 'the item list loaded once');
      assert.equal(await page.eval("document.querySelectorAll('script[src*=\"market.js\"]').length"), 1);
      assert.equal(await page.eval('window.__same'), 1, 'still the same page');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Modes: #market opens the Trading Post directly; Back and Forward move between the modes; event links still open over either mode', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      assert.equal(await page.eval("document.querySelector('[data-mode=\"market\"]').getAttribute('aria-pressed')"), 'true');
      assert.equal(await page.eval("document.getElementById('timers-view').hidden"), true);
      await click(page, '[data-mode="timers"]'); await settle();
      assert.deepEqual(await page.eval('[location.hash, document.getElementById("timers-view").hidden]'), ['', false]);
      await page.eval('history.back()'); await sleep(400);
      assert.deepEqual(await page.eval('[location.hash, document.getElementById("market-view").hidden, document.querySelector(\'[data-mode="market"]\').getAttribute("aria-pressed")]'), ['#market', false, 'true'], 'Back to the Trading Post');
      await page.eval('history.forward()'); await sleep(400);
      assert.deepEqual(await page.eval('[location.hash, document.getElementById("timers-view").hidden]'), ['', false], 'Forward to Event Timers');
      // An event's details from a name, over Event Timers: Back closes them.
      await click(page, '#next-list .row a.event-link'); await settle();
      assert.equal(await page.eval("document.getElementById('event-dialog').open"), true);
      assert.match(await page.eval('location.hash'), /^#event\//);
      await page.eval('history.back()'); await sleep(400);
      assert.deepEqual(await page.eval('[document.getElementById("event-dialog").open, location.hash]'), [false, '']);
      // Over the Trading Post: a link to an event opens its details there, and closing leaves the Trading Post.
      await page.eval('history.back()'); await sleep(400);
      assert.equal(await page.eval('location.hash'), '#market');
      await page.eval("location.hash = '#event/tequatl-the-sunless'"); await sleep(400);
      assert.deepEqual(await page.eval('[document.getElementById("event-dialog").open, document.getElementById("market-view").hidden]'), [true, false], 'details over the Trading Post');
      await page.eval("document.querySelector('#event-dialog [data-close]').click()"); await sleep(400);
      assert.deepEqual(await page.eval('[location.hash, document.getElementById("market-view").hidden]'), ['#market', false], 'closing keeps the Trading Post');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  // ---- The home: Market Watch and the types (post-v0.4.0 polish) ----

  check('Trading Post home: #market opens the home: Market Watch\'s eight hand-picked items with prices from one request and icons from one more, and the item list\'s types with their counts; never called a ranking; current prices are not asked for again', async () => {
    // The prices arrive last (after the icons and the gem rates), so only the redraw that follows them can show them.
    const page = await open({ at: AT, api: api({ delayFor: (u) => (/commerce\/prices/.test(u.pathname) ? 700 : 0) }), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await watchReady(page);
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-crumbs').hidden, document.getElementById('tp-empty').hidden, document.getElementById('tp-head').hidden, document.querySelectorAll('#tp-results li').length, GW2Market && true]"),
        [false, true, true, true, 0, true], 'the home, and no results');
      const cards = await page.eval(`[...document.querySelectorAll('#tp-watch-list .tp-watch-card')].map((li) => ({ id: Number(li.dataset.id), name: li.querySelector('a.tp-name').textContent, href: li.querySelector('a.tp-name').getAttribute('href'),
        buy: li.querySelector('.tp-buy .coins .sr-only').textContent, sell: li.querySelector('.tp-sell .coins .sr-only').textContent, icon: Boolean(li.querySelector('.tp-icon img')), note: li.querySelector('.tp-note').hidden }))`);
      assert.deepEqual(cards.map((c) => c.id), [19976, 19721, 68063, 24277, 24295, 19701, 19725, 19746]);
      for (const c of cards) {
        const q = quoteOf(c.id);
        assert.deepEqual([c.name, c.href, c.buy, c.sell, c.icon, c.note], [CAT.names[CAT.byId.get(c.id)], `#market/item/${c.id}`, Money.coins(q.buy).spoken, Money.coins(q.sell).spoken, true, true], String(c.id));
      }
      assert.equal(await text(page, '#tp-watch-text'), 'Prices received 7:00 AM, current.');
      // Four requests: the eight's prices and their item records (the icons), and the gem exchange's two quotes.
      assert.deepEqual(asked(page), HOME_ASKED);
      // Each icon from the render host, loaded (the browser may serve one from its cache, so requests are not counted).
      await page.waitFor("[...document.querySelectorAll('#tp-watch-list .tp-icon img')].every((i) => i.complete && i.naturalWidth > 0)", 5000);
      assert.ok(await page.eval("[...document.querySelectorAll('#tp-watch-list .tp-icon img')].every((i) => i.src.startsWith('https://render.guildwars2.com/file/'))"));
      // The types: exactly the item list's, each with its count, ordered as the Type list, each with its drawing.
      const tiles = await page.eval("[...document.querySelectorAll('#tp-cat-grid .tp-cat')].map((b) => [b.dataset.tpCat, b.querySelector('.tp-cat-name').textContent, b.querySelector('.tp-cat-count').textContent, Boolean(b.querySelector('svg[aria-hidden=\"true\"] path[d]'))])");
      // Counted here from the list itself, not by the module under test.
      const n = (i) => CAT.type.filter((x) => x === i).length;
      assert.deepEqual(tiles, Market.typeTiles(CAT).map((t) => [String(t.index), t.label, `${n(t.index).toLocaleString('en-US')} ${n(t.index) === 1 ? 'item' : 'items'}`, true]));
      assert.equal(tiles.length, CAT.types.length);
      assert.deepEqual(tiles.map((t) => t[1]), await page.eval("[...document.querySelectorAll('#tp-type option')].slice(1).map((o) => o.textContent)"), 'the same types, in the same order, as the Type list');
      // A hand-picked set, never a ranking.
      const words = await text(page, '#tp-home');
      assert.match(words, /eight familiar items used in crafting, chosen by hand; not a ranking/);
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-home section')].map((x) => x.querySelector('h3').textContent)"), ['Market Watch', 'Your favorites', 'Gem exchange', 'Browse by type']);
      assert.doesNotMatch(words, /popular|top[- ]traded|most traded|trending|best[- ]sell|hottest|volume/i);
      // The search comes first and stands out: taller than the filters under it.
      const sz = await page.eval("[document.getElementById('tp-find').getBoundingClientRect().height, document.getElementById('tp-type').getBoundingClientRect().height]");
      assert.ok(sz[0] >= 40 && sz[0] > sz[1], `search ${sz[0]} px, filters ${sz[1]} px`);
      // Away and back within 5 minutes: nothing asked. 6 minutes on: the prices again, not the icons.
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await sleep(500);
      assert.equal(page.apiRequests.length, 4, 'still current: nothing more');
      await later(page, 6 * 60000);
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]');
      await page.waitFor("document.getElementById('tp-watch-text').textContent === 'Prices received 7:06 AM, current.' && document.getElementById('tp-gem-text').textContent === 'Rates received 7:06 AM, current.'", 10000);
      assert.deepEqual(page.apiRequests.slice(4).map((u) => `${new URL(u).pathname} ${new URL(u).searchParams.get('ids') || new URL(u).searchParams.get('quantity')}`).sort(),
        ['/v2/commerce/exchange/coins 1000000', '/v2/commerce/exchange/gems 400', `/v2/commerce/prices ${WATCH_Q}`], 'the prices and rates again; the item records are kept');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post home: a type opens its results at once, named beside "Trading Post home", with focus there; the home comes back with nothing typed, no filter and Best match; typing, a filter, a price sort or Favorites leave it; each survives a switch of mode', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page); await watchReady(page);
      const W = CAT.types.indexOf('Weapon');
      await click(page, `.tp-cat[data-tp-cat="${W}"]`); await idle(page);
      const want = Catalog.search(CAT, { type: W }).indexes.slice(0, 50).map((i) => CAT.ids[i]);
      assert.deepEqual(await shownIds(page), want, 'what the Type list gives');
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-crumbs').hidden, document.getElementById('tp-crumb').textContent, document.activeElement.id, document.getElementById('tp-type').value, document.getElementById('tp-find').value, location.hash]"),
        [true, false, 'Weapon', 'tp-crumb', String(W), '', '#market'], 'results, named, focus on the name; no history entry');
      await page.waitFor("document.getElementById('tp-count').textContent === '11,780 items with these filters.'", 3000);
      assert.equal(page.apiRequests.filter((u) => /commerce\/prices/.test(u) && !isWatch(u)).length, 1, 'one request for the 50 shown');
      await page.waitFor("/^Prices received 7:00 AM, current\\.$/.test(document.getElementById('tp-prices-text').textContent)", 10000);
      // A switch of mode keeps them.
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await settle();
      assert.deepEqual(await shownIds(page), want);
      assert.equal(await text(page, '#tp-crumb'), 'Weapon');
      // Trading Post home: nothing typed, no filter, Best match, focus at the top; no request (Market Watch is current).
      await select(page, 'tp-sort', 'name'); await idle(page);
      const before = page.apiRequests.length;
      await click(page, '#tp-home-btn'); await settle();
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-crumbs').hidden, document.activeElement.id, document.getElementById('tp-type').value, document.getElementById('tp-rarity').value, document.getElementById('tp-sort').value, document.getElementById('tp-find').value, document.querySelectorAll('#tp-results li').length, location.hash]"),
        [false, true, 'market-title', '-1', '-1', 'relevance', '', 0, '#market']);
      await sleep(300);
      assert.equal(page.apiRequests.length, before, 'Market Watch still current');
      // Typing leaves the home; Clear comes back to it.
      await typeTp(page, 'glob'); await idle(page);
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-crumb').textContent]"), [true, '“glob”']);
      await click(page, '#tp-find-clear'); await settle();
      assert.equal(await page.eval("document.getElementById('tp-home').hidden"), false, 'Clear: the home again');
      // A rarity, a price sort (every item, among the loaded prices), Favorites: each leaves the home and is named.
      await select(page, 'tp-rarity', String(CAT.rarities.indexOf('Exotic'))); await idle(page);
      assert.equal(await text(page, '#tp-crumb'), 'Exotic');
      await click(page, '#tp-home-btn'); await settle();
      await select(page, 'tp-sort', 'sell-desc'); await idle(page);
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-crumb').textContent]"), [true, 'Every item']);
      assert.match(await text(page, '#tp-scope'), new RegExp(`among only the \\d+ of ${COUNT} matching items whose prices are loaded\\. Not a ranking of every match, or of the whole market\\.`));
      await click(page, '#tp-home-btn'); await settle();
      await click(page, '#tp-favs'); await idle(page);
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-crumb').textContent, document.getElementById('tp-empty').textContent]"), [true, 'Favorites', 'No favorites yet. Use the star (☆) by an item to add it.']);
      await click(page, '#tp-home-btn'); await settle();
      assert.equal(await page.eval("document.getElementById('tp-favs').getAttribute('aria-pressed')"), 'false');
      // The home again, after a switch of mode too.
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await settle();
      assert.equal(await page.eval("document.getElementById('tp-home').hidden"), false);
      assert.equal(page.apiRequests.filter(isWatch).length, 2, 'Market Watch asked once: its prices stayed current');
      assert.equal(page.apiRequests.filter(isGem).length, 2, 'the gem quotes once');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post home: when the API cannot be reached or has an error, Market Watch shows no price and why on every card, estimates nothing, and Try again recovers; aging prices are marked stale, then old and faded, in place', async () => {
    for (const how of ['offline', 503]) {
      let fail = true;
      const page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ answer: (n, u) => (fail && /commerce\/prices/.test(u.pathname) ? how : 'ok') }) });
      try {
        await market(page);
        await page.waitFor("/^ArenaNet's API/.test(document.getElementById('tp-watch-text').textContent)", 30000);
        const why = how === 'offline' ? "ArenaNet's API could not be reached" : "ArenaNet's API had an error";
        assert.equal(await text(page, '#tp-watch-text'), `${why}, so 8 items have no price here. Nothing is estimated in its place.`, String(how));
        const cards = await page.eval("[...document.querySelectorAll('#tp-watch-list .tp-watch-card')].map((li) => [li.querySelector('.tp-buy').textContent, li.querySelector('.tp-sell').textContent, li.querySelector('.tp-note').hidden ? null : li.querySelector('.tp-note').textContent, Boolean(li.querySelector('.coins'))])");
        assert.equal(cards.length, 8);
        for (const c of cards) assert.deepEqual(c, ['Highest buy order: Buynot loaded', 'Lowest sell listing: Sellnot loaded', `No price: ${why}.`, false], String(how));
        assert.equal(page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length, 4, `${how}: one try and three more`);
        assert.deepEqual(await page.eval("[document.getElementById('tp-watch-refresh').hidden, document.getElementById('tp-watch-refresh').textContent]"), [false, 'Try again']);
        assert.deepEqual(await lowContrast(page, '#tp-watch-list .tp-note, #tp-watch-list .tp-none, #tp-watch-text'), [], 'the reasons are readable');
        fail = false;
        await click(page, '#tp-watch-refresh');
        await page.waitFor("document.getElementById('tp-watch-text').textContent === 'Prices received 7:00 AM, current.'", 10000);
        assert.equal(await page.eval("document.querySelectorAll('#tp-watch-list .tp-note:not([hidden])').length"), 0, 'the notes go with the failure');
        assert.match(await page.eval("document.querySelector('#tp-watch-list [data-id=\"19721\"] .tp-sell').textContent"), /19 silver 10 copper/);
        assert.equal(await text(page, '#tp-watch-refresh'), 'Refresh prices');
        // Refresh asks again even for current prices: one more request for the eight.
        const asked = page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length;
        await click(page, '#tp-watch-refresh');
        const count = () => page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length;
        for (let i = 0; i < 50 && count() === asked; i++) await sleep(100);
        await page.waitFor("document.getElementById('tp-watch-text').textContent === 'Prices received 7:00 AM, current.' && !document.getElementById('tp-watch-refresh').hidden", 10000);
        await sleep(300);
        assert.equal(count(), asked + 1, 'Refresh asks again, once');
        assert.deepEqual(unexpected(page, NET), []);
      } finally { await page.close(); }
    }
    let hold = false;
    const page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ answer: () => (hold ? 'hold' : 'ok') }) });
    try {
      await market(page); await watchReady(page);
      hold = true;
      await later(page, 12 * 60000);
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await sleep(400);
      assert.equal(await text(page, '#tp-watch-text'), 'Loading prices for 8 items... Prices received 7:00 AM, 12 minutes ago: stale.', 'no "Refresh" while a refresh is on its way');
      assert.equal(await page.eval("document.getElementById('tp-watch-prices').dataset.fresh"), 'stale');
      assert.deepEqual(await page.eval("[...new Set([...document.querySelectorAll('#tp-watch-list .tp-watch-card')].map((li) => li.classList.contains('is-stale') + ' ' + li.querySelector('.tp-note').textContent))]"), ['true Stale price, received 12 minutes ago.']);
      assert.match(await page.eval("document.querySelector('#tp-watch-list [data-id=\"19721\"] .tp-sell').textContent"), /19 silver 10 copper/, 'the older price stays');
      assert.deepEqual(await lowContrast(page, '#tp-watch-text, #tp-watch-list .tp-note'), [], 'stale, readable');
      // An hour on: the 30-second tick marks every card old, in place.
      await page.eval("document.querySelector('#tp-watch-list .tp-watch-card').dataset.mark = 'kept'");
      await later(page, 60 * 60000);
      await page.waitFor("document.querySelectorAll('#tp-watch-list .tp-watch-card.is-old').length === 8", 35000);
      assert.equal(await page.eval("document.querySelector('#tp-watch-list .tp-watch-card').dataset.mark"), 'kept', 'updated in place, not redrawn');
      assert.equal(await text(page, '#tp-watch-text'), 'Loading prices for 8 items... Prices received 7:00 AM, 72 minutes ago: old, shown faded.');
      assert.equal(await text(page, '#tp-watch-list .tp-note'), 'Old price, received 72 minutes ago.');
      assert.deepEqual(await lowContrast(page, '#tp-watch-list .tp-watch-card.is-old .coin, #tp-watch-list .tp-note'), [], 'faded, still readable');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  check('Trading Post home: the timer\'s first load asks the API for nothing; the home\'s two requests come only when the Trading Post is opened; a link to an item still opens its details at once, over the home', async () => {
    const page = await open({ at: AT, api: api() });
    try {
      await sleep(1500);
      assert.deepEqual(page.apiRequests, [], 'nothing before the Trading Post is opened');
      assert.equal(page.iconRequests, 0);
      assert.equal(await page.eval("document.querySelectorAll('#tp-watch-list li, #tp-cat-grid li').length"), 0, 'the home is not even drawn');
      await click(page, '[data-mode="market"]'); await market(page); await watchReady(page);
      assert.deepEqual(asked(page), HOME_ASKED);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    const deep = await open({ at: AT, api: api(), url: BASE + '#market/item/24295', wait: false });
    try {
      await deep.waitFor("document.getElementById('tp-item-dialog').open && document.getElementById('tp-item-title').textContent === 'Vial of Powerful Blood' && document.querySelector('#tp-item-body .tp-stats')", 15000);
      assert.deepEqual(await deep.eval("[document.activeElement.id, document.getElementById('tp-home').hidden, location.hash]"), ['tp-item-title', false, '#market/item/24295']);
      // Vial of Powerful Blood is one of Market Watch's: its price came with theirs, in the home's requests.
      await watchReady(deep);
      assert.deepEqual(asked(deep), HOME_ASKED);
      await deep.eval("document.querySelector('#tp-item-dialog [data-close]').click()"); await sleep(300);
      assert.deepEqual(await deep.eval("[location.hash, document.getElementById('tp-home').hidden, document.getElementById('tp-item-dialog').open]"), ['#market', false, false]);
      assert.deepEqual(unexpected(deep), []);
    } finally { await deep.close(); }
    // An item outside Market Watch: the home's two requests, and the item's own price and record.
    const other = await open({ at: AT, api: api(), url: BASE + '#market/item/26332', wait: false });
    try {
      await other.waitFor("document.getElementById('tp-item-dialog').open && document.querySelector('#tp-item-body .tp-stats')", 15000);
      await watchReady(other);
      assert.deepEqual(asked(other), [...HOME_ASKED, '/v2/commerce/prices 26332', '/v2/items 26332'].sort());
    } finally { await other.close(); }
  });

  check('Trading Post home by keyboard and screen reader: Tab goes from the search through the filters, Market Watch\'s names, every type and the notes\' pills; Enter on a type opens it with focus on its name; Trading Post home returns; pills open with Enter or Space, one at a time, and close with Escape', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page); await watchReady(page);
      await page.eval("document.getElementById('tp-find').focus()");
      const seen = [];
      for (let i = 0; i < 43; i++) { await key(page, 'Tab', 'Tab', 9); seen.push(await page.eval("(() => { const a = document.activeElement; return a.id || a.dataset.tpkey || a.className; })()")); }
      const tiles = Market.typeTiles(CAT);
      const order = ['tp-type', 'tp-rarity', 'tp-sort', 'tp-favs', 'tp-pf-toggle', 'tp-whole-btn', 'tp-watch-refresh', ...WATCH.map((id) => `watch:${id}`), 'tp-gem-refresh', ...tiles.map((t) => `cat:${t.index}`), 'tp-pill-list', 'tp-pill-fees', 'tp-pill-saved'];
      assert.deepEqual(seen.slice(0, order.length), order, 'every one, in this order');
      const a11y = await page.eval(`({ tile: document.querySelector('.tp-cat').textContent, svg: [...document.querySelectorAll('.tp-cat svg')].every((s) => s.getAttribute('aria-hidden') === 'true' && s.getAttribute('focusable') === 'false'),
        list: document.getElementById('tp-watch-list').getAttribute('aria-label'), status: document.getElementById('tp-watch-text').getAttribute('role'), buy: document.querySelector('#tp-watch-list .tp-buy > .sr-only').textContent,
        link: document.querySelector('#tp-watch-list a.tp-name').getAttribute('aria-haspopup'), regions: [...document.querySelectorAll('#tp-home section')].map((s) => document.getElementById(s.getAttribute('aria-labelledby')).textContent),
        pills: [...document.querySelectorAll('[data-tp-pill]')].map((b) => [b.textContent, b.getAttribute('aria-expanded'), b.getAttribute('aria-controls'), document.getElementById(b.getAttribute('aria-controls')).hidden]) })`);
      assert.deepEqual(a11y, { tile: `${tiles[0].label}${tiles[0].count.toLocaleString('en-US')} items`, svg: true, list: 'Market Watch items', status: 'status', buy: 'Highest buy order: ', link: 'dialog',
        regions: ['Market Watch', 'Your favorites', 'Gem exchange', 'Browse by type'], pills: [['Item list', 'false', 'tp-panel-list', true], ['Fees and margin', 'false', 'tp-panel-fees', true], ['What is saved', 'false', 'tp-panel-saved', true]] });
      const ring = await page.eval("(() => { const b = document.querySelector('.tp-cat'); b.focus(); return getComputedStyle(b).outlineStyle + ' ' + getComputedStyle(b).outlineWidth; })()");
      assert.equal(ring, 'solid 2px', 'a visible focus ring on a type');
      // Enter on a type: its results, focus on its name, beside the way back.
      const T = CAT.types.indexOf('Trophy');
      await page.eval(`document.querySelector('[data-tp-cat="${T}"]').focus()`);
      await key(page, 'Enter', 'Enter', 13); await idle(page);
      assert.deepEqual(await page.eval("[document.activeElement.id, document.activeElement.textContent, document.getElementById('tp-home').hidden, document.querySelectorAll('#tp-results .tp-row').length]"), ['tp-crumb', 'Trophy', true, 50]);
      // Space on Trading Post home: the home, focus at the top, then Tab to the search.
      await page.eval("document.getElementById('tp-home-btn').focus()");
      await key(page, ' ', 'Space', 32); await settle();
      assert.deepEqual(await page.eval("[document.activeElement.id, document.getElementById('tp-home').hidden, document.getElementById('tp-type').value]"), ['market-title', false, '-1']);
      await key(page, 'Tab', 'Tab', 9);
      assert.equal(await page.eval('document.activeElement.id'), 'tp-find');
      // The pills: Enter opens one, Space on another switches, Escape closes it and focus stays on its pill.
      const pills = () => page.eval("[...document.querySelectorAll('[data-tp-pill]')].map((b) => b.getAttribute('aria-expanded') + ':' + document.getElementById(b.getAttribute('aria-controls')).hidden)");
      await page.eval("document.getElementById('tp-pill-fees').focus()");
      await key(page, 'Enter', 'Enter', 13); await settle();
      assert.deepEqual(await pills(), ['false:true', 'true:false', 'false:true']);
      await page.eval("document.getElementById('tp-pill-list').focus()");
      await key(page, ' ', 'Space', 32); await settle();
      assert.deepEqual(await pills(), ['true:false', 'false:true', 'false:true'], 'one at a time');
      await key(page, 'Escape', 'Escape', 27); await settle();
      assert.deepEqual(await pills(), ['false:true', 'false:true', 'false:true']);
      assert.equal(await page.eval('document.activeElement.id'), 'tp-pill-list');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: the notes are three closed pills after the home or the results, on one line; each opens its own panel: the item list\'s date, the fees and margin, what is saved', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      const box = await page.eval("(() => { const n = document.getElementById('tp-notes'), p = [...n.querySelectorAll('.tp-pill')].map((b) => b.getBoundingClientRect()); return { h: n.getBoundingClientRect().height, line: p.every((r) => Math.abs(r.top - p[0].top) < 1), after: Boolean(document.getElementById('tp-home').compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING), last: n.parentNode.lastElementChild === n }; })()");
      assert.ok(box.h < 50 && box.line && box.after && box.last, JSON.stringify(box));
      const open1 = async (id) => { await click(page, `#${id}`); await settle(); return page.eval(`[...document.querySelectorAll('.tp-pill-panel')].filter((p) => !p.hidden).map((p) => p.id + ': ' + p.textContent.trim())`); };
      const list = await open1('tp-pill-list');
      assert.equal(list.length, 1);
      assert.match(list[0], new RegExp(`^tp-panel-list: Item list as of ${esc(ASOF)}: ${COUNT} items with a Trading Post price then\\. Items added to the game since then cannot be found until the list is updated\\.$`));
      const fees = await open1('tp-pill-fees');
      assert.equal(fees.length, 1);
      assert.match(fees[0], /^tp-panel-fees: Potential margin is what listing one unit .* It is not a profit: an order that is placed has not filled, someone may list lower, and prices move\. Fees: a 5% listing fee and a 10% exchange fee, each at least 1 copper.* every result after fees is an estimate\.$/);
      assert.deepEqual(await open1('tp-pill-saved'), ['tp-panel-saved: Favorites are saved in this browser. Prices are never saved: they last while this page is open.']);
      assert.deepEqual(await open1('tp-pill-saved'), [], 'a second press closes it');
      // Under results too.
      await typeTp(page, 'glob'); await idle(page);
      assert.equal(await page.eval("Boolean(document.getElementById('tp-results').compareDocumentPosition(document.getElementById('tp-notes')) & Node.DOCUMENT_POSITION_FOLLOWING) && document.getElementById('tp-notes').getClientRects().length > 0"), true);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: an item\'s details lead with its highest buy order, lowest sell listing and potential margin, large, then when they were fetched; the arithmetic and caveats follow, smaller; a stale price is marked there as the clock moves', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market/item/19721', wait: false });
    try {
      await page.waitFor("document.getElementById('tp-item-dialog').open && document.querySelector('#tp-item-body .tp-stats')", 15000);
      const q = quoteOf(19721);
      const stats = await page.eval("[...document.querySelectorAll('#tp-item-body .tp-stat')].map((x) => [x.querySelector('.tp-stat-k').textContent, x.querySelector('.tp-stat-v .coins .sr-only').textContent, x.querySelector('.tp-stat-sub').textContent])");
      assert.deepEqual(stats, [['Highest buy order', Money.coins(q.buy).spoken, '391,900 units wanted in all buy orders'], ['Lowest sell listing', Money.coins(q.sell).spoken, '2,219,204 units listed in all'],
        ['Potential margin', Money.coins(q.margin).spoken, `${Money.percent(q.marginPct)} of the highest buy order, after fees`], ['Break-even listing price', '20 silver 12 copper', 'the lowest that gives back the buy price after fees']]);
      assert.equal(q.breakEven, 2012, 'by hand: 2012 - 101 - 201 = 1710, the 17s 10c buy order; 2011 gives 1709');
      const look = await page.eval("({ big: parseFloat(getComputedStyle(document.querySelector('#tp-item-body .tp-stat-v')).fontSize), small: parseFloat(getComputedStyle(document.querySelector('#tp-item-body .tp-facts dd')).fontSize), first: [...document.querySelector('#tp-item-body .tp-detail-main').children].slice(0, 2).map((c) => c.className), loss: document.querySelector('.tp-stat-margin .coins').classList.contains('neg') })");
      assert.ok(look.big >= look.small + 4, JSON.stringify(look));
      assert.deepEqual([look.first, look.loss], [['tp-detail-head', 'tp-stats-wrap'], true]);
      assert.equal(await text(page, '#tp-item-body .tp-stat-when'), 'Prices received at 7:00 AM, just now (current). That is when this page got them; when ArenaNet last updated them is not known: the answer carries no time, and ArenaNet lets an answer be reused for up to 2 minutes, so they may date from before 7:00 AM.');
      const facts = await page.eval("[...document.querySelectorAll('#tp-item-body .tp-facts dt')].map((d) => d.textContent)");
      assert.deepEqual(facts, ['Spread', 'Sell one now', 'List one', 'Potential margin', 'Break-even', 'Merchant', 'Item id', 'Chat code']);
      assert.match((await text(page, '#tp-item-body .tp-facts')).replace(/\s+/g, ' '), /Break-even\s*Listing one unit at 20s 12c\s*20 silver 12 copper or more would give back at least the highest buy order, 17s 10c\s*17 silver 10 copper, after both fees; any lower would lose\. A gain of 1 copper or more starts at 20s 13c\s*20 silver 13 copper\. The lowest sell listing, 19s 10c\s*19 silver 10 copper, is below it: listing there now would lose\. An estimate: the fees' rounding is assumed, and an order fills only if someone takes it\./);
      assert.match(await text(page, '#tp-item-body .tp-facts'), /Potential margin\s*Buying at the highest buy order and listing at the lowest sell listing, after fees\. The percentage is of the highest buy order, what buying one costs\. A potential margin, not a profit: neither order has filled, and prices move\./);
      // 12 minutes on, the 30-second tick: the fetch line says stale, in the warning color.
      await later(page, 12 * 60000);
      await page.waitFor("/12 minutes ago \\(stale\\)/.test(document.querySelector('#tp-item-body .tp-stat-when').textContent)", 35000);
      assert.equal(await page.eval("document.querySelector('#tp-item-body .tp-stat-when').classList.contains('is-stale')"), true);
      assert.deepEqual(await lowContrast(page, '#tp-item-body .tp-stat *, #tp-item-body .tp-stat-when, #tp-item-body .tp-facts dt, #tp-item-body .tp-facts dd'), [], 'readable');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post home fits 320, 360 and 390 px phones, a 768 px tablet, and 920 and 1280 px desktops in both themes: no sideways scroll, nothing spills or overlaps in a card or a type, 36 px controls on phones, readable contrast; an item\'s three figures fit, four-digit gold included', async () => {
    const DRAGON = CAT.ids[CAT.names.indexOf('Glob of Dragonvoid Aether')];
    for (const [width, height, mobile] of [[320, 568, true], [360, 740, true], [390, 844, true], [768, 1024, false], [920, 800, false], [1280, 900, false]]) {
      for (const theme of ['dark', 'light']) {
        const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false, width, height, mobile, seed: { [h.reminders.PREFS]: { theme } } });
        try {
          await market(page); await watchReady(page);
          await click(page, '#tp-pill-fees'); await settle();
          const r = await page.eval("({ page: document.documentElement.scrollWidth, boxes: [...document.querySelectorAll('.tp-watch-card, .tp-cat, .tp-pill, .tp-pill-panel, .tp-gem, .tp-favhome-empty')].every((x) => x.getBoundingClientRect().right <= innerWidth && x.getBoundingClientRect().left >= 0) })");
          assert.ok(r.page <= width && r.boxes, `${width} ${theme}: ${JSON.stringify(r)}`);
          const spill = await page.eval(`[...document.querySelectorAll('#tp-watch-list .tp-watch-card, #tp-cat-grid .tp-cat')].flatMap((box) => {
            const parts = [...box.querySelectorAll('.tp-cell, .tp-name, .tp-cat-name, .tp-cat-count, .tp-icon, svg')], bad = parts.filter((c) => c.scrollWidth > c.clientWidth + 1 && c.tagName !== 'svg').map((c) => (box.dataset.id || box.dataset.tpCat) + ' ' + c.className + ' spills');
            for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
              const a = parts[i].getBoundingClientRect(), b = parts[j].getBoundingClientRect();
              if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push((box.dataset.id || box.dataset.tpCat) + ' ' + (parts[i].className.baseVal ?? parts[i].className) + ' / ' + (parts[j].className.baseVal ?? parts[j].className));
            }
            return bad; })`);
          assert.deepEqual(spill, [], `${width} ${theme}`);
          if (mobile) {
            const small = await page.eval("[...document.querySelectorAll('#market-view button, #market-view select, #market-view input, #market-view a.tp-name')].filter((x) => x.getClientRects().length && x.getBoundingClientRect().height < 36).map((x) => (x.id || x.className) + ' ' + x.getBoundingClientRect().height.toFixed(1))");
            assert.deepEqual(small, [], `${width} ${theme}`);
          }
          assert.deepEqual(await lowContrast(page, '#tp-home p, #tp-home span, #tp-home a, #tp-home h3, #tp-home button, .tp-notes button, .tp-pill-panel p'), [], `${width} ${theme}`);
          if (SHOTS && theme === 'dark' && [320, 1280].includes(width)) await page.screenshot(join(SHOTS, `market-home-${width}.png`), { height: Math.max(height, 1500) });
          // An item's details: the three figures fit their boxes, even at four-digit gold.
          await page.eval(`location.hash = '#market/item/${DRAGON}'`);
          await page.waitFor("document.getElementById('tp-item-dialog').open && document.querySelector('#tp-item-body .tp-stats')", 10000);
          const fit = await page.eval("[...document.querySelectorAll('#tp-item-body .tp-stat')].filter((x) => x.scrollWidth > x.clientWidth + 1 || x.getBoundingClientRect().right > document.getElementById('tp-item-dialog').getBoundingClientRect().right).map((x) => x.className)");
          assert.deepEqual(fit, [], `${width} ${theme}: details`);
          assert.deepEqual(await lowContrast(page, '#tp-item-body .tp-stat *, #tp-item-body .tp-stat-when'), [], `${width} ${theme}: details`);
          assert.deepEqual(unexpected(page), []);
        } finally { await page.close(); }
      }
    }
  });

  // ---- The home's favorites, the gem exchange, the margin % sort (post-v0.4.0 polish, scope addition) ----

  check('Trading Post home: Your favorites shows the newest 8 with live prices from the home\'s one prices request, opens an item\'s details, says when a price is missing, counts favorites the list no longer has, and Show all opens every one; kept through a reload', async () => {
    // Ten favorites (saved oldest first), one id the item list no longer has, and one item the API has no price for.
    const FAVS = [19721, 24295, 26332, 12844, 12868, 26216, 26218, 26220, 26229, 26230], NO_PRICE = 26230;
    const shown = FAVS.slice(-8).reverse();
    const cardsOf = (page) => page.eval("[...document.querySelectorAll('#tp-favhome-list .tp-watch-card')].map((li) => Number(li.dataset.id))");
    const page = await open({ at: AT, api: api({ missing: new Set([NO_PRICE]) }), url: BASE + '#market', wait: false, seed: { [FAV]: [...FAVS, 999999999] } });
    try {
      await market(page); await watchReady(page);
      await page.waitFor("!/loading/.test(document.getElementById('tp-favhome-list').textContent) && document.querySelectorAll('#tp-favhome-list .tp-icon img').length >= 7", 10000);
      const cards = await page.eval("[...document.querySelectorAll('#tp-favhome-list .tp-watch-card')].map((li) => ({ id: Number(li.dataset.id), sell: li.querySelector('.tp-sell').textContent, href: li.querySelector('a.tp-name').getAttribute('href'), key: li.querySelector('a.tp-name').dataset.tpkey }))");
      assert.deepEqual(cards.map((c) => c.id), shown, 'the newest 8, newest first');
      for (const c of cards) {
        const q = quoteOf(c.id);
        if (c.id === NO_PRICE) assert.equal(c.sell, 'Lowest sell listing: Sellnot on the Trading Post now', 'the API has no price for it: said so');
        else assert.ok(c.sell.includes(Money.coins(q.sell).spoken), `${c.id}: ${c.sell}`);
        assert.deepEqual([c.href, c.key], [`#market/item/${c.id}`, `favhome:${c.id}`]);
      }
      // Market Watch and the favorites shown share the home's one prices request and one item request.
      const homeQ = [...new Set([...WATCH, ...shown])].sort((a, b) => a - b).join(',');
      assert.deepEqual(asked(page).filter((x) => !/exchange/.test(x)), [`/v2/commerce/prices ${homeQ}`, `/v2/items ${homeQ}`]);
      assert.equal(await text(page, '#tp-favhome-hint'), 'saved in this browser, newest first; 1 saved favorite is no longer in the item list, so not shown');
      assert.equal(await text(page, '#tp-favhome-text'), 'Prices received 7:00 AM, current.');
      assert.deepEqual(await page.eval("[document.getElementById('tp-favhome-empty').hidden, document.getElementById('tp-favhome-all').hidden, document.getElementById('tp-favhome-all').textContent, document.getElementById('tp-favhome-list').getAttribute('aria-label')]"),
        [true, false, 'Show all 10 favorites', 'Your favorite items']);
      // A name opens the item's details over the home; Back closes them and focus returns to the name.
      await page.eval("document.querySelector('#tp-favhome-list a.tp-name').focus()");
      await key(page, 'Enter', 'Enter', 13);
      await page.waitFor("document.getElementById('tp-item-dialog').open", 10000);
      assert.equal(await page.eval('location.hash'), `#market/item/${shown[0]}`);
      await page.eval('history.back()'); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, location.hash, document.activeElement.dataset.tpkey]"), [false, '#market', `favhome:${shown[0]}`]);
      await page.eval('history.forward()'); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, location.hash]"), [true, `#market/item/${shown[0]}`], 'Forward opens them again');
      await page.eval('history.back()'); await sleep(400);
      // Show all: every favorite as results (the Favorites filter), named, focus there, no history entry.
      await click(page, '#tp-favhome-all'); await idle(page);
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-crumb').textContent, document.activeElement.id, document.getElementById('tp-favs').getAttribute('aria-pressed'), location.hash]"), [true, 'Favorites', 'tp-crumb', 'true', '#market']);
      assert.deepEqual((await shownIds(page)).sort((a, b) => a - b), [...FAVS].sort((a, b) => a - b));
      // Unstarred in the results, it leaves the home too, and the count follows.
      await click(page, `#tp-results [data-tp-fav="${shown[1]}"]`); await idle(page);
      await click(page, '#tp-home-btn'); await settle();
      const after = FAVS.filter((id) => id !== shown[1]);
      assert.deepEqual(await cardsOf(page), after.slice(-8).reverse());
      assert.equal(await text(page, '#tp-favhome-all'), 'Show all 9 favorites');
      assert.equal(await page.eval(`localStorage.getItem('${FAV}')`), JSON.stringify(after), 'saved as ids, the lost one cleaned out');
      // Kept through a reload.
      await page.reload(); await market(page); await watchReady(page);
      assert.deepEqual(await cardsOf(page), after.slice(-8).reverse());
      assert.equal(await text(page, '#tp-favhome-hint'), 'saved in this browser, newest first');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post home: with no favorites it says how to add one; one starred in an item\'s details shows there at once with the price it has, asking nothing more; a favorite the API cannot price says why', async () => {
    let page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page); await watchReady(page);
      assert.deepEqual(await page.eval("[document.getElementById('tp-favhome-empty').hidden, document.getElementById('tp-favhome-empty').textContent, document.getElementById('tp-favhome-list').hidden, document.getElementById('tp-favhome-prices').hidden, document.getElementById('tp-favhome-all').hidden]"),
        [false, 'No favorites yet. Star an item (☆) in the results or in its details to keep it here, with its prices.', true, true, true]);
      const before = page.apiRequests.length;
      await click(page, '#tp-watch-list a[href="#market/item/68063"]');
      await page.waitFor("document.getElementById('tp-item-dialog').open && document.querySelector('#tp-item-body .tp-stats')", 10000);
      await click(page, '[data-tpkey="dlg:fav"]'); await settle();
      await page.eval("document.querySelector('#tp-item-dialog [data-close]').click()"); await sleep(300);
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-favhome-list .tp-watch-card')].map((li) => [Number(li.dataset.id), /gold|silver|copper/.test(li.querySelector('.tp-sell').textContent)])"), [[68063, true]]);
      assert.equal(await page.eval("document.getElementById('tp-favhome-empty').hidden"), true);
      assert.equal(page.apiRequests.length, before, 'its price was already here');
      // Another tab stars an item this one has no price for: it shows here, and its price is asked for (one request).
      await page.eval(`(() => { localStorage.setItem('${FAV}', '[68063,26332]'); window.dispatchEvent(new StorageEvent('storage', { key: '${FAV}' })); })()`);
      await page.waitFor("(() => { const li = document.querySelector('#tp-favhome-list [data-id=\"26332\"]'); return li && /gold|silver|copper/.test(li.querySelector('.tp-sell').textContent); })()", 10000);
      assert.deepEqual(asked(page).filter((x) => /26332/.test(x)), ['/v2/commerce/prices 26332', '/v2/items 26332']);
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-favhome-list .tp-watch-card')].map((li) => Number(li.dataset.id))"), [26332, 68063]);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    page = await open({ at: AT, url: BASE + '#market', wait: false, seed: { [FAV]: [26332] }, api: api({ answer: (n, u) => (/commerce\/prices/.test(u.pathname) ? 'offline' : 'ok') }) });
    try {
      await market(page);
      await page.waitFor("/^ArenaNet's API/.test(document.getElementById('tp-favhome-text').textContent)", 30000);
      assert.equal(await text(page, '#tp-favhome-text'), "ArenaNet's API could not be reached, so 1 item has no price here. Nothing is estimated in its place.");
      assert.deepEqual(await page.eval("(() => { const li = document.querySelector('#tp-favhome-list [data-id=\"26332\"]'); return [li.querySelector('.tp-buy').textContent, li.querySelector('.tp-note').textContent, Boolean(li.querySelector('.coins'))]; })()"),
        ['Highest buy order: Buynot loaded', "No price: ArenaNet's API could not be reached.", false]);
      assert.equal(await text(page, '#tp-favhome-refresh'), 'Try again');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  check('Trading Post home: the gem exchange says what 100 gold buys and what 400 gems sell for, each direction on its own line in its own units, one request each, with when; when the API fails no rate is shown and it says why, and Try again recovers; a stale rate is marked', async () => {
    const gemLines = (page) => page.eval("[...document.querySelectorAll('.tp-gem')].map((li) => { const c = li.cloneNode(true); for (const s of c.querySelectorAll('.sr-only')) s.remove(); return c.textContent.replace(/\\s+/g, ' ').trim(); })");
    let how = 'ok';
    let page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ answer: (n, u) => (/exchange/.test(u.pathname) ? how : 'ok') }) });
    try {
      await market(page); await watchReady(page);
      assert.deepEqual(await gemLines(page), ['Gold to gems 100 gold buys 225 gems (about 44s 44c a gem)', 'Gems to gold 400 gems sell for 119g 72s 00c (about 29s 93c a gem)']);
      assert.deepEqual(await page.eval("[...document.querySelectorAll('.tp-gem .coins .sr-only')].map((s) => s.textContent)"), ['44 silver 44 copper', '119 gold 72 silver', '29 silver 93 copper'], 'read out in words');
      assert.equal(await text(page, '#tp-gem-text'), 'Rates received 7:00 AM, current.');
      assert.equal(await text(page, '.tp-gem-note'), 'The rate changes with the amount, and buying gems and selling them are different prices: neither line is the other one reversed.');
      assert.deepEqual(asked(page).filter((x) => /exchange/.test(x)), ['/v2/commerce/exchange/coins quantity=1000000', '/v2/commerce/exchange/gems quantity=400']);
      // 12 minutes on, the API holding: the rates stay, said stale, no Refresh while one is on its way.
      how = 'hold';
      await later(page, 12 * 60000);
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await sleep(400);
      assert.equal(await text(page, '#tp-gem-text'), 'Loading the rates... Rates received 7:00 AM, 12 minutes ago: stale.');
      assert.deepEqual([await page.eval("document.getElementById('tp-gem-prices').dataset.fresh"), await page.eval("document.getElementById('tp-gem-refresh').hidden")], ['stale', true]);
      assert.match((await gemLines(page))[0], /100 gold buys 225 gems/, 'the older rate stays, with its age');
      assert.deepEqual(await lowContrast(page, '#tp-gem-text, .tp-gem *'), [], 'readable');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
    how = 'offline';
    page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ answer: (n, u) => (/exchange/.test(u.pathname) ? how : 'ok') }) });
    try {
      await market(page);
      await page.waitFor("/^ArenaNet's API/.test(document.getElementById('tp-gem-text').textContent)", 30000);
      assert.equal(await text(page, '#tp-gem-text'), "ArenaNet's API could not be reached, so neither rate is shown. Nothing is estimated in its place.");
      assert.deepEqual(await gemLines(page), ["Gold to gems no rate here: ArenaNet's API could not be reached.", "Gems to gold no rate here: ArenaNet's API could not be reached."]);
      assert.equal(await page.eval("document.querySelectorAll('.tp-gem .coins').length"), 0, 'no number without the API');
      assert.equal(page.apiRequests.filter(isGem).length, 8, 'each tried once and three more times');
      assert.equal(await text(page, '#tp-gem-refresh'), 'Try again');
      how = 'ok';
      await click(page, '#tp-gem-refresh');
      await page.waitFor("document.getElementById('tp-gem-text').textContent === 'Rates received 7:00 AM, current.'", 10000);
      assert.match((await gemLines(page))[1], /400 gems sell for 119g 72s 00c/);
      assert.equal(await text(page, '#tp-gem-refresh'), 'Refresh rates');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  check('Trading Post: the potential margin % sort ranks by the margin as a share of the highest buy order and says so; rows with no buy orders (no denominator) or no sell listings come after the ranked ones; over 1,000 matches it ranks only the loaded prices and never loads the whole market', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page); await watchReady(page);
      await typeTp(page, 'iron sword'); await idle(page);
      await select(page, 'tp-sort', 'marginpct-desc');
      await page.waitFor("/among all 358 matching items/.test(document.getElementById('tp-scope').textContent)", 15000);
      await idle(page);
      const want = expectedSort('iron sword', 'marginPct', 'desc');
      const ids = want.order.map((i) => CAT.ids[i]);
      assert.deepEqual(await shownIds(page), ids.slice(0, 50), 'the ranking worked out in Node');
      assert.notDeepEqual(ids.slice(0, 10), expectedSort('iron sword', 'margin', 'desc').order.slice(0, 10).map((i) => CAT.ids[i]), 'not the same as the margin in copper');
      const scope = await text(page, '#tp-scope');
      assert.ok(scope.startsWith('Ranked by potential margin as a share of the highest buy order, largest first, among all 358 matching items. Not a ranking of the whole market.'), scope);
      assert.ok(scope.endsWith(`${want.noSide} items with no buy orders or no sell listings come after the ranked ones.`), scope);
      const pct = await page.eval("[...document.querySelectorAll('#tp-results .tp-row .tp-margin')].slice(0, 3).map((c) => c.textContent)");
      pct.forEach((t, k) => assert.ok(t.includes(`${Money.percent(quoteOf(ids[k]).marginPct)} of buy`), t));
      // Show more until the rows without a denominator: each one after every ranked row, none ranked as 0%.
      while ((await page.eval("document.querySelectorAll('#tp-results .tp-row').length")) < Math.min(358, want.ranked + 5)) { await click(page, '#tp-more'); await sleep(300); await idle(page); }
      const sides = await page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((r) => /no buy orders|no sell listings/.test(r.textContent))");
      assert.ok(sides.slice(0, want.ranked).every((x) => !x) && sides.slice(want.ranked).every((x) => x), `the ranked ${want.ranked} first`);
      assert.equal(await page.eval(`document.getElementById('tp-sort').selectedOptions[0].textContent`), 'Potential margin %, largest first');
      // Over 1,000 matches: only the loaded prices, said so; only the 50 shown asked for; the whole market never.
      const before = page.apiRequests.length;
      await typeTp(page, 'sword'); await sleep(800); await idle(page);
      assert.match(await text(page, '#tp-scope'), /^Ranked by potential margin as a share of the highest buy order, largest first, among only the [\d,]+ of 1,075 matching items whose prices are loaded\. Not a ranking of every match, or of the whole market\. To rank every match, narrow the search to 1,000 items or fewer, or load the whole market\./);
      const more = page.apiRequests.slice(before).filter((u) => /commerce\/prices/.test(u));
      assert.ok(more.length <= 2 && more.every((u) => new URL(u).searchParams.get('ids').split(',').length <= 50), `only shown rows: ${more.length} requests`);
      assert.deepEqual(await page.eval("[document.getElementById('tp-whole-progress').hidden, document.getElementById('tp-whole-status').textContent]"), [true, ''], 'no whole-market load');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  // Found by Lighthouse in the baseline matrix of 2026-11-16 (CLS 0.049 on #market): the home's price lines grew as
  // the prices and their Refresh button arrived, and moved the cards under them.
  check('Trading Post home: nothing on screen moves while the home\'s prices, rates and icons arrive (layout shift 0), on a desktop and a phone', async () => {
    // Where Market Watch and (while on screen, as Lighthouse counts it) the types sit on the page, every frame from the
    // moment the home is first shown: one place only. (The layout-shift entries Lighthouse counts are not reported in these headless runs, so the positions are
    // sampled directly; Lighthouse's own CLS for #market is in the matrix.)
    const TOPS = "window.__tops = []; (function loop() { const home = document.getElementById('tp-home'); if (home && !home.hidden && document.getElementById('tp-watch-list')) { const y = (id) => Math.round(document.getElementById(id).getBoundingClientRect().top + scrollY); const grid = document.getElementById('tp-cat-grid').getBoundingClientRect().top; const k = y('tp-watch-list') + ',' + (grid < innerHeight ? y('tp-cat-grid') : 'below the screen'); if (window.__tops[window.__tops.length - 1] !== k) window.__tops.push(k); } requestAnimationFrame(loop); })();";
    for (const [width, height, mobile] of [[1280, 900, false], [390, 844, true]]) {
      const page = await open({ at: AT, api: api({ delay: 300 }), url: BASE + '#market', wait: false, width, height, mobile, init: [TOPS] });
      try {
        await market(page); await watchReady(page); await sleep(600);
        const tops = await page.eval('window.__tops');
        assert.ok(tops.length >= 1, `${width}: the home was seen`);
        assert.deepEqual(tops, [tops[0]], `${width}: Market Watch and the types moved while the prices arrived: ${tops.join(' -> ')}`);
      } finally { await page.close(); }
    }
  });

  // ---- Search and prices ----

  check('Trading Post: search finds items by name, by words in any order, without accents, and by id; one letter asks for more; the count is said', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      // Nothing typed: the home, not an empty list (its own checks are above).
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-empty').hidden]"), [false, true]);
      for (const q of ['glob of ecto', 'ecto glob', 'GLOB OF ÉCTO', '19721']) {
        await typeTp(page, q);
        assert.equal((await shownIds(page))[0], 19721, q);
      }
      await page.waitFor("document.getElementById('tp-count').textContent === '1 item matches “19721”.'");
      await typeTp(page, 'iron sword');
      await page.waitFor("document.getElementById('tp-count').textContent === '358 items match “iron sword”.'", 3000);
      assert.equal(await page.eval("document.querySelectorAll('#tp-results .tp-row').length"), 50, 'the count is every match, not the 50 shown');
      await typeTp(page, 'e');
      assert.deepEqual(await shownIds(page), []);
      assert.match(await text(page, '#tp-empty'), /at least 2 letters/);
      await typeTp(page, 'zzqqxx');
      assert.match(await text(page, '#tp-empty'), /No item in the list matches/);
      assert.match(await text(page, '#tp-asof'), new RegExp(`^Item list as of ${esc(ASOF)}: ${COUNT} items`));
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: the shown items\' prices come in one request of 50 ids or fewer, with icons in one more; values, quantities and missing sides read right', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await typeTp(page, 'iron sword');
      await idle(page);
      const ids = await shownIds(page);
      const want = Catalog.search(CAT, { query: 'iron sword' }).indexes.slice(0, 50).map((i) => CAT.ids[i]);
      assert.deepEqual(ids, want, 'the same order as the module in Node');
      // The search's own requests (Market Watch asked for its eight when the home opened).
      const prices = page.apiRequests.filter((u) => /commerce\/prices/.test(u) && !isHome(u)), items = page.apiRequests.filter((u) => /\/v2\/items/.test(u) && !isHome(u));
      assert.equal(prices.length, 1, prices.join('\n'));
      assert.equal(items.length, 1);
      const sent = new URL(prices[0]).searchParams.get('ids').split(',').map(Number);
      assert.deepEqual(sent, [...ids].sort((a, b) => a - b), 'exactly the shown ids, sorted');
      assert.ok(prices.every((u) => /[?&]v=2025-08-29T01%3A00%3A00Z/.test(u)), 'the schema version on every request');
      const r = await rowsText(page);
      const noBuys = ids.indexOf(26332); // Berserker's Iron Sword: no buy orders on 2026-11-15
      assert.ok(noBuys >= 0, 'in the first 50');
      assert.equal(await page.eval(`document.querySelectorAll('#tp-results .tp-row')[${noBuys}].querySelector('.tp-buy').textContent`), 'Highest buy order: Buyno buy orders', r[noBuys]);
      assert.ok(!/\b0c\b/.test(r[noBuys]), 'a missing side is never 0c');
      const q = Money.quote(priceOf(ids[0]));
      const first = await page.eval("document.querySelector('#tp-results .tp-row .tp-sell').textContent");
      assert.ok(first.includes(Money.coins(q.sell).spoken) && first.includes(`${Money.count(q.sellQty)} listed`), first);
      await page.waitFor("document.querySelectorAll('#tp-results .tp-icon img').length > 0");
      assert.match(await text(page, '#tp-prices-text'), /^Prices received 7:00 AM, current\.$/);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    // An item the API no longer prices (left out of a 206, or a 404 for all): said so, not "loading" or a price.
    const gone = await open({ at: AT, api: api({ missing: new Set([19721]) }), url: BASE + '#market', wait: false });
    try {
      await market(gone);
      await typeTp(gone, 'glob'); await idle(gone);
      assert.equal(await gone.eval("document.querySelector('[data-id=\"19721\"] .tp-sell').textContent"), 'Lowest sell listing: Sellnot on the Trading Post now');
      assert.match(await gone.eval("document.querySelector('[data-id=\"98002\"] .tp-sell').textContent"), /gold/, 'the other one has its price (a 206)');
      assert.ok(gone.apiRequests.some((u) => /commerce\/prices/.test(u)), 'asked');
    } finally { await gone.close(); }
  });

  // ---- Sorting and what it covers ----

  const quoteOf = (id) => Money.quote(priceOf(id));
  const expectedSort = (query, key, dir) => {
    const r = Catalog.search(CAT, { query });
    const idx = r.status === 'ok' ? r.indexes : CAT.order.slice();
    return Catalog.priceSort(CAT, idx, key, dir, quoteOf);
  };

  check('Trading Post: a price sort over 1,000 matches or fewer loads every match\'s price and ranks them all, missing sides last, and says it is not the whole market', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await sleep(500);
      assert.deepEqual(page.apiRequests.filter((u) => !isHome(u)), [], 'nothing but the home\'s requests before a search');
      await typeTp(page, 'iron sword');
      await idle(page);
      await select(page, 'tp-sort', 'sell-desc');
      await page.waitFor("/among all 358 matching items/.test(document.getElementById('tp-scope').textContent)", 15000);
      const want = expectedSort('iron sword', 'sell', 'desc');
      assert.deepEqual(await shownIds(page), want.order.slice(0, 50).map((i) => CAT.ids[i]), 'the ranking computed in Node');
      const scope = await text(page, '#tp-scope');
      assert.ok(scope.startsWith('Ranked by lowest sell listing, high to low, among all 358 matching items. Not a ranking of the whole market.'), scope);
      if (want.noSide) assert.ok(scope.includes(`${want.noSide} ${want.noSide === 1 ? 'item' : 'items'} with no sell listings come after the ranked ones.`), scope);
      const prices = page.apiRequests.filter((u) => /commerce\/prices/.test(u)).map((u) => new URL(u).searchParams.get('ids').split(',').length);
      assert.ok(prices.every((n) => n <= 200) && prices.reduce((a, b) => a + b, 0) <= 358 + 50, `batches of 200 at most: ${prices}`);
      // Low to high, then the margin: the order follows, and a missing side never ranks as 0.
      await select(page, 'tp-sort', 'buy-asc'); await idle(page);
      const asc = expectedSort('iron sword', 'buy', 'asc');
      assert.deepEqual(await shownIds(page), asc.order.slice(0, 50).map((i) => CAT.ids[i]));
      assert.ok(!(await rowsText(page))[0].includes('no buy orders'), 'no row without buy orders heads a low-to-high sort');
      await select(page, 'tp-sort', 'margin-desc'); await idle(page);
      assert.deepEqual(await shownIds(page), expectedSort('iron sword', 'margin', 'desc').order.slice(0, 50).map((i) => CAT.ids[i]));
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: over 1,000 matches a price sort ranks only the loaded prices, says so, and asks for nothing more until Show more or Load whole market', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await typeTp(page, 'sword'); await idle(page);
      const before = page.apiRequests.length;
      await select(page, 'tp-sort', 'sell-desc'); await sleep(800); await idle(page);
      assert.equal(page.apiRequests.length, before, 'no request for the other 1,025 matches');
      const scope = await text(page, '#tp-scope');
      assert.ok(scope.startsWith('Ranked by lowest sell listing, high to low, among only the 50 of 1,075 matching items whose prices are loaded. Not a ranking of every match, or of the whole market. To rank every match, narrow the search to 1,000 items or fewer, or load the whole market.'), scope);
      await click(page, '#tp-more'); await sleep(400); await idle(page);
      assert.match(await text(page, '#tp-scope'), /among only the 100 of 1,075 matching items/);
      // A new search starts again at 50 rows.
      await typeTp(page, 'swor'); await idle(page);
      assert.equal(await page.eval("document.querySelectorAll('#tp-results .tp-row').length"), 50);
      // With nothing typed, a price sort ranks the whole list, among the loaded prices only.
      await typeTp(page, ''); await idle(page);
      assert.match(await text(page, '#tp-scope'), new RegExp(`^Ranked by lowest sell listing, high to low, among only the \\d+ of ${COUNT} matching items whose prices are loaded\\. Not a ranking of every match, or of the whole market\\.`));
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: Load whole market never starts by itself; it says what it costs, shows progress, can be cancelled, reports a partial load, and then ranks the whole market', async () => {
    let mode = 'ok';
    const page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ delay: 30, answer: (n, u) => (mode === 'partial' && /commerce\/prices/.test(u.pathname) && n % 9 === 0 ? 400 : 'ok') }) });
    try {
      await market(page);
      await sleep(1500);
      assert.deepEqual(page.apiRequests.filter((u) => !isHome(u)), [], 'nothing loads by itself (but the home\'s requests)');
      const box = () => page.eval("[document.getElementById('tp-whole-confirm').hidden, document.getElementById('tp-whole-btn').getAttribute('aria-expanded')]");
      assert.deepEqual(await box(), [true, 'false'], 'the explanation waits to be asked for');
      await click(page, '#tp-whole-btn'); await settle();
      assert.deepEqual(await box(), [false, 'true']);
      const ex = await text(page, '#tp-whole-explain');
      assert.match(ex, new RegExp(`${COUNT} items, ${REQS} requests of 200 \\(Phase A measured about 142 for the whole Trading Post\\)`));
      assert.match(ex, /kept only while this page is open, and nothing is saved/);
      assert.deepEqual(page.apiRequests.filter((u) => !isHome(u)), [], 'still nothing before Load');
      assert.equal(await page.eval("document.activeElement.id"), 'tp-whole-start');
      // Cancel after a few requests.
      await click(page, '#tp-whole-start');
      await page.waitFor("document.getElementById('tp-whole-bar').value >= 6", 15000);
      assert.equal(await page.eval("document.getElementById('tp-whole-progress').hidden"), false);
      assert.equal(await page.eval("document.getElementById('tp-whole-confirm').hidden"), true, 'the explanation folds away while it loads');
      await click(page, '#tp-whole-cancel');
      await page.waitFor(`/^Cancelled after \\d+ of ${REQS} requests\\./.test(document.getElementById('tp-whole-status').textContent)`, 10000);
      const atCancel = page.apiRequests.length;
      await sleep(1500);
      assert.ok(page.apiRequests.length <= atCancel, 'nothing more after Cancel');
      assert.ok(atCancel < 60, `cancelled early (${atCancel})`);
      // A partial load: some requests refused.
      mode = 'partial';
      await click(page, '#tp-whole-btn'); await click(page, '#tp-whole-start');
      await page.waitFor("/^Partly loaded/.test(document.getElementById('tp-whole-status').textContent)", 90000);
      assert.match(await text(page, '#tp-whole-status'), new RegExp(`^Partly loaded \\(.+\\): \\d+ of ${REQS} requests failed \\(ArenaNet's API refused the request\\)\\. [\\d,]+ items have a price; price sorts are partial\\. Load again to try the rest\\.$`));
      await select(page, 'tp-sort', 'sell-desc'); await idle(page);
      assert.match(await text(page, '#tp-scope'), new RegExp(`among only the [\\d,]+ of ${COUNT} matching items whose prices are loaded\\. Not a ranking of every match, or of the whole market\\.`));
      assert.ok(page.apiMaxLive <= 4, `at most 4 requests in flight (${page.apiMaxLive})`);
      // A complete load: the whole market, ranked.
      mode = 'ok';
      await click(page, '#tp-whole-btn'); await click(page, '#tp-whole-start');
      await page.waitFor("/^Whole market loaded/.test(document.getElementById('tp-whole-status').textContent)", 90000);
      assert.match(await text(page, '#tp-whole-status'), /^Whole market loaded \(.+\): prices for every item in the list\. It can be loaded again from .+\.$/);
      await idle(page);
      assert.equal(await text(page, '#tp-scope'), `Ranked by lowest sell listing, high to low, across the whole market: all ${COUNT} items in the item list, from the whole-market load. ` + (() => { const w = expectedSort('', 'sell', 'desc'); return `${w.noSide.toLocaleString('en-US')} items with no sell listings come after the ranked ones.`; })());
      assert.deepEqual(await shownIds(page), expectedSort('', 'sell', 'desc').order.slice(0, 50).map((i) => CAT.ids[i]), 'the top of the whole market');
      assert.equal(await page.eval("document.getElementById('tp-whole-btn').hidden"), true, 'not again for 5 minutes');
      const batches = page.apiRequests.filter((u) => /commerce\/prices/.test(u)).map((u) => new URL(u).searchParams.get('ids').split(',').length);
      assert.ok(batches.every((n) => n <= 200), 'batches of 200 at most');
      assert.ok(page.apiMaxLive <= 4, `at most 4 requests in flight (${page.apiMaxLive})`);
      assert.deepEqual(await page.eval("Object.keys(localStorage).filter((k) => !/tp-favorites|prefs|news/.test(k))"), [], 'no price is saved');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  // ---- When the API does not answer ----

  check('Trading Post: when the API cannot be reached or answers 429, no price is shown and nothing is estimated; requests are tried again after 2, 4 and 8 s; Try again recovers', async () => {
    for (const how of ['offline', 429, 'no-cors-429']) {
      let fail = true;
      const page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ answer: (n, u) => (fail && /commerce\/prices/.test(u.pathname) ? how : 'ok') }) });
      try {
        await market(page);
        await typeTp(page, 'glob of ecto');
        const t0 = Date.now();
        await page.waitFor("/^ArenaNet's API/.test(document.getElementById('tp-prices-text').textContent)", 30000);
        const waited = Date.now() - t0;
        const said = await text(page, '#tp-prices-text');
        assert.equal(said, `${how === 429 ? "ArenaNet's API asked for fewer requests (HTTP 429)" : "ArenaNet's API could not be reached"}, so 1 item has no price here. Nothing is estimated in its place.`, String(how));
        assert.equal(page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length, 4, `${how}: one try and three more`);
        assert.ok(waited >= 13000, `${how}: waited ${waited} ms`);
        const r = (await rowsText(page))[0];
        assert.ok(/Highest buy order: Buynot loaded/.test(await page.eval("document.querySelector('#tp-results .tp-buy').textContent")) && !/\d+c/.test(r), r);
        assert.equal(await text(page, '#tp-results .tp-note'), how === 429 ? "No price: ArenaNet's API asked for fewer requests (HTTP 429)." : "No price: ArenaNet's API could not be reached.", `${how}: the row says why`);
        assert.equal(await text(page, '#tp-refresh'), 'Try again');
        fail = false;
        await click(page, '#tp-refresh');
        await page.waitFor("/current/.test(document.getElementById('tp-prices-text').textContent)", 10000);
        assert.match(await page.eval("document.querySelector('#tp-results .tp-sell').textContent"), /19 silver 10 copper/);
        assert.equal(await page.eval("document.querySelector('#tp-results .tp-note').hidden"), true, 'the note goes with the failure');
        assert.deepEqual(unexpected(page, NET), []);
      } finally { await page.close(); }
    }
  });

  check('Trading Post: prices that age say so: stale after 5 minutes (with Refresh), old and faded after an hour; an older price is kept with its time while a refresh has no answer', async () => {
    let hold = false;
    const page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ answer: () => (hold ? 'hold' : 'ok') }) });
    try {
      await market(page);
      await typeTp(page, 'glob'); await idle(page);
      assert.match(await text(page, '#tp-prices-text'), /^Prices received 7:00 AM, current\.$/);
      hold = true;
      const later = (ms) => page.eval(`(() => { const prev = Date.now; Date.now = () => prev() + ${ms}; })()`);
      await later(12 * 60000);
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await sleep(400);
      const stale = await text(page, '#tp-prices-text');
      assert.equal(stale, 'Loading prices for 2 items... Prices received 7:00 AM, 12 minutes ago: stale.', 'no "Refresh" while a refresh is on its way');
      assert.equal(await page.eval("document.getElementById('tp-prices').dataset.fresh"), 'stale');
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((r) => [r.classList.contains('is-stale'), r.querySelector('.tp-note').textContent])"), [[true, 'Stale price, received 12 minutes ago.'], [true, 'Stale price, received 12 minutes ago.']]);
      assert.deepEqual(await lowContrast(page, '#tp-results .tp-note'), [], 'the note is readable (dark)');
      assert.match(await page.eval("document.querySelector('#tp-results .tp-sell').textContent"), /silver|gold|copper/, 'the older price stays');
      await later(60 * 60000);
      await page.eval("document.getElementById('tp-favs').click()"); await page.eval("document.getElementById('tp-favs').click()"); await sleep(300);
      assert.equal(await text(page, '#tp-prices-text'), 'Loading prices for 2 items... Prices received 7:00 AM, 72 minutes ago: old, shown faded.');
      // The refresh gives up (the API holds): the older prices stay, said with their age, and Refresh is offered.
      await page.waitFor("/could not/.test(document.getElementById('tp-prices-text').textContent)", 70000);
      assert.match(await text(page, '#tp-prices-text'), /^ArenaNet's API did not answer in time, so some prices could not be refreshed\. Nothing is estimated in its place\. Prices received 7:00 AM, 7\d minutes ago: old, shown faded\. Refresh for current prices\.$/);
      assert.equal(await page.eval("document.getElementById('tp-refresh').hidden"), false);
      assert.equal(await page.eval("document.querySelectorAll('#tp-results .tp-row.is-old').length"), 2, 'faded');
      assert.match(await text(page, '#tp-results .tp-note'), /^Old price, received 7\d minutes ago\. A newer price could not be loaded: ArenaNet's API did not answer in time\.$/);
      assert.deepEqual(await lowContrast(page, '#tp-results .tp-row.is-old .coin, #tp-results .tp-row.is-old .tp-q'), [], 'faded, still readable');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  check('Trading Post: prices fetched at different times say so, from the oldest to the newest, and the freshness is the oldest\'s', async () => {
    const page = await open({ at: AT, url: BASE + '#market', wait: false, api: api() });
    try {
      await market(page);
      await typeTp(page, 'glob of ecto'); await idle(page);
      await page.eval('(() => { const prev = Date.now; Date.now = () => prev() + 3 * 60000; })()');
      await typeTp(page, 'glob'); await idle(page);
      assert.equal(await text(page, '#tp-prices-text'), 'Prices received 7:00 AM to 7:03 AM, current.', 'Glob of Ectoplasm kept from 7:00, the other fetched at 7:03');
      await page.eval('(() => { const prev = Date.now; Date.now = () => prev() + 3 * 60000; })()');
      await page.eval("document.getElementById('tp-favs').click()"); await page.eval("document.getElementById('tp-favs').click()"); await idle(page);
      assert.equal(await text(page, '#tp-prices-text'), 'Prices received 7:03 AM to 7:06 AM, current.', 'past 5 minutes the 7:00 price was asked again');
      // Refresh asks again even for current prices: one request for both rows, then one time.
      const before = page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length;
      await click(page, '#tp-refresh'); await idle(page);
      assert.equal(page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length, before + 1);
      assert.equal(await text(page, '#tp-prices-text'), 'Prices received 7:06 AM, current.');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: each row says its own price state: an unreadable price is "not loaded" with why, never "not on the Trading Post"; an item the API has no price for says so; a stale mark follows the clock in place', async () => {
    const DRAGON = CAT.ids[CAT.names.indexOf('Glob of Dragonvoid Aether')];
    let bad = true;
    const spoil = (rows) => (bad ? rows.map((r) => (r.id === 19721 ? { ...r, sells: { quantity: 'many', unit_price: r.sells.unit_price } } : r)) : rows);
    const page = await open({ at: AT, url: BASE + '#market', wait: false, seed: { [h.reminders.PREFS]: { theme: 'light' } }, api: api({ missing: new Set([DRAGON]), mangle: spoil }) });
    try {
      await market(page);
      await typeTp(page, 'glob'); await idle(page);
      const cellOf = (id, cls) => page.eval(`document.querySelector('#tp-results [data-id="${id}"] .${cls}').textContent`);
      const noteOf = (id) => page.eval(`(() => { const n = document.querySelector('#tp-results [data-id="${id}"] .tp-note'); return n.hidden ? null : n.textContent; })()`);
      assert.equal(await cellOf(19721, 'tp-buy'), 'Highest buy order: Buynot loaded');
      assert.equal(await noteOf(19721), "No price: ArenaNet's API sent something this page cannot read.");
      assert.equal(await cellOf(DRAGON, 'tp-sell'), 'Lowest sell listing: Sellnot on the Trading Post now');
      assert.equal(await noteOf(DRAGON), null, 'an item the API has no price for is not a failure');
      assert.equal(await text(page, '#tp-prices-text'), "ArenaNet's API sent something this page cannot read, so 1 item has no price here. Nothing is estimated in its place.");
      await click(page, '#tp-results [data-id="19721"] a.tp-name');
      await page.waitFor("document.getElementById('tp-item-dialog').open && /cannot read/.test(document.getElementById('tp-item-body').textContent)");
      assert.match(await text(page, '#tp-item-body'), /Prices\s*ArenaNet's API sent something this page cannot read\. No price is shown; nothing is estimated\./);
      await key(page, 'Escape', 'Escape', 27); await settle();
      // Readable again: the price comes, the note goes; then 6 minutes on, the 30-second tick marks the same row stale.
      bad = false;
      await click(page, '#tp-refresh');
      await page.waitFor("/current/.test(document.getElementById('tp-prices-text').textContent)", 10000);
      assert.equal(await noteOf(19721), null);
      await page.eval("document.querySelector('#tp-results [data-id=\"19721\"]').dataset.mark = 'kept'");
      await page.eval("(() => { const prev = Date.now; Date.now = () => prev() + 6 * 60000; })()");
      await page.waitFor("document.querySelector('#tp-results [data-id=\"19721\"]').classList.contains('is-stale')", 35000);
      assert.equal(await page.eval("document.querySelector('#tp-results [data-id=\"19721\"]').dataset.mark"), 'kept', 'updated in place, not redrawn');
      assert.equal(await noteOf(19721), 'Stale price, received 6 minutes ago.');
      assert.equal(await noteOf(DRAGON), null);
      assert.equal(await text(page, '#tp-prices-text'), 'Prices received 7:00 AM, 6 minutes ago: stale. Refresh for current prices.');
      assert.deepEqual(await lowContrast(page, '#tp-results .tp-note, #tp-results .tp-none'), [], 'readable (light)');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  check('Trading Post: at a price of a few copper the 1c minimum fees take all of it, and the details say so in words; the margin is a loss, never a profit', async () => {
    const tiny = new Map([[19721, { id: 19721, whitelisted: false, buys: { quantity: 40, unit_price: 1 }, sells: { quantity: 12, unit_price: 2 } }]]);
    const page = await open({ at: AT, url: BASE + '#market/item/19721', wait: false, api: api({ prices: tiny }) });
    try {
      await page.waitFor("document.getElementById('tp-item-dialog').open && /current/.test(document.getElementById('tp-item-body').textContent)", 15000);
      const body = await page.eval("(() => { const c = document.getElementById('tp-item-body').cloneNode(true); for (const s of c.querySelectorAll('.sr-only')) s.remove(); return c.textContent.replace(/\\s+/g, ' '); })()");
      const c = (n) => Money.coins(n).text;
      const all = 'At this price the fees, at least 1 copper each, take all of it.';
      for (const want of [`Highest buy order ${c(1)}`, `Lowest sell listing ${c(2)}`, `Spread ${c(1)}`,
        `would give you about ${c(-1)} after the listing fee of ${c(1)} and the exchange fee of ${c(1)}. ${all}`,
        `would give you about ${c(0)} after fees, only if it sells: someone may list lower, and it may not sell. ${all}`,
        `Potential margin ${c(-1)} ${Money.percent(-1)} of the highest buy order, after fees`, `Break-even listing price ${c(3)}`, `Listing one unit at ${c(3)}`, `A gain of 1 copper or more starts at ${c(4)}`, `The lowest sell listing, ${c(2)}`, 'is below it: listing there now would lose', 'A potential margin, not a profit']) {
        assert.ok(body.replace(/\s+/g, '').includes(want.replace(/\s+/g, '')), `${want}\n in: ${body}`);
      }
      assert.match(await page.eval("document.getElementById('tp-item-body').textContent"), /a loss of 1 copper/, 'a screen reader hears a loss');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
    // The lowest sell listing exactly at the break-even (17s 10c buy, 20s 12c sell): at or above it, not below.
    const even = new Map([[24295, { id: 24295, whitelisted: false, buys: { quantity: 40, unit_price: 1710 }, sells: { quantity: 12, unit_price: 2012 } }]]);
    const p2 = await open({ at: AT, url: BASE + '#market/item/24295', wait: false, api: api({ prices: even }) });
    try {
      await p2.waitFor("document.getElementById('tp-item-dialog').open && document.querySelector('#tp-item-body .tp-stats')", 15000);
      const b2 = await p2.eval("(() => { const c = document.getElementById('tp-item-body').cloneNode(true); for (const s of c.querySelectorAll('.sr-only')) s.remove(); return c.textContent.replace(/\\s+/g, ' '); })()");
      const flat = b2.replace(/\s+/g, '');
      assert.ok(flat.includes('Thelowestselllisting,20s12c,isatoraboveit.'), b2);
      assert.ok(flat.includes('Potentialmargin0c0.0%ofthehighestbuyorder'), 'listing at the break-even gives back the cost: 0c');
      assert.ok(flat.includes('Break-evenlistingprice20s12c'), b2);
    } finally { await p2.close(); }
  });

  check('Trading Post: a 429 holds the whole queue for its wait, then the prices come; a new search cancels the requests of the one it replaces', async () => {
    let n429 = 0;
    const page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ delay: 600, answer: (n, u) => (/commerce\/prices/.test(u.pathname) && n429++ === 0 ? 429 : 'ok') }) });
    const cancelled = [];
    page.on('Network.loadingFailed', (p) => { if (p.canceled) cancelled.push(p.requestId); });
    try {
      await market(page);
      await typeTp(page, 'glob of ecto');
      await page.waitFor("/waiting/.test((document.querySelector('#tp-results .tp-buy') || {}).textContent || '')", 5000);
      assert.equal(await text(page, '#tp-results .tp-note'), "Waiting: ArenaNet's API asked for fewer requests (HTTP 429).");
      assert.equal(await text(page, '#tp-prices-text'), "Loading prices for 1 item: ArenaNet's API asked for fewer requests (HTTP 429), so the page waits before asking again.");
      await page.waitFor("/current/.test(document.getElementById('tp-prices-text').textContent)", 15000);
      assert.equal(await page.eval("document.querySelector('#tp-results .tp-note').hidden"), true, 'no note once the price is there');
      const log = page.apiRequests.filter((u) => /commerce\/prices/.test(u));
      assert.equal(log.length, 2, 'the 429, then one more try');
      // Typing on: each search's requests give way to the next one's.
      await typeTp(page, 'iron');
      await typeTp(page, 'iron s');
      await typeTp(page, 'iron sw');
      await idle(page);
      await page.waitFor("/current/.test(document.getElementById('tp-prices-text').textContent)", 15000);
      assert.ok(cancelled.length >= 1 || (page.apiGone || 0) >= 1, 'a replaced search\'s request was cancelled');
      const ids = await shownIds(page);
      assert.deepEqual(ids, Catalog.search(CAT, { query: 'iron sw' }).indexes.slice(0, 50).map((i) => CAT.ids[i]));
      assert.ok(!(await rowsText(page)).some((t) => /not loaded/.test(t)), 'every shown price is there');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  // ---- The price filters (v0.5.0 Phase 2) ----
  // What should pass is worked out here from the raw price rows, by plain comparisons, not by the page's own code.

  const pfNet = (p) => p - Math.max(1, Math.floor((p * 5 + 50) / 100)) - Math.max(1, Math.floor((p * 10 + 50) / 100));
  const pfOracle = (row, f) => {
    const b = row.buys.quantity > 0 ? row.buys.unit_price : null, s = row.sells.quantity > 0 ? row.sells.unit_price : null, m = b !== null && s !== null ? pfNet(s) - b : null;
    const has = (k) => f[k] !== undefined;
    return !(has('buyMin') && !(b !== null && b >= f.buyMin)) && !(has('buyMax') && !(b !== null && b <= f.buyMax)) && !(has('sellMin') && !(s !== null && s >= f.sellMin)) && !(has('sellMax') && !(s !== null && s <= f.sellMax))
      && !(has('marginMin') && !(m !== null && m >= f.marginMin)) && !(has('pctMin') && !(m !== null && m * 1000 >= f.pctMin * b)) && !(has('wantedMin') && !(row.buys.quantity >= f.wantedMin)) && !(has('listedMin') && !(row.sells.quantity >= f.listedMin));
  };
  const IRON = Catalog.search(CAT, { query: 'iron sw' }).indexes.map((i) => CAT.ids[i]);
  const pfWant = (ids, f, rowOf = priceOf) => ids.filter((id) => pfOracle(rowOf(id), f));
  const openPf = async (page) => { if (await page.eval("document.getElementById('tp-pf-toggle').getAttribute('aria-expanded')") !== 'true') await click(page, '#tp-pf-toggle'); };
  // Typed as a reader types; the page reads it 300 ms after the last key.
  const setPf = async (page, key, t, wait = 500) => {
    await page.eval(`(() => { const i = document.getElementById('tp-pf-${key}'); i.focus(); i.select(); })()`);
    if (t === '') await page.eval(`(() => { const i = document.getElementById('tp-pf-${key}'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    else await page.send('Input.insertText', { text: t });
    if (wait) await sleep(wait);
  };
  const pfIdle = (page) => page.waitFor("!document.querySelector('#tp-results[aria-busy=\"true\"]') && !/Loading/.test(document.getElementById('tp-scope').textContent + document.getElementById('tp-fscope').textContent)", 20000);
  const pfLook = (page) => page.eval("({ fscope: document.getElementById('tp-fscope').hidden ? '' : document.getElementById('tp-fscope').textContent, toggle: document.getElementById('tp-pf-toggle').textContent, said: document.getElementById('tp-pf-said').textContent, err: document.getElementById('tp-pf-err').hidden ? '' : document.getElementById('tp-pf-err').textContent, crumb: document.getElementById('tp-crumbs').hidden ? '' : document.getElementById('tp-crumb').textContent, scope: document.getElementById('tp-scope').textContent, empty: document.getElementById('tp-empty').hidden ? '' : document.getElementById('tp-empty').textContent })");
  const pfRows = (page) => page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((r) => [Number(r.dataset.id), r.dataset.pf || '', (r.querySelector('.tp-note') || {}).hidden ? '' : r.querySelector('.tp-note').textContent])");
  const priceReqs = (page, from = 0) => page.apiRequests.slice(from).filter((u) => /commerce\/prices\?/.test(u)).map((u) => new URL(u).searchParams.get('ids').split(',').map(Number));
  const ft = (o) => Market.filterText(Object.assign({ loading: false, failedLoad: false, listCount: CAT.count, filtered: true, wholeAll: false }, o));

  check('Trading Post price filters: each of the eight narrows the results to the items whose loaded price passes, both ends of a range included; together every one must hold; the line under the sort gives the three counts; every match is priced in at most 5 requests, and a new threshold asks for nothing', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await typeTp(page, 'iron sw'); await idle(page);
      const M = IRON.length;
      assert.ok(M > 300 && M <= 1000, String(M));
      assert.deepEqual([(await pfLook(page)).fscope, await text(page, '#tp-pf-toggle'), await page.eval("document.getElementById('tp-pf-panel').hidden")], ['', 'Price filters', true], 'closed and silent until asked for');
      const n0 = page.apiRequests.length;
      await click(page, '#tp-pf-toggle');
      assert.deepEqual(await page.eval("[document.getElementById('tp-pf-panel').hidden, document.getElementById('tp-pf-toggle').getAttribute('aria-expanded'), document.activeElement.id]"), [false, 'true', 'tp-pf-buyMin']);
      // One filter: sell listing at least 15g. Every match's price is asked for (the 50 shown were there already).
      const shows = async (f, why) => {
        const want = pfWant(IRON, f), l = await pfLook(page), rows = await pfRows(page);
        assert.deepEqual(rows.map((r) => r[0]), want.slice(0, 50), `${why}: the rows are the ones that pass, in the search's order`);
        assert.ok(rows.every((r) => r[1] === 'pass'), `${why}: every row marked as passing`);
        assert.equal(l.fscope, ft({ matches: M, passed: want.length, failed: M - want.length, unchecked: 0 }), why);
        return want;
      };
      await setPf(page, 'sellMin', '15g'); await pfIdle(page);
      const reqs = priceReqs(page, n0);
      assert.ok(reqs.length >= 1 && reqs.length <= 5, `${reqs.length} price requests for the filter`);
      assert.deepEqual(reqs.flat().sort((a, b) => a - b), IRON.filter((id) => !IRON.slice(0, 50).includes(id)).sort((a, b) => a - b), 'exactly the matches not priced yet, each once');
      const w1 = await shows({ sellMin: 150000 }, 'sell from 15g');
      assert.ok(w1.length > 20 && w1.length < M - 20, `a real cut: ${w1.length} of ${M}`);
      let l = await pfLook(page);
      assert.deepEqual([l.toggle, l.said, l.err, l.crumb], ['Price filters (1 set)', 'Applied: lowest sell listing from 15g 00s 00c.', '', '“iron sw” · 1 price filter']);
      assert.equal(await page.eval("document.getElementById('tp-pf-clear').getClientRects().length > 0"), true, 'Clear price filters is offered while one is typed');
      assert.equal(await text(page, '#tp-count'), `${M} items match “iron sw”.`, 'the count of matches is the search\'s, as before');
      const n1 = page.apiRequests.length;
      // Both ends of a range are included: an item sitting exactly on a bound passes, one copper further it does not.
      const edge = priceOf(w1[0]).sells.unit_price;
      await setPf(page, 'sellMin', Money.coins(edge).text); await setPf(page, 'sellMax', Money.coins(edge).text);
      const on = await shows({ sellMin: edge, sellMax: edge }, 'from and to on one price');
      assert.ok(on.includes(w1[0]));
      await setPf(page, 'sellMin', Money.coins(edge + 1).text); await setPf(page, 'sellMax', '');
      assert.ok(!(await shows({ sellMin: edge + 1 }, 'one copper above')).includes(w1[0]));
      await setPf(page, 'sellMin', ''); await setPf(page, 'sellMax', Money.coins(edge - 1).text);
      assert.ok(!(await shows({ sellMax: edge - 1 }, 'one copper below')).includes(w1[0]));
      await setPf(page, 'sellMax', '');
      assert.deepEqual([(await pfLook(page)).fscope, (await pfRows(page)).length, (await pfRows(page))[0][1]], ['', 50, ''], 'no filter set: every match again, no line, no marks');
      // Each of the others alone, then all together.
      const each = { buyMin: ['20s', 2000], buyMax: ['5g', 50000], sellMin: ['50s', 5000], sellMax: ['30g', 300000], marginMin: ['1s', 100], pctMin: ['5', 50], wantedMin: ['3,000', 3000], listedMin: ['2000', 2000] };
      for (const [key, [typed, value]] of Object.entries(each)) {
        await setPf(page, key, typed);
        const w = await shows({ [key]: value }, key);
        assert.ok(w.length > 0 && w.length < M, `${key}: ${w.length}`);
        await setPf(page, key, '');
      }
      const all = {};
      for (const [key, [typed, value]] of Object.entries(each)) { await setPf(page, key, typed, 0); all[key] = value; }
      await sleep(600);
      const wAll = await shows(all, 'all eight');
      l = await pfLook(page);
      assert.equal(l.toggle, 'Price filters (8 set)');
      assert.equal(l.said, 'Applied: highest buy order from 20s 00c; highest buy order to 5g 00s 00c; lowest sell listing from 50s 00c; lowest sell listing to 30g 00s 00c; potential margin at least 1s 00c; potential margin % at least 5.0%; total queued units wanted, in all buy orders, at least 3,000; total queued units listed, in all sell listings, at least 2,000.');
      // A price sort ranks the ones that pass, and says so.
      await select(page, 'tp-sort', 'margin-desc'); await pfIdle(page);
      const ranked = wAll.slice().sort((a, b) => quoteOf(b).margin - quoteOf(a).margin || CAT.pos[CAT.byId.get(a)] - CAT.pos[CAT.byId.get(b)]);
      assert.deepEqual((await pfRows(page)).map((r) => r[0]), ranked.slice(0, 50));
      assert.equal((await pfLook(page)).scope, `Ranked by potential margin after fees, largest first, among the ${wAll.length} items that pass the price filters. Not a ranking of the whole market.`);
      await select(page, 'tp-sort', 'relevance'); await pfIdle(page);
      // Nothing passes: said, with the count checked, and that nothing was left out for want of a price.
      await click(page, '#tp-pf-clear'); await sleep(200);
      await setPf(page, 'buyMin', '9,000g');
      l = await pfLook(page);
      assert.deepEqual([(await pfRows(page)).length, l.empty, l.fscope], [0, `No item passes the price filters: ${M} matches were checked, and none passes. Nothing is hidden for want of a price.`, ft({ matches: M, passed: 0, failed: M, unchecked: 0 })]);
      // All of that, after the first filter, asked ArenaNet for no price: every one was current.
      assert.deepEqual(priceReqs(page, n1), [], 'no price request for any change of threshold or sort');
      // Clear: every match again.
      await click(page, '#tp-pf-clear'); await sleep(200);
      assert.deepEqual([(await pfLook(page)).fscope, (await pfLook(page)).toggle, (await pfRows(page)).length, await page.eval("[...document.querySelectorAll('#tp-pf-panel input')].map((i) => i.value).join('')"), await page.eval('document.activeElement.id')], ['', 'Price filters', 50, '', 'tp-pf-toggle']);
      assert.equal(await page.eval("document.getElementById('tp-pf-clear').getClientRects().length"), 0, 'and not when none is: it is not on screen');
      assert.equal(await page.eval('location.hash'), '#market', 'nothing of the filters is in the address');
      assert.deepEqual(await page.eval("Object.entries(localStorage).concat(Object.entries(sessionStorage)).filter(([k, v]) => /pf|filter|15g|9,000g|150000/i.test(k + ' ' + v)).map(([k]) => k)"), [], 'and nothing of them is saved');
      if (SHOTS) { await setPf(page, 'sellMin', '1g'); await setPf(page, 'wantedMin', '2,000'); await page.screenshot(join(SHOTS, 'filters-1280.png'), true); }
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post price filters: a field that cannot be read is said and not applied, the others still are; a range upside down is refused, never swapped', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await typeTp(page, 'iron sw'); await idle(page);
      await openPf(page);
      await setPf(page, 'buyMin', '2.5g'); await pfIdle(page);
      let l = await pfLook(page);
      assert.deepEqual([l.err, l.fscope, l.toggle, (await pfRows(page)).length], ['Highest buy order from: “2.5g” is not a coin amount. Type one like 2g 50s 10c, 75s or 40c. It is not applied.', '', 'Price filters', 50], 'not applied: every match still shown');
      assert.deepEqual(await page.eval("[document.getElementById('tp-pf-buyMin').getAttribute('aria-invalid'), document.getElementById('tp-pf-err').getAttribute('role'), document.getElementById('tp-pf-buyMin').getAttribute('aria-describedby')]"), ['true', 'alert', 'tp-pf-how tp-pf-err']);
      // A good field beside it is applied while the bad one stays refused.
      await setPf(page, 'sellMax', '30s'); await pfIdle(page);
      l = await pfLook(page);
      const want = pfWant(IRON, { sellMax: 3000 });
      assert.deepEqual([l.toggle, l.said, l.err !== '', (await pfRows(page)).map((r) => r[0])], ['Price filters (1 set)', 'Applied: lowest sell listing to 30s 00c.', true, want.slice(0, 50)]);
      await setPf(page, 'buyMin', '');
      assert.deepEqual([(await pfLook(page)).err, await page.eval("document.getElementById('tp-pf-buyMin').getAttribute('aria-invalid')")], ['', null]);
      // From above to: neither end applied, both fields marked, in words.
      await setPf(page, 'sellMin', '2g'); await pfIdle(page);
      l = await pfLook(page);
      assert.deepEqual([l.err, l.toggle, l.fscope, (await pfRows(page)).length], ['Lowest sell listing: from 2g 00s 00c is above to 30s 00c, so nothing could pass. Neither is applied.', 'Price filters', '', 50]);
      assert.deepEqual(await page.eval("['sellMin', 'sellMax'].map((k) => document.getElementById('tp-pf-' + k).getAttribute('aria-invalid'))"), ['true', 'true']);
      // A percentage and a count that are not ones.
      await setPf(page, 'sellMin', ''); await setPf(page, 'sellMax', ''); await setPf(page, 'pctMin', '10.25'); await setPf(page, 'wantedMin', '12k');
      assert.equal((await pfLook(page)).err, 'Potential margin % at least: “10.25” is not a percentage. Type a number like 10 or 12.5. It is not applied. Total queued units wanted, in all buy orders, at least: “12k” is not a whole number of units. It is not applied.');
      assert.deepEqual(await lowContrast(page, '#tp-pf-panel *'), [], 'readable');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post price filters: an item whose price could not be loaded is not checked: listed after the ones that pass and marked, never dropped, never counted as passing or as 0; an item the API has no price for fails; Try again checks them', async () => {
    // The home's price request and the search's (the 50 shown) are answered; while `down`, every later one is refused (HTTP 400, no retry).
    let down = true, seen = 0;
    const gone = IRON[3]; // the API has no price for this one
    const page = await open({ at: AT, api: api({ missing: new Set([gone]), answer: (k, u) => (u.pathname === '/v2/commerce/prices' && ++seen > 2 && down ? 400 : 'ok') }), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await typeTp(page, 'iron sw'); await idle(page);
      assert.equal(seen, 2, 'the home and the search have each asked once, nothing else yet');
      await openPf(page);
      const f = { sellMin: 10000 };
      await setPf(page, 'sellMin', '1g');
      await page.waitFor("/could not be loaded\\.$/.test(document.getElementById('tp-fscope').textContent)", 20000);
      const first = IRON.slice(0, 50), rest = IRON.slice(50);
      const pass = pfWant(first.filter((id) => id !== gone), f);
      const l = await pfLook(page);
      assert.equal(l.fscope, ft({ matches: IRON.length, passed: pass.length, failed: 50 - pass.length, unchecked: rest.length, failedLoad: true }));
      assert.match(l.fscope, /^Price filters: \d+ pass(es)? and \d+ (do|does) not, among only the 50 of 358 matching items whose prices are loaded\. The other 308 are not checked: listed after the ones that pass, and not known to pass or to fail\. Their prices could not be loaded\.$/);
      const rows = await pfRows(page);
      assert.deepEqual(rows.map((r) => r[0]), pass.concat(rest).slice(0, 50), 'the ones that pass, then the ones not checked');
      assert.deepEqual(rows.map((r) => r[1]), pass.map(() => 'pass').concat(rest.map(() => 'unchecked')).slice(0, 50));
      assert.ok(!rows.some((r) => r[0] === gone), 'the item the API has no price for fails: not listed');
      const un = rows.filter((r) => r[1] === 'unchecked');
      assert.ok(un.length > 0 && un.every((r) => r[2] === "Not checked against the price filters: its price could not be loaded. No price: ArenaNet's API refused the request."), JSON.stringify(un[0]));
      assert.equal(await page.eval("document.querySelector('#tp-results .tp-row.is-unchecked .tp-buy').textContent.replace(/\\s+/g, ' ').trim()"), 'Highest buy order: Buynot loaded', 'no price shown for it, and no 0');
      assert.match(await text(page, '#tp-prices-text'), /^ArenaNet's API refused the request, so \d+ items? (has|have) no price here\. Nothing is estimated in its place\./);
      assert.equal(await text(page, '#tp-refresh'), 'Try again');
      assert.deepEqual(await lowContrast(page, '#tp-fscope, #tp-results .tp-row.is-unchecked .tp-note'), [], 'readable');
      // Under a price sort too: the unchecked come after every ranked one, and the line says "so far".
      await select(page, 'tp-sort', 'sell-asc');
      await page.waitFor("/so far/.test(document.getElementById('tp-scope').textContent)", 20000);
      const sorted = await pfRows(page), lastPass = sorted.map((r) => r[1]).lastIndexOf('pass'), firstUn = sorted.map((r) => r[1]).indexOf('unchecked');
      assert.ok(firstUn === -1 || lastPass < firstUn, 'no unchecked row among the ranked ones');
      assert.equal((await pfLook(page)).scope, `Ranked by lowest sell listing, low to high, among the ${pass.length} items that pass the price filters so far. Not a ranking of the whole market.`);
      await select(page, 'tp-sort', 'relevance'); await sleep(300);
      // The API answers again: Try again loads them, and then every match was checked.
      down = false;
      await click(page, '#tp-refresh');
      await page.waitFor("/Every match was checked/.test(document.getElementById('tp-fscope').textContent)", 20000);
      const want = pfWant(IRON.filter((id) => id !== gone), f);
      assert.equal((await pfLook(page)).fscope, ft({ matches: IRON.length, passed: want.length, failed: IRON.length - want.length, unchecked: 0 }));
      assert.deepEqual((await pfRows(page)).map((r) => [r[0], r[1]]), want.slice(0, 50).map((id) => [id, 'pass']));
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  check('Trading Post price filters over more than 1,000 matches or the whole list: only the shown rows are priced, the rest are said to be unchecked, and nothing scans the market until the reader confirms a whole-market load', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page); await watchReady(page);
      const n0 = page.apiRequests.length;
      await openPf(page);
      // Nothing typed and no other filter: the filter leaves the home and covers the whole list, of which 8 prices are loaded.
      await setPf(page, 'sellMin', '1s'); await pfIdle(page);
      assert.equal(await page.eval("document.getElementById('tp-home').hidden"), true);
      let l = await pfLook(page);
      assert.equal(l.crumb, 'Every item · 1 price filter');
      let reqs = priceReqs(page, n0);
      assert.equal(reqs.length, 1, 'one request: the rows shown');
      assert.ok(reqs[0].length <= 50);
      const loaded = new Set([...WATCH, ...reqs[0]]);
      const passed = pfWant([...loaded], { sellMin: 100 }).length;
      assert.equal(l.fscope, ft({ matches: CAT.count, passed, failed: loaded.size - passed, unchecked: CAT.count - loaded.size, filtered: false }));
      assert.match(l.fscope, new RegExp(`among only the ${loaded.size} of ${esc(COUNT)} matching items whose prices are loaded\\. The other [\\d,]+ are not checked: .* To check every match, narrow the search to 1,000 items or fewer, or load the whole market\\.$`));
      const rows = await pfRows(page);
      assert.ok(rows.some((r) => r[1] === 'unchecked' && r[2] === 'Not checked against the price filters: its price is not loaded.'), 'the rows after the passing ones say they are not checked');
      // A type with thousands of items: the same, and still one request for what is shown.
      const n1 = page.apiRequests.length;
      await select(page, 'tp-type', String(CAT.types.indexOf('Weapon'))); await pfIdle(page);
      assert.equal(priceReqs(page, n1).length, 1);
      assert.match((await pfLook(page)).fscope, /To check every match, narrow the search to 1,000 items or fewer, or load the whole market\.$/);
      // Show more prices the rows now shown (the next 50, and any row above them that moved up unchecked), in one
      // request, by the reader's own press, and no more.
      const n2 = page.apiRequests.length;
      await click(page, '#tp-more'); await pfIdle(page);
      reqs = priceReqs(page, n2);
      assert.ok(reqs.length === 1 && reqs[0].length <= 100, JSON.stringify(reqs.map((r) => r.length)));
      await sleep(1500);
      assert.equal(priceReqs(page, n2).length, 1, 'nothing follows on its own');
      assert.equal(await page.eval("document.getElementById('tp-whole-progress').hidden && document.getElementById('tp-whole-confirm').hidden"), true, 'no whole-market load was started');
      // Trading Post home clears the price filters with everything else.
      await click(page, '#tp-home-btn'); await sleep(300);
      assert.deepEqual(await page.eval("[document.getElementById('tp-home').hidden, document.getElementById('tp-pf-sellMin').value, document.getElementById('tp-pf-toggle').textContent, document.getElementById('tp-fscope').hidden]"), [false, '', 'Price filters', true]);
      // With the whole market loaded, by the reader's confirmation, the filter covers every item and says so.
      await click(page, '#tp-whole-btn'); await click(page, '#tp-whole-start');
      await page.waitFor("/^Whole market loaded/.test(document.getElementById('tp-whole-status').textContent)", 90000);
      await setPf(page, 'pctMin', '25'); await setPf(page, 'listedMin', '5,000'); await pfIdle(page);
      const want = pfWant(CAT.ids, { pctMin: 250, listedMin: 5000 });
      l = await pfLook(page);
      assert.equal(l.fscope, ft({ matches: CAT.count, passed: want.length, failed: CAT.count - want.length, unchecked: 0, filtered: false, wholeAll: true }));
      assert.match(l.fscope, new RegExp(`^Price filters: [\\d,]+ of all ${esc(COUNT)} items in the item list pass, from the whole-market load; [\\d,]+ do not\\.$`));
      assert.ok(want.length > 10 && want.length < CAT.count / 2, String(want.length));
      assert.deepEqual((await pfRows(page)).map((r) => r[0]), [...want].sort((a, b) => CAT.pos[CAT.byId.get(a)] - CAT.pos[CAT.byId.get(b)]).slice(0, 50), 'by name, across the whole list');
      // With a type chosen, every one of its items is checked too, but that is no longer the whole market, and the line does not say so.
      await select(page, 'tp-type', String(CAT.types.indexOf('Weapon'))); await pfIdle(page);
      const weapons = CAT.ids.filter((id, i) => CAT.types[CAT.type[i]] === 'Weapon'), wantW = pfWant(weapons, { pctMin: 250, listedMin: 5000 });
      assert.equal((await pfLook(page)).fscope, ft({ matches: weapons.length, passed: wantW.length, failed: weapons.length - wantW.length, unchecked: 0, filtered: true, wholeAll: true }));
      assert.match((await pfLook(page)).fscope, /Every match was checked\. Not a filter of the whole market\.$/);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: prices that are no longer current are asked for again before a sort or a price filter uses them, in at most 5 requests; where they cannot be (over 1,000 matches), the line says how old the oldest is', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await typeTp(page, 'iron sw'); await idle(page);
      await select(page, 'tp-sort', 'sell-desc'); await idle(page);
      const all = [...IRON].sort((a, b) => a - b);
      // Six minutes on (5 min 33 s, so the ages round the same way every run), every price here is stale.
      await later(page, 333000);
      // A new sort: every match's price is asked for again, not only the missing ones.
      let n = page.apiRequests.length;
      await select(page, 'tp-sort', 'margin-desc'); await idle(page);
      let reqs = priceReqs(page, n);
      assert.ok(reqs.length >= 1 && reqs.length <= 5, `${reqs.length} requests`);
      assert.deepEqual(reqs.flat().sort((a, b) => a - b), all, 'every match, each once');
      assert.ok(!/oldest price/.test(await text(page, '#tp-scope')), 'ranked on current prices: no age to report');
      assert.match(await text(page, '#tp-prices-text'), /current\.$/);
      // Stale again, then a price filter: the same.
      await later(page, 333000);
      n = page.apiRequests.length;
      await select(page, 'tp-sort', 'relevance'); await sleep(300);
      const n2 = page.apiRequests.length;
      await openPf(page);
      await setPf(page, 'sellMin', '1g'); await pfIdle(page);
      reqs = priceReqs(page, n2);
      assert.ok(reqs.length >= 1 && reqs.length <= 5, `${reqs.length} requests`);
      assert.deepEqual([...new Set(priceReqs(page, n).flat())].sort((a, b) => a - b), all, 'every match asked for again before it is filtered');
      assert.equal(reqs.flat().length, new Set(reqs.flat()).size, 'no price asked for twice');
      const want = pfWant(IRON, { sellMin: 10000 });
      assert.equal((await pfLook(page)).fscope, ft({ matches: IRON.length, passed: want.length, failed: IRON.length - want.length, unchecked: 0 }), 'all current: no age in the line');
      // Over 1,000 matches the prices cannot all be refreshed without a scan: the line says how old the oldest used is.
      await later(page, 333000);
      await typeTp(page, ''); await pfIdle(page);
      assert.match((await pfLook(page)).fscope, / The oldest price used was received \d+ minutes ago: stale, and may have changed\.$/);
      await click(page, '#tp-pf-clear'); await sleep(200);
      await select(page, 'tp-sort', 'buy-desc'); await idle(page);
      assert.match(await text(page, '#tp-scope'), /^Ranked by highest buy order, high to low, among only the [\d,]+ of [\d,]+ matching items whose prices are loaded\..* The oldest price used was received \d+ minutes ago: stale, and may have changed\.$/);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: a price sort or a price filter over 874 matches prices every one of them in 5 requests, never 6: the rows shown are asked for with the rest, each price once', async () => {
    const CLERIC = Catalog.search(CAT, { query: 'cleric' }).indexes.map((i) => CAT.ids[i]);
    assert.ok(CLERIC.length > 800 && CLERIC.length <= 1000, String(CLERIC.length));
    for (const how of ['sort', 'filter']) {
      const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
      try {
        await market(page); await watchReady(page);
        // The sort or the filter is chosen first, over the whole list (only its shown rows are priced); then the search.
        if (how === 'sort') await select(page, 'tp-sort', 'sell-desc'); else { await openPf(page); await setPf(page, 'sellMin', '1s'); }
        await pfIdle(page);
        const had = new Set(priceReqs(page).flat());
        const n = page.apiRequests.length;
        await typeTp(page, 'cleric'); await pfIdle(page);
        const reqs = priceReqs(page, n), need = CLERIC.filter((id) => !had.has(id)).sort((a, b) => a - b);
        assert.ok(need.length > 800, String(need.length));
        assert.equal(reqs.length, 5, `${how}: ${reqs.map((r) => r.length).join(' + ')} prices`);
        assert.deepEqual(reqs.flat().sort((a, b) => a - b), need, `${how}: every match not priced yet, each once`);
        assert.ok(reqs.every((r) => r.length <= 200));
        assert.ok(!(await rowsText(page)).some((t) => /not requested yet|not loaded|loading/.test(t)), `${how}: every shown row has its price`);
        assert.deepEqual(unexpected(page), []);
      } finally { await page.close(); }
    }
  });

  check('Trading Post price filters on a slow API: typing a search key by key and then editing a filter cancels only what a new search replaces, asks for no price twice, leaves no row unpriced or unchecked, and stays within 5 requests for the search that stands', async () => {
    const page = await open({ at: AT, api: api({ delay: 1200 }), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await openPf(page);
      await setPf(page, 'sellMin', '1g', 350);
      // Typed one key at a time, each key a new search that replaces the one before it.
      await page.eval("document.getElementById('tp-find').focus()");
      let beforeLast = 0;
      for (const ch of 'iron sw') { if (ch === 'w') beforeLast = page.apiRequests.length; await page.send('Input.insertText', { text: ch }); await sleep(150); }
      // While the last search's prices are still on their way (1.2 s each), the filter is edited twice. An edit
      // cancels nothing: were a request cancelled, its prices would have to be asked for a second time.
      await sleep(100);
      await setPf(page, 'sellMin', '2g', 150); await setPf(page, 'wantedMin', '100', 0);
      await pfIdle(page); await sleep(600); await pfIdle(page);
      const f = { sellMin: 20000, wantedMin: 100 }, want = pfWant(IRON, f);
      const rows = await pfRows(page);
      assert.deepEqual(rows.map((r) => [r[0], r[1]]), want.slice(0, 50).map((id) => [id, 'pass']));
      assert.equal((await pfLook(page)).fscope, ft({ matches: IRON.length, passed: want.length, failed: IRON.length - want.length, unchecked: 0 }), 'every match checked');
      assert.ok(!(await rowsText(page)).some((t) => /not requested yet|not loaded|loading/.test(t)), 'no row left without its price');
      // The search that stands ("iron sw", 358 matches) took at most 5 price requests, counting from its last key.
      const last = priceReqs(page, beforeLast);
      assert.ok(last.length >= 1 && last.length <= 5, `${last.length} price requests from the last key on`);
      assert.equal(last.flat().length, new Set(last.flat()).size, 'no price asked for twice: no edit cancelled a request');
      assert.ok(IRON.every((id) => priceReqs(page).flat().includes(id)), 'every match was asked for');
      // Now that everything is current, editing thresholds asks for nothing.
      const n = page.apiRequests.length;
      await setPf(page, 'sellMin', '3g'); await setPf(page, 'pctMin', '2'); await setPf(page, 'pctMin', '');
      assert.deepEqual(priceReqs(page, n), [], 'no price is asked for (rows that come into view may still ask for their icons)');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  check('Trading Post price filters keep to memory: an item\'s details, Back, a switch to the timer and back, and a link to an item all leave them as set; the address never carries them; on a 360 px phone the panel fits and every field is 36 px and named', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false, width: 360, height: 740, mobile: true });
    try {
      await market(page);
      await typeTp(page, 'iron sw'); await idle(page);
      await openPf(page);
      await setPf(page, 'sellMin', '1g'); await setPf(page, 'wantedMin', '500'); await pfIdle(page);
      const f = { sellMin: 10000, wantedMin: 500 }, want = pfWant(IRON, f);
      const same = async (why) => {
        assert.deepEqual([(await pfRows(page)).map((r) => r[0]), (await pfLook(page)).toggle, await page.eval("[document.getElementById('tp-pf-sellMin').value, document.getElementById('tp-pf-wantedMin').value]")], [want.slice(0, 50), 'Price filters (2 set)', ['1g', '500']], why);
      };
      await same('set');
      // Layout and names on the phone.
      const m = await page.eval(`(() => {
        const p = document.getElementById('tp-pf-panel');
        const lab = (i) => [i.closest('fieldset').querySelector('legend').textContent, i.closest('label').textContent.replace(/\\s+/g, ' ').trim()];
        return { side: document.documentElement.scrollWidth <= 360, out: [...p.querySelectorAll('*')].filter((e) => e.getClientRects().length && (e.getBoundingClientRect().right > 360.5 || e.getBoundingClientRect().left < -0.5)).map((e) => e.id || e.className || e.tagName),
          heights: [...p.querySelectorAll('input, button'), document.getElementById('tp-pf-toggle')].filter((e) => e.getClientRects().length).map((e) => Math.round(e.getBoundingClientRect().height)),
          names: [...p.querySelectorAll('input')].map(lab), status: [document.getElementById('tp-fscope').getAttribute('role'), document.getElementById('tp-pf-said').getAttribute('role'), document.getElementById('tp-pf-toggle').getAttribute('aria-controls')] };
      })()`);
      assert.deepEqual([m.side, m.out], [true, []], 'no sideways scroll, nothing sticking out');
      assert.ok(m.heights.length >= 10 && m.heights.every((x) => x >= 36), JSON.stringify(m.heights));
      assert.deepEqual(m.names, [['Highest buy order', 'from'], ['Highest buy order', 'to'], ['Lowest sell listing', 'from'], ['Lowest sell listing', 'to'], ['Potential margin after fees', 'at least'], ['Potential margin after fees', 'at least, % of buy'],
        ['Total queued units', 'wanted in all buy orders, at least'], ['Total queued units', 'listed in all sell listings, at least']]);
      assert.deepEqual(m.status, ['status', 'status', 'tp-pf-panel']);
      assert.match(await text(page, '#tp-pf-total'), /^These are the totals ArenaNet reports for every buy order and every sell listing together, at any price\. They are not what can be bought or sold near the best price/);
      assert.deepEqual(await lowContrast(page, '#tp-pf-panel *, #tp-fscope'), [], 'readable');
      if (SHOTS) await page.screenshot(join(SHOTS, 'filters-360.png'), true);
      // An item's details and Back.
      await page.eval("document.querySelector('#tp-results a.tp-name').click()");
      await page.waitFor("document.getElementById('tp-item-dialog').open");
      assert.equal(await page.eval('location.hash'), `#market/item/${want[0]}`, 'the address names the item and nothing else');
      await page.eval('history.back()'); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, location.hash]"), [false, '#market']);
      await same('after an item\'s details and Back');
      // To the timer and back: kept, as the search is.
      await click(page, 'button[data-mode="timers"]'); await sleep(300);
      await click(page, 'button[data-mode="market"]'); await sleep(400);
      await same('after a switch to Event Timers and back');
      assert.equal(await page.eval("document.getElementById('tp-find').value"), 'iron sw');
      // Forward to the item again, then Back: still there.
      await page.eval('history.go(-1)'); await sleep(300); await page.eval('history.go(1)'); await sleep(400);
      await same('after Back and Forward across the modes');
      assert.ok(!/1g|500|pf|filter/i.test(await page.eval('location.href')), 'nothing of the filters in the address');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    // A link straight to an item opens its details as before; the filters start empty.
    const linked = await open({ at: AT, api: api(), url: BASE + '#market/item/19721', wait: false });
    try {
      await linked.waitFor("document.getElementById('tp-item-dialog').open && /current/.test(document.getElementById('tp-item-body').textContent)", 15000);
      assert.deepEqual(await linked.eval("[document.getElementById('tp-pf-toggle').textContent, document.getElementById('tp-fscope').hidden, document.getElementById('tp-home').hidden]"), ['Price filters', true, false]);
      assert.deepEqual(unexpected(linked), []);
    } finally { await linked.close(); }
  });

  // ---- One item ----

  check('Trading Post: an item\'s details give both prices, proceeds after fees, the margin, the order book, the chat code and a link; Escape and Back close them and focus returns', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await typeTp(page, 'glob of ecto'); await idle(page);
      await page.eval("document.querySelector('#tp-results a.tp-name').focus()");
      await key(page, 'Enter', 'Enter', 13);
      await page.waitFor("document.getElementById('tp-item-dialog').open && /current/.test(document.getElementById('tp-item-body').textContent)");
      assert.equal(await page.eval('location.hash'), '#market/item/19721');
      assert.equal(await text(page, '#tp-item-title'), 'Glob of Ectoplasm');
      assert.equal(await page.eval('document.activeElement.id'), 'tp-item-title');
      const body = await page.eval("(() => { const c = document.getElementById('tp-item-body').cloneNode(true); for (const s of c.querySelectorAll('.sr-only')) s.remove(); return c.textContent.replace(/\\s+/g, ' '); })()");
      const q = quoteOf(19721);
      const c = (n) => Money.coins(n).text;
      for (const want of [`Highest buy order ${c(q.buy)} 391,900 units wanted in all buy orders`, `Lowest sell listing ${c(q.sell)} 2,219,204 units listed in all`,
        `Spread ${c(q.spread)}`, `would give you about ${c(q.sellNow.net)} after the listing fee of ${c(q.sellNow.listing)} and the exchange fee of ${c(q.sellNow.exchange)}`,
        `would give you about ${c(q.listAtLowest.net)} after fees, only if it sells`, `Potential margin ${c(q.margin)} ${Money.percent(q.marginPct)} of the highest buy order, after fees`, 'A potential margin, not a profit', 'Item id 19721', 'Chat code [&AgEJTQAA]']) {
        assert.ok(body.replace(/\s+/g, '').includes(want.replace(/\s+/g, '')), `${want}\n in: ${body}`);
      }
      assert.equal([q.sellNow.net, q.listAtLowest.net, q.margin].join(), '1453,1623,-87', 'the fee arithmetic, by hand: 1710 - 86 - 171; 1910 - 96 - 191; 1623 - 1710');
      await click(page, '[data-tp-book="19721"]');
      await page.waitFor("document.querySelectorAll('#tp-item-body .tp-book-table tbody tr').length === 10");
      assert.equal(page.apiRequests.filter((u) => /commerce\/listings\?id=19721/.test(u)).length, 1);
      await click(page, '[data-tp-copy]'); await settle();
      assert.equal(await page.eval('navigator.clipboard.readText()'), '[&AgEJTQAA]');
      await click(page, '[data-tp-link]'); await settle();
      assert.equal(await page.eval('navigator.clipboard.readText()'), 'https://radmagelabs.com/gw2-timer/#market/item/19721');
      // v0.5.0 release candidate (found by axe-core): each named button's name holds its visible words, so speech input
      // can say what it sees (WCAG 2.5.3); before, "Copy chat code" and "Copy link" were "Copy the chat code" and "Copy a link".
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-item-body [data-tp-copy], #tp-item-body [data-tp-link]')].map((b) => [b.textContent, b.getAttribute('aria-label')])"),
        [['Copy chat code', 'Copy chat code for Glob of Ectoplasm: [&AgEJTQAA]'], ['Copy link', 'Copy link to Glob of Ectoplasm']]);
      assert.deepEqual(await page.eval("(() => { const f = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\\s+/g, ' ').trim(); return [...document.querySelectorAll('#tp-item-dialog [aria-label]')].filter((b) => f(b.textContent) && !f(b.getAttribute('aria-label')).includes(f(b.textContent))).map((b) => b.getAttribute('aria-label')); })()"), []);
      await key(page, 'Escape', 'Escape', 27); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, location.hash, document.activeElement.getAttribute('href')]"), [false, '#market', '#market/item/19721'], 'Escape closes, the address goes back, focus returns to the name');
      // Escape went back in history, it did not rewrite the address: the details' entry is still ahead, so Forward
      // opens them again (after a rewrite there would be nothing ahead).
      await page.eval('history.forward()'); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, location.hash]"), [true, '#market/item/19721'], 'Forward after Escape');
      await page.eval('history.back()'); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, location.hash]"), [false, '#market']);
      // Back closes them too; Forward opens them again.
      await page.eval("document.querySelector('#tp-results a.tp-name').focus()");
      await key(page, 'Enter', 'Enter', 13); await sleep(400);
      assert.equal(await page.eval("document.getElementById('tp-item-dialog').open"), true);
      await page.eval('history.back()'); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, location.hash]"), [false, '#market']);
      await page.eval('history.forward()'); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, location.hash]"), [true, '#market/item/19721']);
      // Leaving the Trading Post by the address (as Back past it would) closes the item's details too.
      await page.eval("location.hash = ''"); await sleep(400);
      assert.deepEqual(await page.eval("[document.getElementById('tp-item-dialog').open, document.getElementById('timers-view').hidden]"), [false, false]);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  // ---- The quantity calculator (v0.5.0 Phase 1) ----
  // Its items are outside Market Watch where a check gives them its own order book, so nothing the home loaded stands in.

  const lvl = (unit_price, quantity, listings = 1) => ({ listings, unit_price, quantity });
  const calcFigs = (page) => page.eval("(() => { const o = {}; for (const d of document.querySelectorAll('#tp-calc-out [data-tp-fig]')) { const c = d.cloneNode(true); for (const s of c.querySelectorAll('.sr-only')) s.remove(); o[d.getAttribute('data-tp-fig')] = c.textContent.replace(/\\s+/g, ' ').trim(); } return o; })()");
  const calcOpts = (page) => page.eval("(() => { const o = {}; for (const id of ['get-now', 'get-order', 'give-now', 'give-list']) { const c = document.getElementById('tp-calc-' + id).cloneNode(true); for (const s of c.querySelectorAll('.sr-only')) s.remove(); o[id] = c.textContent.replace(/\\s+/g, ' ').trim(); } return o; })()");
  const showBook = async (page) => { await click(page, '#tp-item-body [data-tp-book]'); await page.waitFor("document.getElementById('tp-calc-title') && document.querySelector('#tp-calc-out [data-tp-fig]')"); };
  // Typed as a reader types: the field focused, what is there selected, the keys sent to the browser.
  const typeAmount = async (page, t) => {
    await page.eval("(() => { const i = document.getElementById('tp-calc-n'); i.focus(); i.select(); })()");
    if (t === '') await page.eval("(() => { const i = document.getElementById('tp-calc-n'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); })()");
    else await page.send('Input.insertText', { text: t });
    await settle();
  };
  const chip = async (page, n) => { await click(page, `#tp-item-body [data-tp-calc-n="${n}"]`); await settle(); };
  const way = async (page, name, value) => { await click(page, `#tp-item-body input[name="tp-calc-${name}"][value="${value}"]`); await settle(); };
  const listingsAsked = (page) => page.apiRequests.filter((u) => /commerce\/listings\?/.test(u)).length;
  const openItem = async (page, id) => { await page.waitFor(`document.getElementById('tp-item-dialog').open && /current/.test(document.getElementById('tp-item-body').textContent)`, 15000); assert.equal(await page.eval('location.hash'), `#market/item/${id}`); };
  const ctext = (n) => Money.coins(n).text;
  const bookOf = (id) => { const b = BOOK.get(id); return { buys: Money.cleanSide(b.buys, 'buys'), sells: Money.cleanSide(b.sells, 'sells') }; };
  // Items the home never loads, each with an order book a check makes for it.
  const OWN = Catalog.search(CAT, { query: 'iron sw' }).indexes.map((i) => CAT.ids[i]).filter((id) => !WATCH.includes(id) && !BOOK.has(id) && id % 23 && id % 97);

  check('Trading Post calculator: an amount walks the order book it already has, level by level; the four ways to trade each show their own figure; changing the amount or the way asks ArenaNet for nothing', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market/item/19721', wait: false });
    try {
      await openItem(page, 19721);
      assert.equal(listingsAsked(page), 0, 'the order book is not asked for until its button is pressed');
      assert.equal(await text(page, '#tp-item-body [data-tp-book]'), 'Show the order book and quantity calculator');
      await page.eval("document.querySelector('#tp-item-body [data-tp-book]').focus()");
      await showBook(page);
      assert.equal(listingsAsked(page), 1);
      assert.equal(await page.eval('document.activeElement.id'), 'tp-calc-title', 'focus moves to the calculator, not into the void');
      const before = page.apiRequests.length;
      // One unit, both at once: the book's own best prices (17s 06c and 18s 95c), not the prices above (17s 10c, 19s 10c).
      const B1 = bookOf(19721);
      let f = await calcFigs(page);
      assert.equal(f['buy-now'], '18s 95c in all, 18s 95c each, all at one price. No fee to buy.');
      assert.equal(f['sell-now'], '17s 06c before fees, 17s 06c each, all at one price. After the listing fee of 85c and the exchange fee of 1s 71c: about 14s 50c.', '1706 - 85 (85.3) - 171 (170.6) = 1450');
      assert.match(f.gain, /^about −4s 45c: about 14s 50c after fees, less the cost of 18s 95c, if the order book is still as ArenaNet reported it\. An estimate, never a promise: the book may have changed\.$/);
      assert.equal(f.roi, `about ${Money.percent(-445 / 1895)}: the profit or loss (about −4s 45c) divided by the cost (18s 95c), for 1 unit bought now and sold now, if the order book is still as ArenaNet reported it. An estimate, never a promise: the book may have changed.`);
      assert.equal(f.even, 'Selling now gives back about 14s 50c each after fees: having paid more than that for each, selling now would lose.');
      assert.equal(await page.eval("document.querySelector('#tp-book-warn [data-tp-warn=\"differs\"]').textContent.replace(/\\s+/g, ' ').includes('The calculator uses the order book only.')"), true, 'the book and the prices differ here, and it is said');
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-item-body [data-tp-calc-n]')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])"), [['1', 'true'], ['5', 'false'], ['10', 'false'], ['50', 'false'], ['100', 'false']]);
      assert.equal(await page.eval("document.querySelectorAll('#tp-item-body .tp-book-table tbody tr').length"), 10, 'five prices a side for a small amount');
      // Every ready amount, against the module's plan for the same book, and by hand for 250.
      for (const n of [5, 10, 50, 100]) {
        await chip(page, n);
        const p = Money.plan(B1, n, { get: 'now', give: 'now' });
        f = await calcFigs(page);
        assert.ok(f['buy-now'].startsWith(`${ctext(p.cost)} in all`), `${n}: ${f['buy-now']}`);
        assert.ok(f['sell-now'].includes(`about ${ctext(p.back.low)}.`), `${n}: ${f['sell-now']}`);
        assert.ok(f.gain.startsWith(`about ${ctext(p.gain.low)}: `), `${n}: ${f.gain}`);
        assert.equal(await page.eval("document.querySelector('#tp-item-body [data-tp-calc-n][aria-pressed=\"true\"]').textContent"), String(n));
      }
      await typeAmount(page, '250');
      f = await calcFigs(page);
      assert.equal(f['buy-now'], '47g 37s 69c in all, about 18s 96c each, across 2 prices, up to 18s 96c each. No fee to buy.', '231 x 1895 + 19 x 1896 = 473,769; 1895.076 each, rounded up');
      assert.equal(f['sell-now'], '42g 62s 66c before fees, about 17s 05c each, across 2 prices, down to 17s 04c each. After the listing fee of 2g 13s 13c and the exchange fee of 4g 26s 27c: about 36g 23s 26c.', '133 x 1706 + 117 x 1704 = 426,266');
      assert.ok(f.gain.startsWith('about −11g 14s 43c: about 36g 23s 26c after fees, less the cost of 47g 37s 69c, if the order book is still'), f.gain);
      assert.equal(await page.eval("document.querySelectorAll('#tp-item-body [data-tp-calc-n][aria-pressed=\"true\"]').length"), 0, 'a typed amount is no ready amount');
      // The tables show what the amount takes of each price.
      const tables = await page.eval("[...document.querySelectorAll('#tp-item-body .tp-book-table')].map((t) => ({ cap: t.querySelector('caption').textContent, head: [...t.querySelectorAll('th')].map((x) => x.textContent), taken: [...t.querySelectorAll('tbody tr')].map((r) => r.lastElementChild.textContent) }))");
      assert.deepEqual(tables.map((t) => [t.cap, t.head[3], t.taken]), [['Buy orders, highest first: 6,785 units at 8 prices in all', 'Taken for 250', ['133', '117', '', '', '']], ['Sell listings, lowest first: 1,464 units at 8 prices in all', 'Taken for 250', ['231', '19', '', '', '']]]);
      // The four ways, each with its figure beside it before it is chosen.
      const o = await calcOpts(page), p250 = Money.plan(B1, 250, { get: 'order', give: 'list' });
      assert.deepEqual(o, { 'get-now': 'Buy now from the sell listings: 47g 37s 69c', 'get-order': `Place a buy order at the highest, 17s 06c each: ${ctext(p250.order.total)}, only if it fills`,
        'give-now': 'Sell now to the buy orders: about 36g 23s 26c after fees', 'give-list': `List them at the lowest, 18s 95c each: about ${ctext(p250.list.net)} after fees, only if it sells` });
      assert.equal(p250.order.total, 426500, '250 x 1706');
      assert.equal(p250.list.net, 402687, '473,750 - 23,688 (23,687.5 up) - 47,375');
      // A buy order and a listing: both only hoped for, said as such, and no longer called executable.
      await way(page, 'get', 'order'); await way(page, 'give', 'list');
      f = await calcFigs(page);
      assert.deepEqual(Object.keys(f), ['buy-order', 'list', 'gain', 'roi', 'even']);
      assert.ok(f['buy-order'].includes('42g 65s 00c, paid when the order is placed, no fee. Not something the order book fills now: it fills only if sellers come to it, and it may never fill.'), f['buy-order']);
      assert.ok(f.list.includes('about 40g 26s 87c after the listing fee of 2g 36s 88c (paid when listing, not returned) and the exchange fee of 4g 73s 75c. Not something the order book fills now: only if it sells.'), f.list);
      assert.equal(f.gain, 'about −2g 38s 13c: about 40g 26s 87c after fees, less the cost of 42g 65s 00c, only if the buy order fills and the listing sells: neither is certain, and prices move.');
      assert.ok(!/still as ArenaNet reported/.test(f.gain), 'not presented as something that can be done now');
      assert.equal(f.even, `Listing the 250 units at ${ctext(p250.breakEven.price)} each or more would give back the cost after both fees; any lower would lose. The lowest sell listing in the book is below it: listing there would lose.`);
      assert.equal(await page.eval("[...document.querySelectorAll('#tp-item-body .tp-book-table tbody tr')].filter((r) => r.lastElementChild.textContent).length"), 0, 'an order and a listing take nothing from the book');
      // Mixed: buy now, then list.
      await way(page, 'get', 'now');
      f = await calcFigs(page);
      assert.ok(f.gain.startsWith(`about ${ctext(402687 - 473769)}: `) && f.gain.endsWith('only if the listing sells: that is not certain, and prices move.'), f.gain);
      // The status line a screen reader hears: the amount and the result, as an estimate.
      assert.equal(await text(page, '#tp-calc-said'), `250 units: profit or loss ${Money.coins(402687 - 473769).spoken}, an estimate.`);
      // None of all that asked ArenaNet for anything.
      assert.equal(page.apiRequests.length, before, 'no request for any amount or way');
      assert.equal(listingsAsked(page), 1);
      assert.deepEqual(await lowContrast(page, '#tp-item-body .tp-book *'), [], 'readable');
      if (SHOTS) await page.screenshot(join(SHOTS, 'calculator-1280.png'), true);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post calculator: what is typed stays, with its caret and its focus, while a late price arrives and while the 30-second tick redraws the details', async () => {
    // Prices come 2.5 s late, so they arrive while the amount is being typed.
    const page = await open({ at: AT, api: api({ delayFor: (u) => (u.pathname === '/v2/commerce/prices' ? 2500 : 0) }), url: BASE + '#market/item/19721', wait: false });
    try {
      await page.waitFor("document.getElementById('tp-item-dialog').open && document.querySelector('#tp-item-body [data-tp-book]')", 15000);
      assert.match(await text(page, '#tp-item-body .tp-facts'), /Loading\.\.\./, 'the price is still on its way');
      await showBook(page);
      await typeAmount(page, '13');
      await page.eval("(() => { const i = document.getElementById('tp-calc-n'); i.setSelectionRange(1, 1); i.dataset.mark = 'kept'; document.querySelector('#tp-item-body input[name=\"tp-calc-give\"][value=\"list\"]').dataset.mark = 'kept'; })()");
      const state = () => page.eval("(() => { const i = document.getElementById('tp-calc-n'); return { value: i.value, focus: document.activeElement === i, caret: [i.selectionStart, i.selectionEnd], mark: i.dataset.mark || '', radio: document.querySelector('#tp-item-body input[name=\"tp-calc-give\"][value=\"list\"]').dataset.mark || '' }; })()");
      const KEPT = { value: '13', focus: true, caret: [1, 1], mark: 'kept', radio: 'kept' };
      assert.deepEqual(await state(), KEPT);
      // The late price arrives and the details above are redrawn around the field.
      await page.waitFor("/current/.test((document.querySelector('#tp-item-body .tp-stat-when') || {}).textContent || '')", 15000);
      assert.deepEqual(await state(), KEPT, 'after the price arrived');
      assert.ok((await calcFigs(page))['buy-now'].startsWith(`${ctext(13 * 1895)} in all`), 'the figures are for the 13 typed');
      // Six minutes on: the tick redraws the details and marks the book stale, in place.
      await page.eval("document.querySelector('#tp-item-body .tp-detail-main').dataset.mark = 'old'"); // the jump below is 5 min 33 s: with the tick at most 30 s later, the age still rounds to 6 minutes
      await later(page, 333000);
      await page.waitFor("/6 minutes ago \\(stale\\)/.test(document.getElementById('tp-book-when').textContent)", 35000);
      assert.deepEqual(await state(), KEPT, 'after the 30-second tick');
      // Typing goes on where the caret was: a 7 between the 1 and the 3.
      await page.send('Input.insertText', { text: '7' }); await settle();
      assert.deepEqual(await page.eval("[document.getElementById('tp-calc-n').value, document.getElementById('tp-calc-n').selectionStart]"), ['173', 2]);
      const p = Money.plan(bookOf(19721), 173, { get: 'now', give: 'now' });
      assert.ok((await calcFigs(page))['buy-now'].startsWith(`${ctext(p.cost)} in all`));
      // A second tick, with an amount that is not one: the error stays, the field too.
      await typeAmount(page, '2.5');
      await later(page, 60000);
      await page.waitFor("/[78] minutes ago \\(stale\\)/.test(document.getElementById('tp-book-when').textContent)", 35000);
      assert.deepEqual(await page.eval("[document.getElementById('tp-calc-n').value, document.activeElement.id, document.getElementById('tp-calc-err').hidden, document.getElementById('tp-calc-n').dataset.mark]"), ['2.5', 'tp-calc-n', false, 'kept']);
      assert.equal(listingsAsked(page), 1, 'no tick asks for the order book again');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post calculator: an amount is a whole number from 1 to 250; anything else is refused in words and nothing is worked out for it', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market/item/19721', wait: false });
    try {
      await openItem(page, 19721);
      await showBook(page);
      const look = () => page.eval("(() => { const i = document.getElementById('tp-calc-n'), e = document.getElementById('tp-calc-err'); return { err: e.hidden ? '' : e.textContent, role: e.getAttribute('role'), invalid: i.getAttribute('aria-invalid'), figs: document.querySelectorAll('#tp-calc-out [data-tp-fig]').length, none: (document.querySelector('#tp-calc-out > .tp-none') || {}).textContent || '', taken: [...document.querySelectorAll('#tp-item-body .tp-book-table tbody tr')].filter((r) => r.lastElementChild.textContent).length, pressed: document.querySelectorAll('#tp-item-body [data-tp-calc-n][aria-pressed=\"true\"]').length, said: document.getElementById('tp-calc-said').textContent }; })()");
      const RANGE = 'Type a whole number from 1 to 250: one Trading Post transaction holds at most 250 units.', WHOLE = 'That is not a whole number. Type 1 to 250, in digits only.';
      for (const [t, want] of [['0', RANGE], ['251', RANGE], ['1000', RANGE], ['2.5', WHOLE], ['-3', WHOLE], ['1e2', WHOLE], ['ten', WHOLE], ['1,000', WHOLE]]) {
        await typeAmount(page, t);
        assert.deepEqual(await look(), { err: want, role: 'alert', invalid: 'true', figs: 0, none: 'No figures: the amount is not one this page can work with.', taken: 0, pressed: 0, said: '' }, t);
      }
      // The two ends are amounts: 1 and 250.
      for (const [t, cost] of [['1', 1895], ['250', 473769]]) {
        await typeAmount(page, t);
        const l = await look();
        assert.deepEqual([l.err, l.invalid, l.none, l.figs > 0], ['', null, '', true], t);
        assert.ok((await calcFigs(page))['buy-now'].startsWith(`${ctext(cost)} in all`), t);
      }
      // Emptied, the field gives way to the ready amount last chosen (1), which shows as chosen again.
      await chip(page, 50); await typeAmount(page, '7'); await typeAmount(page, '');
      assert.deepEqual([(await look()).pressed, await page.eval("document.querySelector('#tp-item-body [data-tp-calc-n][aria-pressed=\"true\"]').textContent")], [1, '50']);
      // A ready amount clears what was typed.
      await typeAmount(page, '999'); await chip(page, 5);
      assert.deepEqual([await page.eval("document.getElementById('tp-calc-n').value"), (await look()).err], ['', '']);
      assert.equal(listingsAsked(page), 1);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post calculator: when the order book holds fewer units than asked, it says how many it holds and works out no cost, proceeds, profit, return or break-even for the amount', async () => {
    const [thin, noSells, noBuys] = OWN;
    const books = new Map([[thin, { id: thin, buys: [lvl(50, 3)], sells: [lvl(100, 4), lvl(105, 5)] }], [noSells, { id: noSells, buys: [lvl(50, 3)], sells: [] }], [noBuys, { id: noBuys, buys: [], sells: [lvl(100, 4)] }]]);
    let page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${thin}`, wait: false });
    try {
      await openItem(page, thin);
      await showBook(page);
      await chip(page, 10);
      let f = await calcFigs(page);
      assert.deepEqual(f, { 'buy-now': 'Only 9 of 10 are listed in the whole order book. Those 9 would cost 9s 25c; nothing is worked out for the other 1.',
        'sell-now': 'Only 3 of 10 are wanted in the whole order book. Those 3 would sell for 1s 50c before fees; nothing is worked out for the other 7.', gain: 'None: the order book lists only 9 of the 10 to buy.' }, 'no return and no break-even either');
      assert.deepEqual(await calcOpts(page).then((o) => [o['get-now'], o['give-now']]), ['Buy now from the sell listings: only 9 of 10 are listed', 'Sell now to the buy orders: only 3 of 10 are wanted']);
      assert.equal(await text(page, '#tp-calc-said'), '10 units: no result, the order book cannot fill it.');
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-item-body .tp-book-table')].map((t) => [...t.querySelectorAll('tbody tr')].map((r) => r.lastElementChild.textContent))"), [['3'], ['4', '5']], 'what there is, is shown taken');
      // 4 units: the sell listings hold them, the buy orders do not.
      await typeAmount(page, '4');
      f = await calcFigs(page);
      assert.deepEqual([f['buy-now'], f.gain, 'roi' in f, 'even' in f], ['4s 00c in all, 1s 00c each, all at one price. No fee to buy.', 'None: the order book wants only 3 of the 4.', false, false]);
      // Exactly what the book holds is not a shortfall: 3 to sell, 9 to buy.
      await typeAmount(page, '3');
      f = await calcFigs(page);
      assert.ok(f.gain.startsWith('about −1s 73c: about 1s 27c after fees, less the cost of 3s 00c'), f.gain); // 150 - 8 (7.5 up) - 15 = 127
      await typeAmount(page, '9'); await way(page, 'give', 'list');
      f = await calcFigs(page);
      assert.ok(f['buy-now'].startsWith('9s 25c in all, about 1s 03c each, across 2 prices, up to 1s 05c each.'), f['buy-now']); // 925 / 9 = 102.8
      assert.ok(/^about −1s 60c: about 7s 65c after fees, less the cost of 9s 25c, only if the listing sells/.test(f.gain), f.gain); // 900 - 45 - 90
      // A listing takes nothing from the book, so 10 by order and listing has a result, marked as hoped for.
      await typeAmount(page, '10'); await way(page, 'get', 'order');
      f = await calcFigs(page);
      assert.ok(/^about 3s 50c: about 8s 50c after fees, less the cost of 5s 00c, only if the buy order fills and the listing sells/.test(f.gain), f.gain);
      assert.equal(listingsAsked(page), 1);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    // A side with nothing at all: said, and never a price of 0.
    for (const [id, figs] of [[noSells, { 'buy-now': 'No sell listings in the order book.', gain: 'None: the order book has no sell listings.' }], [noBuys, { 'sell-now': 'No buy orders in the order book.', gain: 'None: the order book has no buy orders.' }]]) {
      page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${id}`, wait: false });
      try {
        await openItem(page, id);
        await showBook(page);
        const f = await calcFigs(page);
        for (const [k, v] of Object.entries(figs)) assert.equal(f[k], v, `${id} ${k}`);
        // The prices above have both sides; the book lacks one: said as a difference between the two answers.
        assert.match((await text(page, '#tp-book-warn [data-tp-warn="differs"]')).replace(/\s+/g, ' '), id === noSells ? /the book has buy orders from 50c\s*50 copper and no sell listings\. Neither says which is newer\./ : /the book has no buy orders and sell listings from 1s 00c\s*1 silver\. Neither says which is newer\./);
        assert.ok(!/\b0c\b/.test(Object.values(f).join(' ').replace(/\d0c/g, '')), JSON.stringify(f));
        assert.equal(await page.eval("[...document.querySelectorAll('#tp-item-body .tp-book-table tbody')].some((b) => b.textContent === 'None.')"), true);
        assert.deepEqual(unexpected(page), []);
      } finally { await page.close(); }
    }
  });

  check('Trading Post calculator: repeated, disordered and unreadable price levels are counted once or left out, said in words, and figures that reach them are marked uncertain', async () => {
    const [rep, bad] = OWN.slice(3);
    const REAL = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'tp-book-repeats.json'), 'utf8'));
    const books = new Map([
      // The second buy price comes twice, as the live API does it; a level may be missing after it.
      [rep, { id: rep, buys: [lvl(90, 2), lvl(80, 3), lvl(80, 3), lvl(70, 50)], sells: [lvl(200, 400)] }],
      // Sell listings out of order, with rows that are not price levels (no price, no units, a price that is text) and a side that is no list.
      [bad, { id: bad, buys: 'none', sells: [lvl(300, 5), lvl(250, 5), { listings: 1, unit_price: 0, quantity: 9 }, { listings: 1, unit_price: 260, quantity: 0 }, { listings: 1, unit_price: 'x', quantity: 1 }] }],
      [19721, Object.assign({}, REAL, { id: 19721 })],
    ]);
    let page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${rep}`, wait: false });
    try {
      await openItem(page, rep);
      await showBook(page);
      const warns = () => page.eval("[...document.querySelectorAll('#tp-book-warn [data-tp-warn]')].map((p) => [p.getAttribute('data-tp-warn'), p.textContent.replace(/\\s+/g, ' ')])");
      const w = (await warns()).filter(([k]) => k !== 'differs');
      assert.deepEqual(w, [['repeats', "ArenaNet's answer repeated 1 price among the buy orders. Each price is counted once here, and where the answer repeats one, another may be missing: past the best 2 prices the buy orders are uncertain, and so is their total."]]);
      assert.equal(await page.eval("document.querySelector('#tp-item-body .tp-book-table caption').textContent"), 'Buy orders, highest first: 55 units at 3 prices in all (uncertain)', '2 + 3 + 50: the repeated 3 is not added twice');
      // 5 units stay within the two sure prices; 6 reach past the repeat.
      await chip(page, 5);
      let f = await calcFigs(page);
      assert.ok(!/Uncertain/.test(f['sell-now']) && f['sell-now'].startsWith('4s 20c before fees'), f['sell-now']); // 2 x 90 + 3 x 80
      await typeAmount(page, '6');
      f = await calcFigs(page);
      assert.ok(f['sell-now'].startsWith('4s 90c before fees') && f['sell-now'].endsWith('Uncertain: it reaches prices where the order book is not sure (see above).'), f['sell-now']);
      assert.ok(!/Uncertain/.test(f['buy-now']), 'the sell listings are sure');
      // More than the side holds, on a side with a repeat: short and uncertain.
      await typeAmount(page, '60');
      f = await calcFigs(page);
      assert.ok(f['sell-now'].startsWith('Only 55 of 60 are wanted in the whole order book.') && f['sell-now'].endsWith('Uncertain: it reaches prices where the order book is not sure (see above).'), f['sell-now']);
      assert.deepEqual(await lowContrast(page, '#tp-book-warn *'), [], 'the warnings are readable');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${bad}`, wait: false });
    try {
      await openItem(page, bad);
      await showBook(page);
      const w = await page.eval("[...document.querySelectorAll('#tp-book-warn [data-tp-warn]')].map((p) => [p.getAttribute('data-tp-warn'), p.textContent.replace(/\\s+/g, ' ')])");
      assert.deepEqual(w.filter(([k]) => k !== 'differs'), [['dropped', '1 row of the buy orders could not be read and is left out, so figures from them are marked uncertain.'],
        ['unsorted', 'The sell listings did not arrive in price order. They are sorted here, and figures from them are marked uncertain.'], ['dropped', '3 rows of the sell listings could not be read and are left out, so figures from them are marked uncertain.']]);
      // Sorted: the lowest listing (2s 50c) is taken first, though it arrived second; no row with a price of 0 or no units is shown.
      await chip(page, 5);
      const f = await calcFigs(page);
      assert.equal(f['buy-now'], '12s 50c in all, 2s 50c each, all at one price. No fee to buy. Uncertain: it reaches prices where the order book is not sure (see above).');
      assert.equal(f['sell-now'], 'No buy orders in the order book.');
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-item-body .tp-book-table')][1].querySelectorAll('tbody tr').length"), 2);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    // A real answer with the API's repeats (near every 200th level): said, counted once, and a walk of 250 from the best prices is not marked uncertain.
    page = await open({ at: AT, api: api({ books }), url: BASE + '#market/item/19721', wait: false });
    try {
      await openItem(page, 19721);
      await showBook(page);
      await typeAmount(page, '250');
      const w = await page.eval("[...document.querySelectorAll('#tp-book-warn [data-tp-warn=\"repeats\"]')].map((p) => p.textContent.replace(/\\s+/g, ' '))");
      assert.equal(w.length, 2);
      assert.match(w[0], /^ArenaNet's answer repeated 6 prices among the buy orders\. .* past the best 195 prices the buy orders are uncertain/);
      assert.match(w[1], /^ArenaNet's answer repeated 1 price among the sell listings\. .* past the best 200 prices/);
      const real = { buys: Money.cleanSide(REAL.buys, 'buys'), sells: Money.cleanSide(REAL.sells, 'sells') }, p = Money.plan(real, 250, {});
      const f = await calcFigs(page);
      assert.ok(f['buy-now'].startsWith(`${ctext(p.cost)} in all`) && !/Uncertain/.test(f['buy-now'] + f['sell-now']), JSON.stringify(f));
      assert.equal(await page.eval("document.querySelector('#tp-item-body .tp-book-table caption').textContent"), `Buy orders, highest first: ${real.buys.depth.toLocaleString('en-US')} units at 204 prices in all (uncertain)`);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post calculator: a stale order book is marked and its figures are not offered as tradable now; Refresh asks once, keeps the book it has until a newer one comes, and keeps what was typed', async () => {
    // The second request for the order book is refused (HTTP 400); the third is answered with a book that has moved.
    let n = 0, slow = false;
    const moved = { id: 19721, buys: [lvl(1700, 500)], sells: [lvl(1900, 500)] };
    const page = await open({ at: AT, api: api({ delayFor: (u) => (slow && u.pathname === '/v2/commerce/listings' ? 1500 : 0), answer: (k, u) => (u.pathname === '/v2/commerce/listings' && ++n === 2 ? 400 : 'ok'), bookFor: () => (n >= 3 ? moved : null) }), url: BASE + '#market/item/19721', wait: false });
    try {
      await openItem(page, 19721);
      await showBook(page);
      assert.equal(await text(page, '#tp-book-when'), 'Order book received at 7:00 AM, just now (current). That is when this page got it; when ArenaNet last updated it is not known: the answer carries no time, and ArenaNet lets an answer be reused for up to 20 minutes, so it may date from before 7:00 AM and be older than the prices above.');
      assert.equal(await page.eval("document.querySelector('#tp-calc-out .tp-calc-stale')"), null);
      await typeAmount(page, '20');
      // Six minutes on, by the 30-second tick: stale, in the warning color, and the result says how old it is.
      await later(page, 333000);
      await page.waitFor("/6 minutes ago \\(stale\\)/.test(document.getElementById('tp-book-when').textContent)", 35000);
      assert.ok((await text(page, '#tp-book-when')).endsWith(' Refresh it before relying on these figures.'));
      assert.equal(await page.eval("document.getElementById('tp-book-when').classList.contains('is-stale')"), true);
      assert.equal(await text(page, '#tp-calc-out .tp-calc-stale'), 'This order book was received 6 minutes ago: stale. The figures below are what it showed then, not what can be traded now. Refresh it first.');
      assert.match((await calcFigs(page)).gain, /if the order book is still as it was in the answer received 6 minutes ago\. An estimate, never a promise: the book may have changed\.$/);
      assert.deepEqual(await lowContrast(page, '#tp-book-when, #tp-calc-out .tp-calc-stale'), [], 'stale, readable');
      // Refresh, refused: the book that is here stays, with its own time and the reason.
      await page.eval("document.getElementById('tp-book-refresh').focus()");
      await click(page, '#tp-book-refresh');
      await page.waitFor("/could not be loaded/.test(document.getElementById('tp-book-when').textContent)", 15000);
      assert.match(await text(page, '#tp-book-when'), /^Order book received at 7:00 AM, 6 minutes ago \(stale\)\..* A newer order book could not be loaded: ArenaNet's API refused the request\. This one stays, with its time\. Refresh it before relying on these figures\.$/);
      assert.ok((await calcFigs(page))['buy-now'].startsWith(`${ctext(20 * 1895)} in all`), 'still the old book, nothing made up');
      assert.deepEqual(await page.eval("[document.getElementById('tp-calc-n').value, document.activeElement.id]"), ['20', 'tp-book-refresh'], 'what was typed stays, and focus stays on Refresh');
      assert.equal(listingsAsked(page), 2);
      // Refresh again: the newer book replaces it, current, and the figures are the new book's.
      await click(page, '#tp-book-refresh');
      await page.waitFor("/just now \\(current\\)/.test(document.getElementById('tp-book-when').textContent)", 15000);
      assert.equal(await page.eval("document.querySelector('#tp-calc-out .tp-calc-stale')"), null);
      assert.deepEqual([await page.eval("document.getElementById('tp-calc-n').value"), (await calcFigs(page))['buy-now']], ['20', '3g 80s 00c in all, 19s 00c each, all at one price. No fee to buy.']);
      assert.equal(listingsAsked(page), 3, 'one request for each press, none of its own');
      // Pressed twice on a slow API: the first request is cancelled for the second, and a cancelled request is not a failure.
      slow = true;
      await click(page, '#tp-book-refresh'); await sleep(300); await click(page, '#tp-book-refresh'); await sleep(700);
      assert.match(await text(page, '#tp-book-when'), / Asking again\.\.\.$/);
      assert.ok(!/could not be loaded/.test(await text(page, '#tp-book-when')), 'the cancelled request is not reported as a failure');
      await page.waitFor("!/Asking again/.test(document.getElementById('tp-book-when').textContent)", 15000);
      assert.ok(!/could not be loaded/.test(await text(page, '#tp-book-when')));
      slow = false;
      assert.equal(listingsAsked(page), 5);
      // An hour on: old.
      await later(page, 3636000);
      await page.waitFor("/\\(old\\)/.test(document.getElementById('tp-book-when').textContent)", 35000);
      assert.match(await text(page, '#tp-calc-out .tp-calc-stale'), /^This order book was received 61 minutes ago: old\./);
      assert.equal(listingsAsked(page), 5);
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  check('Trading Post calculator: when the fees on the whole sale and the fees on each price differ, both estimates are shown and neither is called a limit; a long walk shows the prices it reached; at a few copper the fees take it all', async () => {
    const [two, ladder, copper] = OWN.slice(5);
    const books = new Map([
      [two, { id: two, buys: [lvl(9, 1), lvl(8, 1)], sells: [lvl(11, 5)] }],
      // Fourteen sell prices of one unit each, 1s 01c to 1s 14c.
      [ladder, { id: ladder, buys: [lvl(50, 500)], sells: Array.from({ length: 14 }, (x, i) => lvl(101 + i, 1)) }],
      [copper, { id: copper, buys: [lvl(1, 500)], sells: [lvl(2, 500)] }],
    ]);
    let page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${two}`, wait: false });
    try {
      await openItem(page, two);
      await showBook(page);
      await typeAmount(page, '2');
      // 9c + 8c = 17c. Whole sale: 1c (0.85) and 2c (1.7): 14c. Each price: 1c and 1c of 9c, 1c and 1c of 8c: 13c.
      const f = await calcFigs(page);
      assert.equal(f['sell-now'], '17c before fees, about 8c each, across 2 prices, down to 8c each. After fees, two estimates: about 14c if both fees are worked out on the whole sale (1c and 2c), or about 13c if on each price (2c and 2c). ArenaNet does not publish which applies, and neither is a limit.');
      assert.equal(f.gain, 'about −8c or −9c (the two fee estimates): about 14c or 13c after fees, less the cost of 22c, if the order book is still as ArenaNet reported it. An estimate, never a promise: the book may have changed.');
      assert.equal(f.roi, `about ${Money.percent(-8 / 22)} or ${Money.percent(-9 / 22)} (the two fee estimates): the profit or loss (about −8c or −9c) divided by the cost (22c), for 2 units bought now and sold now, if the order book is still as ArenaNet reported it. An estimate, never a promise: the book may have changed.`);
      assert.equal(f.even, 'Selling now gives back about 7c or 6c each after fees: having paid more than that for each, selling now would lose.');
      assert.equal((await calcOpts(page))['give-now'], 'Sell now to the buy orders: about 14c or 13c after fees');
      assert.equal(await text(page, '#tp-calc-said'), '2 units: profit or loss a loss of 8 copper or a loss of 9 copper, an estimate.');
      assert.ok(!/between|at most|at least 1[34]c|no more than|no less than/.test(Object.values(f).join(' ')), 'never worded as limits');
      // One unit crosses no price: one estimate, no "or".
      await chip(page, 1);
      assert.equal((await calcFigs(page))['sell-now'], '9c before fees, 9c each, all at one price. After the listing fee of 1c and the exchange fee of 1c: about 7c.');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${ladder}`, wait: false });
    try {
      await openItem(page, ladder);
      await showBook(page);
      const rows = () => page.eval("[...[...document.querySelectorAll('#tp-item-body .tp-book-table')][1].querySelectorAll('tbody tr')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())");
      assert.equal((await rows()).length, 5, 'five prices for one unit');
      await typeAmount(page, '8');
      assert.equal((await rows()).length, 8, 'as many prices as the amount reaches');
      await typeAmount(page, '14');
      const r = await rows();
      assert.equal(r.length, 13, 'twelve prices at most, then a line for the rest');
      assert.match(r[12], /^and 2 more prices reached, the last at 1s 14c\s*1 silver 14 copper each$/);
      assert.ok((await calcFigs(page))['buy-now'].startsWith(`${ctext(14 * 101 + 91)} in all, about 1s 08c each, across 14 prices, up to 1s 14c each.`)); // 1505 / 14 = 107.5
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${copper}`, wait: false });
    try {
      await openItem(page, copper);
      await showBook(page);
      const f = await calcFigs(page);
      assert.equal(f['sell-now'], '1c before fees, 1c each, all at one price. After the listing fee of 1c and the exchange fee of 1c: about −1c. At this price the fees, at least 1 copper each, take all of it.');
      assert.ok(f.gain.startsWith('about −3c: about −1c after fees, less the cost of 2c'), f.gain);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post calculator on a 360 px phone and by keyboard: nothing scrolls sideways, every control is 36 px and named, and Tab reaches them in order', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market/item/19721', wait: false, width: 360, height: 740, mobile: true });
    try {
      await openItem(page, 19721);
      await showBook(page);
      await typeAmount(page, '250');
      const m = await page.eval(`(() => {
        const d = document.getElementById('tp-item-dialog'), box = document.querySelector('#tp-item-body .tp-book');
        const ctl = [...box.querySelectorAll('button, input[type="text"]')].map((e) => [e.id || e.textContent, Math.round(e.getBoundingClientRect().height)]);
        const opt = [...box.querySelectorAll('.tp-calc-opt')].map((e) => Math.round(e.getBoundingClientRect().height));
        const wide = [...box.querySelectorAll('*')].filter((e) => e.getClientRects().length).filter((e) => e.getBoundingClientRect().right > d.getBoundingClientRect().right + 0.5 || e.getBoundingClientRect().left < d.getBoundingClientRect().left - 0.5).map((e) => e.className || e.tagName);
        return { side: [document.documentElement.scrollWidth <= innerWidth, d.scrollWidth <= d.clientWidth], ctl, opt, wide };
      })()`);
      assert.deepEqual(m.side, [true, true], 'no sideways scroll');
      assert.deepEqual(m.wide, [], 'nothing sticks out of the dialog');
      assert.ok(m.ctl.every(([, hgt]) => hgt >= 36) && m.opt.every((hgt) => hgt >= 36), JSON.stringify(m));
      // Names a screen reader has for each control.
      const names = await page.eval(`(() => {
        const box = document.querySelector('#tp-item-body .tp-book');
        const lab = (e) => (e.closest('label') ? e.closest('label').textContent.replace(/\\s+/g, ' ').trim() : e.textContent.trim());
        return { group: [box.querySelector('[role="group"]').getAttribute('aria-labelledby'), document.getElementById('tp-calc-units-k').textContent], input: [lab(document.getElementById('tp-calc-n')), document.getElementById('tp-calc-n').getAttribute('aria-describedby'), document.getElementById('tp-calc-n').getAttribute('inputmode')],
          legends: [...box.querySelectorAll('legend')].map((l) => l.textContent), radios: [...box.querySelectorAll('input[type="radio"]')].map((r) => [r.name, r.value, r.checked, lab(r).length > 20]),
          said: document.getElementById('tp-calc-said').getAttribute('role'), heads: [...box.querySelectorAll('th[scope="col"]')].length, caps: box.querySelectorAll('caption').length };
      })()`);
      assert.deepEqual(names, { group: ['tp-calc-units-k', 'Units'], input: ['Other amount', 'tp-calc-hint tp-calc-err', 'numeric'], legends: ['Getting the units', 'Then'],
        radios: [['tp-calc-get', 'now', true, true], ['tp-calc-get', 'order', false, true], ['tp-calc-give', 'now', true, true], ['tp-calc-give', 'list', false, true]], said: 'status', heads: 8, caps: 2 });
      // Tab from the calculator's heading: Refresh, the five amounts, the field, then the two choices.
      await page.eval("document.getElementById('tp-calc-title').focus()");
      const seen = [];
      for (let i = 0; i < 9; i++) { await key(page, 'Tab', 'Tab', 9); seen.push(await page.eval("(() => { const e = document.activeElement; return e.id || e.getAttribute('data-tp-calc-n') || e.name; })()")); }
      assert.deepEqual(seen, ['tp-book-refresh', '1', '5', '10', '50', '100', 'tp-calc-n', 'tp-calc-get', 'tp-calc-give']);
      // A ready amount by keyboard, and a way by the arrow keys of its group.
      await page.eval("document.querySelector('#tp-item-body [data-tp-calc-n=\"10\"]').focus()");
      await key(page, 'Enter', 'Enter', 13); await settle();
      assert.deepEqual(await page.eval("[document.activeElement.getAttribute('data-tp-calc-n'), document.activeElement.getAttribute('aria-pressed'), document.getElementById('tp-calc-n').value]"), ['10', 'true', ''], 'focus stays on the amount chosen');
      assert.deepEqual(await lowContrast(page, '#tp-item-body .tp-book *'), [], 'readable');
      if (SHOTS) await page.screenshot(join(SHOTS, 'calculator-360.png'), true);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  // ---- v0.5.0 Phase 3: observed book depth near the best price, the return on cost defined, one freshness vocabulary ----

  const strip = "(e) => { if (!e) return null; const c = e.cloneNode(true); for (const s of c.querySelectorAll('.sr-only')) s.remove(); return c.textContent.replace(/\\s+/g, ' ').trim(); }";
  const nearLook = (page) => page.eval(`(() => { const t = ${strip}, b = document.getElementById('tp-book-near'); if (!b) return null;
    return { head: t(b.querySelector('h4')), keys: [...b.querySelectorAll('dt')].map(t), buys: t(b.querySelector('[data-tp-near="buys"]')), sells: t(b.querySelector('[data-tp-near="sells"]')), note: t(b.querySelector('.tp-near-note')) }; })()`);
  const NEAR_NOTE = 'What this order book showed queued at prices within 5% of its own best price, both ends included. Not a guarantee that this many can be bought or sold: orders come and go, others trade first, and the book may have changed since this page received it.';
  const NEAR_HEAD = { head: 'Observed book depth near the best price', keys: ['Buy orders within 5%', 'Sell listings within 5%'], note: NEAR_NOTE };
  const UNSURE = ' Uncertain: it reaches prices where the order book is not sure (see above).', FROM = ' Uncertain: worked out from prices where the order book is not sure (see above).';

  check('Trading Post order book depth: the units within 5% of the book\'s own best prices, both ends included, with the range and the side\'s whole depth; called observed book depth, never a guarantee; the same for every amount and way, and asks for nothing', async () => {
    const [deep, cheap, noSells] = OWN.slice(8);
    const books = new Map([
      // Buy orders from 1g: 95s 00c is exactly 5% below and counts, 94s 99c does not. Sell listings from 1g 10s: 1g 15s 50c is exactly 5% above.
      [deep, { id: deep, buys: [lvl(10000, 10, 2), lvl(9600, 20, 3), lvl(9500, 30), lvl(9499, 40), lvl(8000, 999, 9)], sells: [lvl(11000, 5), lvl(11550, 6), lvl(11551, 7), lvl(20000, 100)] }],
      // Under 20 copper, 5% is less than a copper: only the best price counts.
      [cheap, { id: cheap, buys: [lvl(9, 4), lvl(8, 100)], sells: [lvl(12, 3), lvl(13, 50)] }],
      [noSells, { id: noSells, buys: [lvl(500, 7)], sells: [] }],
    ]);
    let page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${deep}`, wait: false });
    try {
      await openItem(page, deep);
      assert.equal(await page.eval("document.getElementById('tp-book-near')"), null, 'nothing before the order book is asked for');
      await showBook(page);
      const WANT = Object.assign({}, NEAR_HEAD, { buys: '60 units wanted at 3 prices between 1g 00s 00c and 95s 00c, of 1,099 in the whole order book.', sells: '11 units listed at 2 prices between 1g 10s 00c and 1g 15s 50c, of 118 in the whole order book.' });
      assert.deepEqual(await nearLook(page), WANT, '10 + 20 + 30 of 1,099; 5 + 6 of 118');
      // In the calculator's results, after its figures and before the book's tables, so the stale warning stands above it.
      assert.deepEqual(await page.eval("(() => { const n = document.getElementById('tp-book-near'); return [n.parentNode.id, n.previousElementSibling.className, n.nextElementSibling.className, n.querySelectorAll('[data-tp-fig], button, input, th, caption').length]; })()"),
        ['tp-calc-out', 'ed-facts tp-facts tp-calc-facts', 'tp-book-sides', 0]);
      // Never worded as something that can be done.
      assert.ok(!/can (be )?(buy|sell|bought|sold)|available|liquid|executable/i.test(WANT.buys + WANT.sells));
      // Every amount and way, and an amount that is not one: the same depth, and nothing asked for.
      const before = page.apiRequests.length;
      for (const step of [() => chip(page, 100), () => typeAmount(page, '250'), () => way(page, 'get', 'order'), () => way(page, 'give', 'list'), () => typeAmount(page, '2.5')]) {
        await step();
        assert.deepEqual(await nearLook(page), WANT);
      }
      assert.equal(await page.eval("document.querySelectorAll('#tp-calc-out [data-tp-fig]').length"), 0, 'no calculator figure for 2.5, and the depth is none of them');
      assert.deepEqual([page.apiRequests.length - before, listingsAsked(page)], [0, 1]);
      // Stale (5 min 33 s on, then the 30-second tick): the warning above it, and the figures what the book showed.
      await later(page, 333000);
      await page.waitFor("/6 minutes ago \\(stale\\)/.test(document.getElementById('tp-book-when').textContent)", 35000);
      assert.equal(await page.eval("(() => { const s = document.querySelector('#tp-calc-out .tp-calc-stale'); return Boolean(s) && Boolean(s.compareDocumentPosition(document.getElementById('tp-book-near')) & Node.DOCUMENT_POSITION_FOLLOWING); })()"), true, 'under the stale warning');
      assert.deepEqual(await nearLook(page), WANT);
      assert.deepEqual(await lowContrast(page, '#tp-book-near *'), [], 'readable');
      if (SHOTS) await page.screenshot(join(SHOTS, 'depth-stale-1280.png'), true);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    for (const [id, buys, sells] of [
      [cheap, '4 units wanted at 9c, of 104 in the whole order book. At this price 5% is less than 1 copper, so only this price counts.', '3 units listed at 12c, of 53 in the whole order book. At this price 5% is less than 1 copper, so only this price counts.'],
      [noSells, '7 units wanted at 1 price between 5s 00c and 4s 75c, of 7 in the whole order book.', 'None: the order book has no sell listings.'],
    ]) {
      page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${id}`, wait: false });
      try {
        await openItem(page, id);
        await showBook(page);
        assert.deepEqual(await nearLook(page), Object.assign({}, NEAR_HEAD, { buys, sells }), String(id));
        assert.deepEqual(unexpected(page), []);
      } finally { await page.close(); }
    }
  });

  check('Trading Post order book depth: a repeated price inside the range, or rows out of order or unreadable, mark it uncertain; a repeat at or past the range, as in a real answer, does not; a side with nothing says so', async () => {
    const [inRange, atLimit, bad] = OWN.slice(11);
    const REAL = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'tp-book-repeats.json'), 'utf8'));
    const books = new Map([
      // 1s 99c twice on buy orders from 2s 00c: a level missing after it could be inside the 5% (down to 1s 90c).
      [inRange, { id: inRange, buys: [lvl(200, 4), lvl(199, 2), lvl(199, 2), lvl(150, 5)], sells: [lvl(300, 10)] }],
      // 1s 90c twice, the limit itself: what could be missing after it lies past 5%.
      [atLimit, { id: atLimit, buys: [lvl(200, 4), lvl(190, 2), lvl(190, 2), lvl(150, 5)], sells: [lvl(300, 10)] }],
      // Sell listings out of order with rows that are not price levels; buy orders that are no list.
      [bad, { id: bad, buys: 'none', sells: [lvl(300, 5), lvl(250, 5), { listings: 1, unit_price: 0, quantity: 9 }, { listings: 1, unit_price: 'x', quantity: 1 }] }],
      [19721, Object.assign({}, REAL, { id: 19721 })],
    ]);
    const real = { buys: Money.cleanSide(REAL.buys, 'buys'), sells: Money.cleanSide(REAL.sells, 'sells') }, nb = Money.near(real.buys), ns = Money.near(real.sells);
    const SELLS = '10 units listed at 1 price between 3s 00c and 3s 15c, of 10 in the whole order book.';
    for (const [id, buys, sells] of [
      [inRange, `6 units wanted at 2 prices between 2s 00c and 1s 90c, of 11 in the whole order book.${UNSURE}`, SELLS],
      [atLimit, '6 units wanted at 2 prices between 2s 00c and 1s 90c, of 11 in the whole order book.', SELLS],
      [bad, 'None: the order book has no buy orders.', `5 units listed at 1 price between 2s 50c and 2s 62c, of 10 in the whole order book.${UNSURE}`],
      // The real answer repeats prices near its 200th, far past 5% of its best: the warnings say so, the depth near the price is sure.
      [19721, `${Money.count(nb.units)} units wanted at ${nb.prices} prices between ${ctext(nb.best)} and ${ctext(nb.limit)}, of ${Money.count(real.buys.depth)} in the whole order book.`,
        `${Money.count(ns.units)} units listed at ${ns.prices} prices between ${ctext(ns.best)} and ${ctext(ns.limit)}, of ${Money.count(real.sells.depth)} in the whole order book.`],
    ]) {
      const page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${id}`, wait: false });
      try {
        await openItem(page, id);
        await showBook(page);
        assert.deepEqual(await nearLook(page), Object.assign({}, NEAR_HEAD, { buys, sells }), String(id));
        if (id === 19721) {
          assert.deepEqual([nb.uncertain, ns.uncertain, real.buys.repeats > 0, real.sells.repeats > 0], [false, false, true, true]);
          assert.equal(await page.eval("document.querySelectorAll('#tp-book-warn [data-tp-warn=\"repeats\"]').length"), 2, 'the repeats are still said above');
        }
        assert.deepEqual(unexpected(page), []);
      } finally { await page.close(); }
    }
  });

  check('Trading Post calculator: the return on cost is the profit or loss divided by the cost, said with both, for the amount and the two ways chosen, in each of the four ways; an order or a listing only if it fills or sells; uncertain when worked out from what the book is not sure of', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market/item/19721', wait: false });
    try {
      await openItem(page, 19721);
      await showBook(page);
      await chip(page, 10);
      const NOW = ' if the order book is still as ArenaNet reported it. An estimate, never a promise: the book may have changed.';
      // By hand on the sample book: 10 bought now at 18s 95c = 1g 89s 50c; a buy order at 17s 06c = 1g 70s 60c. Sold now: 1g 70s 60c less
      // 8s 53c and 17s 06c = 1g 45s 01c. Listed at 18s 95c: 1g 89s 50c less 9s 48c (947.5 up) and 18s 95c (1,895.5 down) = 1g 61s 07c.
      for (const [get, give, gain, roi] of [
        ['now', 'now', 'about −44s 49c: about 1g 45s 01c after fees, less the cost of 1g 89s 50c,' + NOW,
          `about −23.5%: the profit or loss (about −44s 49c) divided by the cost (1g 89s 50c), for 10 units bought now and sold now,${NOW}`],
        ['now', 'list', 'about −28s 43c: about 1g 61s 07c after fees, less the cost of 1g 89s 50c, only if the listing sells: that is not certain, and prices move.',
          'about −15.0%: the profit or loss (about −28s 43c) divided by the cost (1g 89s 50c), for 10 units bought now and listed, only if the listing sells: that is not certain, and prices move.'],
        ['order', 'now', 'about −25s 59c: about 1g 45s 01c after fees, less the cost of 1g 70s 60c, only if the buy order fills: that is not certain, and prices move.',
          'about −15.0%: the profit or loss (about −25s 59c) divided by the cost (1g 70s 60c), for 10 units bought by a buy order and sold now, only if the buy order fills: that is not certain, and prices move.'],
        ['order', 'list', 'about −9s 53c: about 1g 61s 07c after fees, less the cost of 1g 70s 60c, only if the buy order fills and the listing sells: neither is certain, and prices move.',
          'about −5.6%: the profit or loss (about −9s 53c) divided by the cost (1g 70s 60c), for 10 units bought by a buy order and listed, only if the buy order fills and the listing sells: neither is certain, and prices move.'],
      ]) {
        await way(page, 'get', get); await way(page, 'give', give);
        const f = await calcFigs(page), p = Money.plan(bookOf(19721), 10, { get, give });
        assert.deepEqual([f.gain, f.roi], [gain, roi], `${get} then ${give}`);
        assert.deepEqual([Money.percent(p.roi.low), p.gain.low, p.cost], [roi.slice(6, roi.indexOf(':')), [-4449, -2843, -2559, -953][['now now', 'now list', 'order now', 'order list'].indexOf(`${get} ${give}`)], get === 'now' ? 18950 : 17060], 'the module, by hand');
        // What only might happen is never offered as what the book does now.
        if (get === 'order' || give === 'list') assert.ok(!/still as ArenaNet reported/.test(f.roi) && /only if/.test(f.roi), f.roi);
      }
      assert.equal(listingsAsked(page), 1);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
    // Uncertain: a repeated buy price walked past (6 units), or a book out of order with unreadable rows; the figures worked out from them say so.
    const [rep, bad] = OWN.slice(3);
    const books = new Map([[rep, { id: rep, buys: [lvl(90, 2), lvl(80, 3), lvl(80, 3), lvl(70, 50)], sells: [lvl(200, 400)] }],
      [bad, { id: bad, buys: [lvl(100, 50)], sells: [lvl(300, 5), lvl(250, 5), { listings: 1, unit_price: 0, quantity: 9 }] }]]);
    let p2 = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${rep}`, wait: false });
    try {
      await openItem(p2, rep);
      await showBook(p2);
      await chip(p2, 5);
      let f = await calcFigs(p2);
      assert.ok(![f.gain, f.roi, f.even].some((x) => /Uncertain/.test(x)), 'within the sure prices: 5 units');
      await typeAmount(p2, '6');
      f = await calcFigs(p2);
      assert.ok(f['sell-now'].endsWith(UNSURE) && f.gain.endsWith(FROM) && f.roi.endsWith(FROM) && f.even.endsWith(FROM), JSON.stringify(f));
      const repBook = { buys: Money.cleanSide(books.get(rep).buys, 'buys'), sells: Money.cleanSide(books.get(rep).sells, 'sells') };
      assert.ok(f.roi.startsWith(`about ${Money.percent(Money.plan(repBook, 6, {}).roi.high)}: the profit or loss (`), f.roi);
      // Listed instead: the sell listings are sure, so nothing worked out from them is marked.
      await way(p2, 'give', 'list');
      f = await calcFigs(p2);
      assert.ok(![f.gain, f.roi, f.even].some((x) => /Uncertain/.test(x)), JSON.stringify(f));
      assert.deepEqual(unexpected(p2), []);
    } finally { await p2.close(); }
    p2 = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${bad}`, wait: false });
    try {
      await openItem(p2, bad);
      await showBook(p2);
      await chip(p2, 5); await way(p2, 'give', 'list');
      // 5 bought now at 2s 50c (the lowest, though it arrived second), listed at 2s 50c: 12s 50c less 63c (62.5 up) and 1s 25c.
      const f = await calcFigs(p2);
      assert.equal(f.roi, `about −15.0%: the profit or loss (about −1s 88c) divided by the cost (12s 50c), for 5 units bought now and listed, only if the listing sells: that is not certain, and prices move.${FROM}`);
      assert.ok(f.gain.endsWith(FROM) && f.even.endsWith(FROM), JSON.stringify(f));
      // By a buy order instead (5 at 1s 00c): the cost no longer comes from the disordered sell listings, so nothing is marked.
      await way(p2, 'get', 'order');
      const g = await calcFigs(p2);
      assert.equal(g.roi, 'about 112.4%: the profit or loss (about 5s 62c) divided by the cost (5s 00c), for 5 units bought by a buy order and listed, only if the buy order fills and the listing sells: neither is certain, and prices move.');
      assert.ok(![g.gain, g.roi, g.even].some((x) => /Uncertain/.test(x)), JSON.stringify(g));
      assert.deepEqual(unexpected(p2), []);
    } finally { await p2.close(); }
  });

  check('Trading Post freshness: prices, the order book and the gem rates say when this page received them and that when ArenaNet last updated them is not known, in one vocabulary (received; current, stale, old); no line says "fetched" or "from" a time, and no request asks past the browser\'s cache', async () => {
    // Each fetch the page makes, as the page made it: the Request's cache mode and the options given. Chrome adds the headers a
    // cache mode sends (Pragma, Cache-Control) below the point where api() sees a request, so the mode is read here instead.
    const SPY = "window.__fetches = []; (() => { const f = window.fetch; window.fetch = function (u, i) { try { const r = new Request(u, i); window.__fetches.push({ url: r.url, cache: r.cache, keys: Object.keys(i || {}).sort().join(',') }); } catch (e) { window.__fetches.push({ url: String(u), cache: 'unreadable', keys: '' }); } return f.apply(this, arguments); }; })();";
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false, init: [SPY] });
    // Everything the Trading Post and an item's details show, as a reader sees it.
    const seen = () => page.eval("[document.getElementById('market-view').innerText, document.getElementById('tp-item-dialog').open ? document.getElementById('tp-item-dialog').innerText : ''].join(' ').replace(/\\s+/g, ' ')");
    const BANNED = /\bfetched\b|\b(Prices|Rates) from \d|\basked for at\b|minutes behind|may itself be/i;
    try {
      await market(page); await watchReady(page);
      assert.ok((await text(page, '.market-view .explain')).includes('with the time this page received them (when ArenaNet last updated them is not known: its answers carry no time)'));
      assert.deepEqual([await text(page, '#tp-watch-text'), await text(page, '#tp-gem-text')], ['Prices received 7:00 AM, current.', 'Rates received 7:00 AM, current.']);
      await typeTp(page, 'glob of ecto'); await idle(page);
      assert.equal(await text(page, '#tp-prices-text'), 'Prices received 7:00 AM, current.');
      await click(page, '#tp-results a.tp-name');
      await openItem(page, 19721);
      await showBook(page);
      assert.equal(await text(page, '#tp-item-body .tp-stat-when'), 'Prices received at 7:00 AM, just now (current). That is when this page got them; when ArenaNet last updated them is not known: the answer carries no time, and ArenaNet lets an answer be reused for up to 2 minutes, so they may date from before 7:00 AM.');
      assert.ok((await text(page, '#tp-book-when')).startsWith('Order book received at 7:00 AM, just now (current). That is when this page got it; when ArenaNet last updated it is not known: the answer carries no time, and ArenaNet lets an answer be reused for up to 20 minutes'));
      let all = await seen();
      assert.ok(!BANNED.test(all), all.match(BANNED) && all.slice(Math.max(0, all.search(BANNED) - 80), all.search(BANNED) + 80));
      // Stale: 11 min 33 s on, then the tick (the age lands mid-rounding at 12 minutes); every line in the same words.
      await later(page, 693000);
      await page.waitFor("/12 minutes ago \\(stale\\)/.test(document.getElementById('tp-book-when').textContent) && /12 minutes ago \\(stale\\)/.test(document.querySelector('#tp-item-body .tp-stat-when').textContent)", 35000);
      assert.match(await text(page, '#tp-item-body .tp-stat-when'), /^Prices received at 7:00 AM, 12 minutes ago \(stale\)\. That is when this page got them; when ArenaNet last updated them is not known/);
      assert.match(await text(page, '#tp-calc-out .tp-calc-stale'), /^This order book was received 12 minutes ago: stale\./);
      assert.match((await calcFigs(page)).gain, /if the order book is still as it was in the answer received 12 minutes ago\./);
      assert.equal(await page.eval("document.querySelector('#tp-results .tp-note').textContent"), 'Stale price, received 12 minutes ago.');
      assert.equal(await text(page, '#tp-prices-text'), 'Prices received 7:00 AM, 12 minutes ago: stale. Refresh for current prices.');
      all = await seen();
      assert.ok(!BANNED.test(all), all.slice(Math.max(0, all.search(BANNED) - 80), all.search(BANNED) + 80));
      // Decision D5: every request is a plain GET through the browser's ordinary cache: no cache headers, no cache mode (read below from the page's side), no cache-busting parameter.
      const sent = page.apiSent || [];
      // The home's four (prices, item records, both gem quotes) and the order book: every kind of request the Trading Post makes.
      assert.deepEqual([...new Set(sent.map((r) => new URL(r.url).pathname))].sort(), ['/v2/commerce/exchange/coins', '/v2/commerce/exchange/gems', '/v2/commerce/listings', '/v2/commerce/prices', '/v2/items']);
      for (const r of sent) {
        const u = new URL(r.url), heads = Object.keys(r.headers).map((k) => k.toLowerCase());
        assert.equal(r.method, 'GET', r.url);
        assert.ok(!heads.includes('cache-control') && !heads.includes('pragma'), `${r.url}: ${heads.join(', ')}`);
        assert.ok([...u.searchParams.keys()].every((k) => ['ids', 'id', 'quantity', 'lang', 'v'].includes(k)), r.url);
      }
      // The same requests from the page's side: each in the browser's default cache mode, and no cache option given at all.
      const made = (await page.eval('window.__fetches')).filter((r) => new URL(r.url).hostname === 'api.guildwars2.com');
      assert.deepEqual([...new Set(made.map((r) => new URL(r.url).pathname))].sort(), [...new Set(sent.map((r) => new URL(r.url).pathname))].sort());
      for (const r of made) assert.ok(r.cache === 'default' && !r.keys.split(',').includes('cache'), JSON.stringify(r));
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post depth and return on cost on 320 and 360 px phones in both themes, with four-figure gold prices: nothing scrolls sideways or sticks out, readable, in each of the four ways', async () => {
    const big = OWN[14];
    const books = new Map([[big, { id: big, buys: [lvl(40000000, 3), lvl(39000000, 2), lvl(38123456, 40), lvl(20000000, 9)], sells: [lvl(45000000, 1), lvl(45111111, 4), lvl(47250000, 2), lvl(47250001, 6), lvl(48000000, 9)] }]]);
    for (const [width, height] of [[320, 568], [360, 740]]) {
      for (const theme of ['dark', 'light']) {
        const page = await open({ at: AT, api: api({ books }), url: BASE + `#market/item/${big}`, wait: false, width, height, mobile: true, seed: { [h.reminders.PREFS]: { theme } } });
        try {
          await openItem(page, big);
          await showBook(page);
          await typeAmount(page, '5');
          for (const [get, give] of [['now', 'now'], ['now', 'list'], ['order', 'now'], ['order', 'list']]) {
            await way(page, 'get', get); await way(page, 'give', give);
            const m = await page.eval(`(() => {
              const d = document.getElementById('tp-item-dialog'), box = d.getBoundingClientRect();
              const out = [...document.querySelectorAll('#tp-item-body .tp-book *')].filter((e) => e.getClientRects().length).filter((e) => { const r = e.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).map((e) => e.className || e.tagName);
              // Against the fixed width, not innerWidth: a phone browser widens its viewport when a page overflows.
              return { page: document.documentElement.scrollWidth <= ${width}, dialog: d.scrollWidth <= d.clientWidth && box.right <= ${width} + 0.5, out, near: Boolean(document.getElementById('tp-book-near')), roi: Boolean(document.querySelector('#tp-calc-out [data-tp-fig="roi"]')) };
            })()`);
            assert.deepEqual(m, { page: true, dialog: true, out: [], near: true, roi: true }, `${width} ${theme} ${get} ${give}`);
          }
          assert.deepEqual(await lowContrast(page, '#tp-book-near *, #tp-calc-out [data-tp-fig="roi"] *'), [], `${width} ${theme}`);
          if (SHOTS && theme === 'dark') {
            await page.eval("document.getElementById('tp-book-near').scrollIntoView({ block: 'center' })");
            await page.screenshot(join(SHOTS, `depth-roi-${width}.png`));
          }
          assert.deepEqual(unexpected(page), []);
        } finally { await page.close(); }
      }
    }
  });

  check('Trading Post: a link to an item opens its details on load; a link to an unknown or unreadable item says so and changes nothing', async () => {
    let page = await open({ at: AT, api: api(), url: BASE + '#market/item/24295', wait: false });
    try {
      await page.waitFor("document.getElementById('tp-item-dialog').open && document.getElementById('tp-item-title').textContent === 'Vial of Powerful Blood'", 15000);
      await page.eval("document.querySelector('#tp-item-dialog [data-close]').click()"); await sleep(300);
      assert.deepEqual(await page.eval("[location.hash, document.getElementById('market-view').hidden]"), ['#market', false], 'closing a linked item keeps the Trading Post');
    } finally { await page.close(); }
    for (const [hash, said] of [['#market/item/999999999', new RegExp(`not in the Trading Post item list \\(as of ${esc(ASOF)}\\)\\. Nothing of yours was changed\\.`)], ['#market/item/<b>x</b>', /could not be read\. Nothing of yours was changed\./]]) {
      page = await open({ at: AT, api: api(), url: BASE + hash, wait: false });
      try {
        await market(page);
        await page.waitFor("!document.getElementById('tp-link-notice').hidden");
        assert.match(await text(page, '#tp-link-notice-text'), said);
        assert.equal(await page.eval("document.getElementById('tp-item-dialog').open"), false);
        assert.ok(!(await page.eval('document.body.innerHTML')).includes('<b>x</b>'), 'nothing of the link is written into the page');
      } finally { await page.close(); }
    }
  });

  // ---- Favorites ----

  check('Trading Post: favorites are saved as item ids, survive a reload and a switch of mode, filter the list, and still work for this tab when storage is blocked', async () => {
    let page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await typeTp(page, 'glob'); await idle(page);
      await click(page, '[data-tp-fav="19721"]'); await settle();
      assert.equal(await page.eval(`localStorage.getItem('${FAV}')`), '[19721]');
      assert.equal(await page.eval("document.querySelector('[data-tp-fav=\"19721\"]').getAttribute('aria-pressed')"), 'true');
      // A second press takes it out again; a third puts it back.
      await click(page, '[data-tp-fav="19721"]'); await settle();
      assert.deepEqual(await page.eval(`[localStorage.getItem('${FAV}'), document.querySelector('[data-tp-fav="19721"]').getAttribute('aria-pressed'), document.getElementById('tp-favs').textContent]`), ['[]', 'false', 'Favorites (0)']);
      await click(page, '[data-tp-fav="19721"]'); await settle();
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await settle();
      assert.equal(await text(page, '#tp-favs'), 'Favorites (1)');
      await page.reload();
      await market(page);
      await click(page, '#tp-favs'); await idle(page);
      assert.deepEqual(await shownIds(page), [19721], 'Favorites shows only the favorites');
      assert.equal(await page.eval("document.getElementById('tp-fav-unsaved').hidden"), true);
      // A saved list that is not ours is cleaned: unknown ids, strings and repeats dropped.
      await page.eval(`localStorage.setItem('${FAV}', JSON.stringify([19721, 'x', 19721, 999999999, 24295]))`);
      await page.reload(); await market(page); await click(page, '#tp-favs'); await idle(page);
      assert.deepEqual((await shownIds(page)).sort((a, b) => a - b), [19721, 24295]);
      assert.equal(await text(page, '#tp-favs'), 'Favorites (2)', 'the junk is not counted either');
    } finally { await page.close(); }
    page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false, init: [h.reminders.BLOCK_STORAGE] });
    try {
      await market(page);
      await typeTp(page, 'glob'); await idle(page);
      await click(page, '[data-tp-fav="19721"]'); await settle();
      assert.equal(await page.eval("document.querySelector('[data-tp-fav=\"19721\"]').getAttribute('aria-pressed')"), 'true', 'works for this tab');
      assert.equal(await page.eval("document.getElementById('tp-fav-unsaved').hidden"), false, 'and says it cannot be saved');
    } finally { await page.close(); }
  });

  // ---- Keyboard, screen readers, layout ----

  check('Modes and Trading Post by keyboard and screen reader: a labeled switch of two toggle buttons with a visible focus ring, labeled controls, named stars, spoken prices and polite status lines', async () => {
    const page = await open({ at: AT, api: api() });
    try {
      await page.eval("document.querySelector('button[data-mode=\"timers\"]').focus()");
      await key(page, 'Tab', 'Tab', 9);
      assert.equal(await page.eval('document.activeElement.dataset.mode'), 'market');
      const ring = await page.eval("getComputedStyle(document.activeElement).outlineStyle + ' ' + getComputedStyle(document.activeElement).outlineWidth");
      assert.equal(ring, 'solid 2px', 'a visible focus ring');
      await key(page, 'Enter', 'Enter', 13);
      await market(page);
      assert.deepEqual(await page.eval("[document.activeElement.dataset.mode, document.activeElement.getAttribute('aria-pressed'), location.hash]"), ['market', 'true', '#market']);
      await key(page, ' ', 'Space', 32); await settle();
      assert.equal(await page.eval("document.querySelector('button[data-mode=\"market\"]').getAttribute('aria-pressed')"), 'true', 'Space on the pressed one changes nothing');
      await key(page, 'Tab', 'Tab', 9);
      assert.equal(await page.eval('document.activeElement.id'), 'tp-find', 'the search comes next');
      // Back hides the view that has focus: focus goes to the switch, never to a hidden field; Forward likewise.
      await page.eval('history.back()'); await settle();
      assert.deepEqual(await page.eval("[location.hash, document.activeElement.dataset.mode]"), ['', 'timers']);
      await page.eval("document.getElementById('find').focus()");
      await page.eval('history.forward()'); await settle();
      assert.deepEqual(await page.eval("[location.hash, document.activeElement.dataset.mode]"), ['#market', 'market']);
      await page.eval("document.getElementById('tp-find').focus()");
      assert.equal(await page.eval("document.querySelector('label[for=\"tp-find\"]').textContent"), 'Search');
      await page.send('Input.insertText', { text: 'glob of ecto' }); await sleep(600); await idle(page);
      const a11y = await page.eval(`(() => { const r = document.querySelector('#tp-results .tp-row');
        return { fav: r.querySelector('.tp-fav').getAttribute('aria-label'), buy: r.querySelector('.tp-buy .sr-only').textContent, coin: r.querySelector('.tp-buy .coins .sr-only').textContent,
          hidden: r.querySelector('.tp-buy .coins [aria-hidden]') !== null, status: ['tp-count', 'tp-prices-text', 'tp-whole-status', 'tp-boot'].map((id) => document.getElementById(id).getAttribute('role')),
          list: document.getElementById('tp-results').getAttribute('aria-label'), busy: document.getElementById('tp-results').getAttribute('aria-busy'), sort: document.getElementById('tp-sort').getAttribute('aria-describedby'),
          labels: ['tp-type', 'tp-rarity', 'tp-sort'].map((id) => document.getElementById(id).closest('label').firstChild.textContent.trim()) }; })()`);
      assert.deepEqual(a11y, { fav: 'Favorite: Glob of Ectoplasm', buy: 'Highest buy order: ', coin: '17 silver 10 copper', hidden: true, status: ['status', 'status', 'status', 'status'], list: 'Trading Post items', busy: 'false', sort: 'tp-scope', labels: ['Type', 'Rarity', 'Sort'] });
      // Keyboard down the controls to the first item's name and star.
      const seen = [];
      for (let i = 0; i < 14; i++) { await key(page, 'Tab', 'Tab', 9); seen.push(await page.eval("document.activeElement.id || document.activeElement.className")); }
      for (const want of ['tp-type', 'tp-rarity', 'tp-sort', 'tp-favs', 'tp-refresh', 'tp-whole-btn', 'tp-name', 'star-btn tp-fav']) assert.ok(seen.includes(want), `${want} in ${seen}`);
      assert.ok(seen.indexOf('tp-type') < seen.indexOf('tp-sort') && seen.indexOf('tp-sort') < seen.indexOf('tp-name') && seen.indexOf('tp-name') < seen.indexOf('star-btn tp-fav'), seen.join());
      await page.eval("document.querySelector('.tp-fav').focus()");
      await key(page, ' ', 'Space', 32); await settle();
      assert.equal(await page.eval("document.activeElement.getAttribute('aria-pressed')"), 'true', 'Space stars, and focus stays on the star');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Modes and Trading Post fit 320, 360 and 390 px phones, a 768 px tablet, and 920 and 1280 px desktops in both themes: no sideways scroll, 36 px controls on phones, readable contrast', async () => {
    for (const [width, height, mobile] of [[320, 568, true], [360, 740, true], [390, 844, true], [768, 1024, false], [920, 800, false], [1280, 900, false]]) {
      for (const theme of ['dark', 'light']) {
        const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false, width, height, mobile, seed: { [h.reminders.PREFS]: { theme } } });
        try {
          await market(page);
          await typeTp(page, 'glob'); await idle(page);
          await page.eval('document.activeElement.blur()');
          const r = await page.eval("({ page: document.documentElement.scrollWidth, sw: document.querySelector('.mode-switch').getBoundingClientRect().right, rows: [...document.querySelectorAll('.tp-row')].every((x) => x.getBoundingClientRect().right <= innerWidth) })");
          assert.ok(r.page <= width && r.sw <= width && r.rows, `${width} ${theme}: ${JSON.stringify(r)}`);
          // Inside each row nothing spills: no cell wider than its box, and no two cells on top of each other
          // (Glob of Dragonvoid Aether has four-digit gold amounts).
          const spill = await page.eval(`[...document.querySelectorAll('#tp-results .tp-row')].flatMap((row) => {
            const cells = [...row.querySelectorAll('.tp-cell, .tp-item')], bad = cells.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => row.dataset.id + ' ' + c.className + ' spills');
            for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
              const a = cells[i].getBoundingClientRect(), b = cells[j].getBoundingClientRect();
              if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(row.dataset.id + ' ' + cells[i].className + ' / ' + cells[j].className);
            }
            return bad; })`);
          assert.deepEqual(spill, [], `${width} ${theme}`);
          if (mobile) {
            const small = await page.eval("[...document.querySelectorAll('.mode-btn, #market-view button, #market-view select, #market-view input, #market-view a.tp-name')].filter((x) => x.getClientRects().length && x.getBoundingClientRect().height < 36).map((x) => (x.id || x.className) + ' ' + x.getBoundingClientRect().height.toFixed(1))");
            assert.deepEqual(small, [], `${width} ${theme}`);
            const both = await page.eval("(() => { const b = [...document.querySelectorAll('.mode-btn')].map((x) => x.getBoundingClientRect()); return b[0].top === b[1].top && b[1].right <= innerWidth; })()");
            assert.equal(both, true, `${width}: the two modes side by side`);
          }
          assert.deepEqual(await lowContrast(page, '.mode-btn, #market-view p, #market-view span, #market-view a, #market-view label, #market-view button'), [], `${width} ${theme}`);
          if (SHOTS && theme === 'dark' && [320, 1280].includes(width)) await page.screenshot(join(SHOTS, `market-${width}.png`));
        } finally { await page.close(); }
      }
    }
  });

  // ---- The timer under the Trading Post, and failures to load ----

  check('Modes: reminders keep coming while the Trading Post is open: the notice, the count in the title and the announcement', async () => {
    const R = h.reminders;
    // Opened 10 s before the reminder is due (23:50 for Tequatl at 00:00, 10 minutes ahead), so the reminder must come
    // from the timer ticking under the Trading Post, not from the clock check that settles at load.
    const page = await open({ at: utc('2026-10-25T23:49:50Z'), api: api(), url: BASE + '#market', wait: false, clock: 'fail', init: [R.LISTEN],
      seed: { [R.PREFS]: { starred: ['tequatl-the-sunless'] }, [R.RSET]: R.ON } });
    try {
      await market(page);
      assert.equal(await page.eval("document.getElementById('reminders-tray').hidden"), true, 'not due yet');
      await page.waitFor("!document.getElementById('reminders-tray').hidden", 15000);
      const t = await R.trayState(page);
      assert.deepEqual(t.ids, ['tequatl-the-sunless']);
      assert.match(t.title, /^\(1\) GW2 Timer/);
      assert.ok(t.said.some((x) => /^Reminder: Tequatl the Sunless starts at 7:00 PM/.test(x.text)), JSON.stringify(t.said));
      assert.equal(await page.eval("document.getElementById('market-view').hidden"), false, 'still on the Trading Post');
      // The notice's name opens the event's details over the Trading Post; closing returns to it.
      await click(page, '#reminders-tray a.event-link'); await settle();
      assert.equal(await page.eval("document.getElementById('event-dialog').open"), true);
      await page.eval("document.querySelector('#event-dialog [data-close]').click()"); await sleep(400);
      assert.deepEqual(await page.eval("[location.hash, document.getElementById('market-view').hidden]"), ['#market', false]);
      // Dismissing the only notice takes its button away: focus goes to the Trading Post's heading, never to the hidden timer's.
      await page.eval("(() => { const b = document.querySelector('[data-rm-dismiss]'); b.focus(); b.click(); })()"); await settle();
      assert.deepEqual(await page.eval("[document.getElementById('reminders-tray').hidden, document.activeElement.id]"), [true, 'market-title']);
      assert.deepEqual(unexpected(page, [/ERR_FAILED/]), []);
    } finally { await page.close(); }
  });

  check('Trading Post: when its code or its item list cannot load, it says so, the timer keeps working, and Try again loads it', async () => {
    for (const [file, how, said] of [['js/market.js', 'fail', /^The Trading Post could not load\./], ['data/tp-items.json', 'fail', /^The item list could not be loaded\. Check your connection and try again\. The timer is not affected\.$/], ['data/tp-items.json', 'garbage', /^The item list that arrived could not be read/]]) {
      let mode = how;
      const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false, local: { patterns: [`*${file}*`], handler: async (pg, p) => {
        if (mode === 'pass') await pg.send('Fetch.continueRequest', { requestId: p.requestId });
        else if (mode === 'garbage') await pg.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, body: Buffer.from('{"format":1,"rows":"x"}').toString('base64'), responseHeaders: [{ name: 'Content-Type', value: 'application/json' }] });
        else await pg.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'InternetDisconnected' });
      } } });
      try {
        await page.waitFor("!document.getElementById('tp-retry').hidden", 15000);
        assert.match(await text(page, '#tp-boot'), said);
        assert.match(await text(page, '#tp-boot'), /The timer is not affected\./);
        const c1 = await text(page, '#local-time'); await sleep(1100);
        assert.notEqual(await text(page, '#local-time'), c1, 'the timer ticks on');
        mode = 'pass';
        await click(page, '#tp-retry');
        await market(page);
        await typeTp(page, 'glob of ecto');
        assert.deepEqual(await shownIds(page), [19721]);
        assert.deepEqual(unexpected(page, [/^failed: net::ERR_INTERNET_DISCONNECTED/, /^log: Failed to load resource/]), []);
      } finally { await page.close(); }
    }
  });

  // v0.4.0 final correction 2: a search or sort cancels the requests before it and asks again at once. The ids those
  // requests held must be asked for again, not skipped as still on their way (found in the production-check trial:
  // rows left "not requested yet"). Typed one key at a time, as a reader types, on an API slower than the keys.
  check('Trading Post: typing one key at a time, and a price sort right after a search, on an API slower than the keys: every row shown gets its price and icon, none left "not requested yet"', async () => {
    const page = await open({ at: AT, api: api({ delay: 400 }), url: BASE + '#market', wait: false });
    const STUCK = /not requested yet/;
    const settled = "!/not requested yet|loading\\.\\.\\./.test(document.getElementById('tp-results').textContent) && !document.querySelector('#tp-results[aria-busy=\"true\"]')";
    try {
      await market(page);
      // Items outside Market Watch: the home has already loaded Market Watch's prices and item records, which would hide the race.
      for (const [q, ids] of [['vial of potent blood', [24294]], ['elder wood log', null]]) {
        // 150 ms a key: each search starts 100 ms after its key, so 50 ms into it every row shown is priced or
        // loading. A row "not requested yet" then was dropped, or let go of by a request that no longer held it.
        const dropped = [];
        for (let k = 1; k <= q.length; k++) {
          await page.eval(`(() => { const i = document.getElementById('tp-find'); i.value = ${JSON.stringify(q.slice(0, k))}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
          await sleep(150);
          if (STUCK.test(await text(page, '#tp-results'))) dropped.push(q.slice(0, k));
        }
        assert.deepEqual(dropped, [], `"${q}": rows "not requested yet" while their search was loading`);
        // Item records (icons) are requests of their own and may come a moment after the prices.
        await page.waitFor(`${settled} && [...document.querySelectorAll('#tp-results .tp-row')].every((li) => li.querySelector('.tp-icon img'))`, 10000).catch(() => {});
        const r = await page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((li) => ({ id: Number(li.dataset.id), sell: li.querySelector('.tp-sell').textContent, icon: Boolean(li.querySelector('.tp-icon img')) }))");
        if (ids) assert.deepEqual(r.map((x) => x.id), ids);
        assert.ok(r.length >= 1, q);
        assert.deepEqual(r.filter((x) => STUCK.test(x.sell) || !/silver|copper|gold|no sell listings/.test(x.sell)).map((x) => [x.id, x.sell]), [], `"${q}" typed key by key: rows without a price`);
        assert.deepEqual(r.filter((x) => !x.icon).map((x) => x.id), [], `"${q}" typed key by key: rows without an icon`);
      }
      assert.match(await text(page, '#tp-results .tp-row .tp-sell'), /silver|copper|gold/);
      // The same rows asked for twice in a row, every time: a fresh query (its prices and item records not here yet), then,
      // while its requests are on their way, the same query again (a trailing space), which cancels them and must ask
      // again at once. Typed key by key, whether the last search is one that would skip depends on the query's length
      // (the RC matrix of v0.4.1 missed a control that way); this does not.
      for (const q of ['charged lodestone', 'powerful venom']) {
        await page.eval(`(() => { const i = document.getElementById('tp-find'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
        await sleep(250);
        await page.eval(`(() => { const i = document.getElementById('tp-find'); i.value = ${JSON.stringify(q + ' ')}; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
        await sleep(200);
        assert.ok(!STUCK.test(await text(page, '#tp-results')), `"${q}" asked twice: a row left "not requested yet"`);
        await page.waitFor(`${settled} && [...document.querySelectorAll('#tp-results .tp-row')].every((li) => li.querySelector('.tp-icon img'))`, 10000).catch(() => {});
        const r = await page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((li) => ({ id: Number(li.dataset.id), sell: li.querySelector('.tp-sell').textContent, icon: Boolean(li.querySelector('.tp-icon img')) }))");
        assert.equal(r.length, 1, q);
        assert.deepEqual(r.filter((x) => !x.icon || !/silver|copper|gold|no sell listings/.test(x.sell)).map((x) => x.id), [], `"${q}" asked twice: rows without a price or an icon`);
      }
      // A price sort 300 ms after a search, while the search's prices are still on their way: every match is
      // priced and ranked, and the scope line says so.
      await typeTp(page, ''); await page.waitFor(settled, 10000).catch(() => {});
      await page.eval("(() => { const i = document.getElementById('tp-find'); i.value = 'mystic'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
      await sleep(300);
      await select(page, 'tp-sort', 'sell-desc');
      const all = Catalog.search(CAT, { query: 'mystic' }).indexes.length;
      await page.waitFor(`/^Ranked by lowest sell listing, high to low, among all ${all} matching items\\./.test(document.getElementById('tp-scope').textContent)`, 15000);
      await page.waitFor(settled, 10000);
      const sells = await page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((li) => li.querySelector('.tp-sell').textContent)");
      assert.deepEqual(sells.filter((x) => STUCK.test(x) || !/silver|copper|gold|no sell listings/.test(x)), [], 'every row shown is priced');
      const order = (await shownIds(page)).map((id) => priceOf(id).sells.unit_price || -1);
      const priced = order.filter((v) => v > 0), firstNone = order.indexOf(-1);
      assert.ok(priced.every((v, i) => !i || priced[i - 1] >= v), `in order: ${priced.slice(0, 8)}`);
      assert.ok(firstNone < 0 || order.slice(firstNone).every((v) => v === -1), 'no sell listings after the ranked ones');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
  });

  // v0.4.0 final correction: the downloaded site opened from disk. The browser refuses a file page's request for its
  // own item list, which is no connection problem: the page says the site must be served over HTTP or HTTPS.
  check('Trading Post: opened as a file, it says the site must be served over HTTP or HTTPS, not to check the connection, with no Try again; the timer keeps working', async () => {
    const FROM_FILE = 'The Trading Post needs this site to be served over HTTP or HTTPS. This copy was opened as a file, and this browser does not let a page opened that way request its own data, such as the item list. Open https://radmagelabs.com/gw2-timer/#market instead, or serve this folder with a local web server. The timer is not affected.';
    const FILE = pathToFileURL(join(DIR, 'index.html')).href;
    // Chrome's own words for the refused request: the only problem these pages may show.
    const REFUSED = [/^log: Access to fetch at 'file:\/\/\/[^']*\/data\/tp-items\.json\?v=[\d.]+' from origin 'null' has been blocked by CORS policy: /, /^log: Failed to load resource: net::ERR_FAILED$/, /^failed: net::ERR_FAILED /];
    // By the switch: the code loads (scripts work from a file), then the list request is refused.
    let page = await open({ at: AT, api: api(), url: FILE });
    try {
      await click(page, 'button[data-mode="market"]');
      await page.waitFor("/HTTP or HTTPS/.test(document.getElementById('tp-boot').textContent)", 15000);
      assert.equal(await text(page, '#tp-boot'), FROM_FILE);
      assert.deepEqual(await page.eval("[document.getElementById('tp-boot').hidden, document.getElementById('tp-retry').hidden, document.getElementById('tp-app').hidden, location.hash]"), [false, true, true, '#market']);
      assert.deepEqual(page.apiRequests, [], 'nothing asked of the API');
      const c1 = await text(page, '#local-time'); await sleep(1100);
      assert.notEqual(await text(page, '#local-time'), c1, 'the timer ticks on');
      await click(page, 'button[data-mode="timers"]'); await settle();
      assert.equal(await page.eval("document.getElementById('timers-view').hidden"), false);
      assert.ok((await page.eval("document.querySelectorAll('#next-list .row').length")) > 10, 'the timer shows its rows');
      // Back on the Trading Post it says the same, and still offers no retry that cannot work.
      await click(page, 'button[data-mode="market"]'); await settle();
      assert.deepEqual([await text(page, '#tp-boot'), await page.eval("document.getElementById('tp-retry').hidden")], [FROM_FILE, true]);
      assert.deepEqual(unexpected(page, REFUSED), []);
    } finally { await page.close(); }
    // By a link to an item, opened from the file: the same words, no details over them.
    page = await open({ at: AT, api: api(), url: FILE + '#market/item/19721', wait: false });
    try {
      await page.waitFor("/HTTP or HTTPS/.test(document.getElementById('tp-boot').textContent)", 15000);
      assert.equal(await text(page, '#tp-boot'), FROM_FILE);
      assert.deepEqual(await page.eval("[document.getElementById('tp-retry').hidden, document.getElementById('tp-item-dialog').open, document.getElementById('market-view').hidden]"), [true, false, false]);
      assert.deepEqual(page.apiRequests, []);
      assert.deepEqual(unexpected(page, REFUSED), []);
    } finally { await page.close(); }
  });

  check('Trading Post: the item list is read and searched quickly at 6x CPU slowdown (an emulated slow device, not a real phone)', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      await page.send('Emulation.setCPUThrottlingRate', { rate: 6 });
      const r = await page.eval(`(async () => { const t0 = performance.now(); const txt = await (await fetch('data/tp-items.json')).text(); const t1 = performance.now();
        const c = GW2Catalog.parse(txt).catalog; const t2 = performance.now(); const q = {};
        for (const w of ['ec', 'ecto', 'glob of ecto', 'sword', 'iron sword', 'mystic coin']) { const a = performance.now(); GW2Catalog.search(c, { query: w }); q[w] = Math.round((performance.now() - a) * 10) / 10; }
        return { fetch: Math.round(t1 - t0), parse: Math.round(t2 - t1), q }; })()`);
      await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      console.log(`     6x CPU: item list read ${r.fetch} ms (local), parsed ${r.parse} ms; searches ${JSON.stringify(r.q)} ms`);
      assert.ok(r.parse <= 1000, `parse ${r.parse} ms`);
      for (const [w, ms] of Object.entries(r.q)) assert.ok(ms <= 50, `${w}: ${ms} ms`);
    } finally { await page.close(); }
  });
}
