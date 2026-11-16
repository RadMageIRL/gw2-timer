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
   * HTTP status, for the n-th request (from 1); opts.delay holds each answer that many ms. opts.prices (id -> row)
   * replaces an item's prices; opts.mangle(rows) may spoil the rows of a prices answer.
   */
  function api(opts = {}) {
    return async (page, p) => {
      const url = new URL(p.request.url), n = page.apiRequests.length;
      page.apiLive = (page.apiLive || 0) + 1;
      page.apiMaxLive = Math.max(page.apiMaxLive || 0, page.apiLive);
      try {
        const how = opts.answer ? opts.answer(n, url) : 'ok';
        if (opts.delay) await sleep(opts.delay);
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
          const b = BOOK.get(Number(url.searchParams.get('id')));
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
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
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
      assert.equal(await text(page, '#tp-watch-text'), 'Prices from 7:00 AM, current.');
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
      await page.waitFor("document.getElementById('tp-watch-text').textContent === 'Prices from 7:06 AM, current.' && document.getElementById('tp-gem-text').textContent === 'Rates from 7:06 AM, current.'", 10000);
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
      await page.waitFor("/^Prices from 7:00 AM, current\\.$/.test(document.getElementById('tp-prices-text').textContent)", 10000);
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
        await page.waitFor("document.getElementById('tp-watch-text').textContent === 'Prices from 7:00 AM, current.'", 10000);
        assert.equal(await page.eval("document.querySelectorAll('#tp-watch-list .tp-note:not([hidden])').length"), 0, 'the notes go with the failure');
        assert.match(await page.eval("document.querySelector('#tp-watch-list [data-id=\"19721\"] .tp-sell').textContent"), /19 silver 10 copper/);
        assert.equal(await text(page, '#tp-watch-refresh'), 'Refresh prices');
        // Refresh asks again even for current prices: one more request for the eight.
        const asked = page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length;
        await click(page, '#tp-watch-refresh');
        const count = () => page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length;
        for (let i = 0; i < 50 && count() === asked; i++) await sleep(100);
        await page.waitFor("document.getElementById('tp-watch-text').textContent === 'Prices from 7:00 AM, current.' && !document.getElementById('tp-watch-refresh').hidden", 10000);
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
      assert.equal(await text(page, '#tp-watch-text'), 'Loading prices for 8 items... Prices from 7:00 AM, 12 minutes ago: stale.', 'no "Refresh" while a refresh is on its way');
      assert.equal(await page.eval("document.getElementById('tp-watch-prices').dataset.fresh"), 'stale');
      assert.deepEqual(await page.eval("[...new Set([...document.querySelectorAll('#tp-watch-list .tp-watch-card')].map((li) => li.classList.contains('is-stale') + ' ' + li.querySelector('.tp-note').textContent))]"), ['true Stale price, fetched 12 minutes ago.']);
      assert.match(await page.eval("document.querySelector('#tp-watch-list [data-id=\"19721\"] .tp-sell').textContent"), /19 silver 10 copper/, 'the older price stays');
      assert.deepEqual(await lowContrast(page, '#tp-watch-text, #tp-watch-list .tp-note'), [], 'stale, readable');
      // An hour on: the 30-second tick marks every card old, in place.
      await page.eval("document.querySelector('#tp-watch-list .tp-watch-card').dataset.mark = 'kept'");
      await later(page, 60 * 60000);
      await page.waitFor("document.querySelectorAll('#tp-watch-list .tp-watch-card.is-old').length === 8", 35000);
      assert.equal(await page.eval("document.querySelector('#tp-watch-list .tp-watch-card').dataset.mark"), 'kept', 'updated in place, not redrawn');
      assert.equal(await text(page, '#tp-watch-text'), 'Loading prices for 8 items... Prices from 7:00 AM, 72 minutes ago: old, shown faded.');
      assert.equal(await text(page, '#tp-watch-list .tp-note'), 'Old price, fetched 72 minutes ago.');
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
      for (let i = 0; i < 42; i++) { await key(page, 'Tab', 'Tab', 9); seen.push(await page.eval("(() => { const a = document.activeElement; return a.id || a.dataset.tpkey || a.className; })()")); }
      const tiles = Market.typeTiles(CAT);
      const order = ['tp-type', 'tp-rarity', 'tp-sort', 'tp-favs', 'tp-whole-btn', 'tp-watch-refresh', ...WATCH.map((id) => `watch:${id}`), 'tp-gem-refresh', ...tiles.map((t) => `cat:${t.index}`), 'tp-pill-list', 'tp-pill-fees', 'tp-pill-saved'];
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
      const look = await page.eval("({ big: parseFloat(getComputedStyle(document.querySelector('#tp-item-body .tp-stat-v')).fontSize), small: parseFloat(getComputedStyle(document.querySelector('#tp-item-body .tp-facts dd')).fontSize), first: [...document.getElementById('tp-item-body').children].slice(0, 2).map((c) => c.className), loss: document.querySelector('.tp-stat-margin .coins').classList.contains('neg') })");
      assert.ok(look.big >= look.small + 4, JSON.stringify(look));
      assert.deepEqual([look.first, look.loss], [['tp-detail-head', 'tp-stats-wrap'], true]);
      assert.equal(await text(page, '#tp-item-body .tp-stat-when'), "Prices fetched 7:00 AM, just now (current). ArenaNet's API may itself be up to 2 minutes behind.");
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
      assert.equal(await text(page, '#tp-favhome-text'), 'Prices from 7:00 AM, current.');
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
      assert.equal(await text(page, '#tp-gem-text'), 'Rates from 7:00 AM, current.');
      assert.equal(await text(page, '.tp-gem-note'), 'The rate changes with the amount, and buying gems and selling them are different prices: neither line is the other one reversed.');
      assert.deepEqual(asked(page).filter((x) => /exchange/.test(x)), ['/v2/commerce/exchange/coins quantity=1000000', '/v2/commerce/exchange/gems quantity=400']);
      // 12 minutes on, the API holding: the rates stay, said stale, no Refresh while one is on its way.
      how = 'hold';
      await later(page, 12 * 60000);
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await sleep(400);
      assert.equal(await text(page, '#tp-gem-text'), 'Loading the rates... Rates from 7:00 AM, 12 minutes ago: stale.');
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
      await page.waitFor("document.getElementById('tp-gem-text').textContent === 'Rates from 7:00 AM, current.'", 10000);
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
    const CLS = "window.__cls = 0; window.__shifts = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push((e.sources || []).map((x) => x.node && (x.node.id || x.node.className)).join(' ')); } }).observe({ type: 'layout-shift', buffered: true });";
    for (const [width, height, mobile] of [[1280, 900, false], [390, 844, true]]) {
      const page = await open({ at: AT, api: api({ delay: 300 }), url: BASE + '#market', wait: false, width, height, mobile, init: [CLS] });
      try {
        await market(page); await watchReady(page); await sleep(600);
        const r = await page.eval('({ cls: window.__cls, shifts: window.__shifts })');
        assert.ok(r.cls < 0.001, `${width}: CLS ${r.cls.toFixed(4)} from ${JSON.stringify(r.shifts)}`);
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
      assert.match(await text(page, '#tp-prices-text'), /^Prices from 7:00 AM, current\.$/);
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
      assert.match(await text(page, '#tp-prices-text'), /^Prices from 7:00 AM, current\.$/);
      hold = true;
      const later = (ms) => page.eval(`(() => { const prev = Date.now; Date.now = () => prev() + ${ms}; })()`);
      await later(12 * 60000);
      await click(page, '[data-mode="timers"]'); await click(page, '[data-mode="market"]'); await sleep(400);
      const stale = await text(page, '#tp-prices-text');
      assert.equal(stale, 'Loading prices for 2 items... Prices from 7:00 AM, 12 minutes ago: stale.', 'no "Refresh" while a refresh is on its way');
      assert.equal(await page.eval("document.getElementById('tp-prices').dataset.fresh"), 'stale');
      assert.deepEqual(await page.eval("[...document.querySelectorAll('#tp-results .tp-row')].map((r) => [r.classList.contains('is-stale'), r.querySelector('.tp-note').textContent])"), [[true, 'Stale price, fetched 12 minutes ago.'], [true, 'Stale price, fetched 12 minutes ago.']]);
      assert.deepEqual(await lowContrast(page, '#tp-results .tp-note'), [], 'the note is readable (dark)');
      assert.match(await page.eval("document.querySelector('#tp-results .tp-sell').textContent"), /silver|gold|copper/, 'the older price stays');
      await later(60 * 60000);
      await page.eval("document.getElementById('tp-favs').click()"); await page.eval("document.getElementById('tp-favs').click()"); await sleep(300);
      assert.equal(await text(page, '#tp-prices-text'), 'Loading prices for 2 items... Prices from 7:00 AM, 72 minutes ago: old, shown faded.');
      // The refresh gives up (the API holds): the older prices stay, said with their age, and Refresh is offered.
      await page.waitFor("/could not/.test(document.getElementById('tp-prices-text').textContent)", 70000);
      assert.match(await text(page, '#tp-prices-text'), /^ArenaNet's API did not answer in time, so some prices could not be refreshed\. Nothing is estimated in its place\. Prices from 7:00 AM, 7\d minutes ago: old, shown faded\. Refresh for current prices\.$/);
      assert.equal(await page.eval("document.getElementById('tp-refresh').hidden"), false);
      assert.equal(await page.eval("document.querySelectorAll('#tp-results .tp-row.is-old').length"), 2, 'faded');
      assert.match(await text(page, '#tp-results .tp-note'), /^Old price, fetched 7\d minutes ago\. A newer price could not be loaded: ArenaNet's API did not answer in time\.$/);
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
      assert.equal(await text(page, '#tp-prices-text'), 'Prices from 7:00 AM to 7:03 AM, current.', 'Glob of Ectoplasm kept from 7:00, the other fetched at 7:03');
      await page.eval('(() => { const prev = Date.now; Date.now = () => prev() + 3 * 60000; })()');
      await page.eval("document.getElementById('tp-favs').click()"); await page.eval("document.getElementById('tp-favs').click()"); await idle(page);
      assert.equal(await text(page, '#tp-prices-text'), 'Prices from 7:03 AM to 7:06 AM, current.', 'past 5 minutes the 7:00 price was asked again');
      // Refresh asks again even for current prices: one request for both rows, then one time.
      const before = page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length;
      await click(page, '#tp-refresh'); await idle(page);
      assert.equal(page.apiRequests.filter((u) => /commerce\/prices/.test(u)).length, before + 1);
      assert.equal(await text(page, '#tp-prices-text'), 'Prices from 7:06 AM, current.');
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
      assert.equal(await noteOf(19721), 'Stale price, fetched 6 minutes ago.');
      assert.equal(await noteOf(DRAGON), null);
      assert.equal(await text(page, '#tp-prices-text'), 'Prices from 7:00 AM, 6 minutes ago: stale. Refresh for current prices.');
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
