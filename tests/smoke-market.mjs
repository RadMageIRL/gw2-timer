// Browser checks for v0.4.0 Phase C: the two modes (Event Timers and Trading Post) and the Trading Post itself.
// Run by tests/smoke.mjs, in the same Chrome, with its helpers. Every API answer comes from here: real answers
// cut from the Phase A snapshot (tests/fixtures/tp-sample.json) for a few items, and made-up but fixed prices
// for every other item, so nothing depends on ArenaNet's servers and every run sees the same numbers.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  // ---- Search and prices ----

  check('Trading Post: search finds items by name, by words in any order, without accents, and by id; one letter asks for more; the count is said', async () => {
    const page = await open({ at: AT, api: api(), url: BASE + '#market', wait: false });
    try {
      await market(page);
      assert.match(await text(page, '#tp-empty'), /Search for an item by name or id/);
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
      assert.match(await text(page, '#tp-asof'), /^Item list as of Nov 15, 2026: 27,983 items/);
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
      const prices = page.apiRequests.filter((u) => /commerce\/prices/.test(u)), items = page.apiRequests.filter((u) => /\/v2\/items/.test(u));
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
      assert.equal(page.apiRequests.length, 0, 'nothing is asked for before a search');
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
      assert.match(await text(page, '#tp-scope'), /^Ranked by lowest sell listing, high to low, among only the \d+ of 27,983 matching items whose prices are loaded\. Not a ranking of every match, or of the whole market\./);
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  });

  check('Trading Post: Load whole market never starts by itself; it says what it costs, shows progress, can be cancelled, reports a partial load, and then ranks the whole market', async () => {
    let mode = 'ok';
    const page = await open({ at: AT, url: BASE + '#market', wait: false, api: api({ delay: 30, answer: (n, u) => (mode === 'partial' && /commerce\/prices/.test(u.pathname) && n % 9 === 0 ? 400 : 'ok') }) });
    try {
      await market(page);
      await sleep(1500);
      assert.equal(page.apiRequests.length, 0, 'nothing loads by itself');
      const box = () => page.eval("[document.getElementById('tp-whole-confirm').hidden, document.getElementById('tp-whole-btn').getAttribute('aria-expanded')]");
      assert.deepEqual(await box(), [true, 'false'], 'the explanation waits to be asked for');
      await click(page, '#tp-whole-btn'); await settle();
      assert.deepEqual(await box(), [false, 'true']);
      const ex = await text(page, '#tp-whole-explain');
      assert.match(ex, /27,983 items, 140 requests of 200 \(Phase A measured about 142 for the whole Trading Post\)/);
      assert.match(ex, /kept only while this page is open, and nothing is saved/);
      assert.equal(page.apiRequests.length, 0, 'still nothing before Load');
      assert.equal(await page.eval("document.activeElement.id"), 'tp-whole-start');
      // Cancel after a few requests.
      await click(page, '#tp-whole-start');
      await page.waitFor("document.getElementById('tp-whole-bar').value >= 6", 15000);
      assert.equal(await page.eval("document.getElementById('tp-whole-progress').hidden"), false);
      assert.equal(await page.eval("document.getElementById('tp-whole-confirm').hidden"), true, 'the explanation folds away while it loads');
      await click(page, '#tp-whole-cancel');
      await page.waitFor("/^Cancelled after \\d+ of 140 requests\\./.test(document.getElementById('tp-whole-status').textContent)", 10000);
      const atCancel = page.apiRequests.length;
      await sleep(1500);
      assert.ok(page.apiRequests.length <= atCancel, 'nothing more after Cancel');
      assert.ok(atCancel < 60, `cancelled early (${atCancel})`);
      // A partial load: some requests refused.
      mode = 'partial';
      await click(page, '#tp-whole-btn'); await click(page, '#tp-whole-start');
      await page.waitFor("/^Partly loaded/.test(document.getElementById('tp-whole-status').textContent)", 90000);
      assert.match(await text(page, '#tp-whole-status'), /^Partly loaded \(.+\): \d+ of 140 requests failed \(ArenaNet's API refused the request\)\. [\d,]+ items have a price; price sorts are partial\. Load again to try the rest\.$/);
      await select(page, 'tp-sort', 'sell-desc'); await idle(page);
      assert.match(await text(page, '#tp-scope'), /among only the [\d,]+ of 27,983 matching items whose prices are loaded\. Not a ranking of every match, or of the whole market\./);
      assert.ok(page.apiMaxLive <= 4, `at most 4 requests in flight (${page.apiMaxLive})`);
      // A complete load: the whole market, ranked.
      mode = 'ok';
      await click(page, '#tp-whole-btn'); await click(page, '#tp-whole-start');
      await page.waitFor("/^Whole market loaded/.test(document.getElementById('tp-whole-status').textContent)", 90000);
      assert.match(await text(page, '#tp-whole-status'), /^Whole market loaded \(.+\): prices for every item in the list\. It can be loaded again from .+\.$/);
      await idle(page);
      assert.equal(await text(page, '#tp-scope'), 'Ranked by lowest sell listing, high to low, across the whole market: all 27,983 items in the item list, from the whole-market load. ' + (() => { const w = expectedSort('', 'sell', 'desc'); return `${w.noSide.toLocaleString('en-US')} items with no sell listings come after the ranked ones.`; })());
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
        `${c(-1)} (${Money.percent(-1)} of the buy price)`, 'A potential margin, not a profit']) {
        assert.ok(body.replace(/\s+/g, '').includes(want.replace(/\s+/g, '')), `${want}\n in: ${body}`);
      }
      assert.match(await page.eval("document.getElementById('tp-item-body').textContent"), /a loss of 1 copper/, 'a screen reader hears a loss');
      assert.deepEqual(unexpected(page, NET), []);
    } finally { await page.close(); }
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
      for (const want of [`Highest buy order ${c(q.buy)} (391,900 units wanted in all buy orders)`, `Lowest sell listing ${c(q.sell)} (2,219,204 units listed in all)`,
        `Spread ${c(q.spread)}`, `would give you about ${c(q.sellNow.net)} after the listing fee of ${c(q.sellNow.listing)} and the exchange fee of ${c(q.sellNow.exchange)}`,
        `would give you about ${c(q.listAtLowest.net)} after fees, only if it sells`, `${c(q.margin)} (${Money.percent(q.marginPct)} of the buy price)`, 'A potential margin, not a profit', 'Item id 19721', 'Chat code [&AgEJTQAA]']) {
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
    for (const [hash, said] of [['#market/item/999999999', /not in the Trading Post item list \(as of Nov 15, 2026\)\. Nothing of yours was changed\./], ['#market/item/<b>x</b>', /could not be read\. Nothing of yours was changed\./]]) {
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
    for (const [file, how, said] of [['js/market.js', 'fail', /^The Trading Post could not load\./], ['data/tp-items.json', 'fail', /^The item list could not be loaded\./], ['data/tp-items.json', 'garbage', /^The item list that arrived could not be read/]]) {
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
