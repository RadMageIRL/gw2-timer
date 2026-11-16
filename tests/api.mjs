// Tests for js/api.js, the queue every Trading Post request goes through. Run alone with `node tests/api.mjs`, or
// through tests/run.mjs. A fake clock and a fake fetch: nothing here touches the network.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Api = require('../js/api.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.stack || e.message).split('\n').slice(0, 6).join('\n  ')}`); }
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
/** A clock and timers that move only when told to. */
function fakeClock() {
  let t = 1000000;
  const timers = [];
  return {
    now: () => t,
    setTimeout: (fn, ms) => { const x = { fn, at: t + Math.max(0, ms) }; timers.push(x); return x; },
    clearTimeout: (x) => { const k = timers.indexOf(x); if (k >= 0) timers.splice(k, 1); },
    async advance(ms) {
      const end = t + ms;
      await flush();
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const n = timers[0];
        if (!n || n.at > end) break;
        timers.shift(); t = n.at; n.fn(); await flush();
      }
      t = end; await flush();
    },
    pending: () => timers.length,
  };
}
const json = (status, body) => ({ status, json: async () => body });
/** A fetch that answers through `answer(url, n)`: a response, 'throw' (a network error), or 'hold' (never). It records calls. */
function fakeFetch(answer) {
  const calls = [];
  let live = 0;
  const f = (url, init) => {
    calls.push({ url, init, n: calls.length + 1 });
    const a = answer(url, calls.length);
    if (a === 'hold') return new Promise((ok, fail) => { if (init.signal) init.signal.addEventListener('abort', () => fail(new DOMException('Aborted', 'AbortError'))); });
    if (a === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
    if (a && a.later) { live++; f.maxLive = Math.max(f.maxLive, live); return a.later.then((r) => { live--; return r; }); }
    return Promise.resolve(a);
  };
  f.calls = calls; f.maxLive = 0;
  return f;
}
const ids = (url) => (new URL(url).searchParams.get('ids') || '').split(',').filter(Boolean).map(Number);
const priceRow = (id) => ({ id, whitelisted: false, buys: { quantity: 1, unit_price: id }, sells: { quantity: 2, unit_price: id + 5 } });
const okPrices = (url) => json(200, ids(url).map(priceRow));

await test('the module needs nothing from a page and sets one global', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'api.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['GW2Api']);
});

await test('every request is a plain GET to api.guildwars2.com with the schema version, no cookies and no referrer', async () => {
  const clock = fakeClock(), fetch = fakeFetch(okPrices);
  const c = Api.createClient({ fetch, ...clock });
  const r = await c.prices([5, 3, 4, 3]);
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://api.guildwars2.com/v2/commerce/prices?ids=3,4,5&v=2025-08-29T01%3A00%3A00Z', 'ids sorted and once each');
  assert.deepEqual([init.method, init.credentials, init.referrerPolicy, init.headers], ['GET', 'omit', 'no-referrer', undefined], 'no header: a header would need a preflight');
  assert.deepEqual([...r.rows.keys()], [3, 4, 5]);
  assert.equal(r.rows.get(3).at, clock.now(), 'each row carries the time it came');
  assert.deepEqual([r.missing.size, r.failed.length, r.error, r.requests, r.answered], [0, 0, null, 1, 1]);
});

await test('ids go 200 to a request: 201 ids are two requests, 27,983 are 140', async () => {
  const clock = fakeClock(), fetch = fakeFetch(okPrices);
  const c = Api.createClient({ fetch, ...clock, perSec: 1000, burst: 1000 });
  const many = Array.from({ length: 201 }, (_, i) => i + 1);
  const p = c.prices(many);
  await clock.advance(100);
  const r = await p;
  assert.deepEqual(fetch.calls.map((x) => ids(x.url).length), [200, 1]);
  assert.equal(r.rows.size, 201);
  assert.equal(c.requestsFor(Array.from({ length: 27983 }, (_, i) => i + 1)), 140);
  assert.equal(c.requestsFor([0, -1, 1.5, 'x']), 0, 'nothing that is not an item id is sent');
});

await test('at most 4 requests are in flight, and starts keep to 4 a second after a burst of 20', async () => {
  const clock = fakeClock();
  const gates = [];
  const fetch = fakeFetch((url) => { let open; const later = new Promise((ok) => { open = () => ok(okPrices(url)); }); gates.push(open); return { later }; });
  const c = Api.createClient({ fetch, ...clock });
  const all = Array.from({ length: 60 * 200 }, (_, i) => i + 1);
  const p = c.prices(all);
  await clock.advance(0);
  assert.equal(fetch.calls.length, 4, 'four at once');
  // Answer everything as it comes: starts are then limited by the bucket only.
  const starts = [];
  for (let step = 0; step < 400 && fetch.calls.length < 60; step++) {
    while (gates.length) gates.shift()();
    await flush();
    starts.push([clock.now(), fetch.calls.length]);
    await clock.advance(50);
  }
  starts.push([clock.now(), fetch.calls.length]);
  while (gates.length) gates.shift()();
  await clock.advance(1000);
  const r = await p;
  assert.equal(r.rows.size, 60 * 200);
  assert.equal(fetch.maxLive, 4, 'never more than 4 in flight');
  const t0 = starts[0][0];
  const at = (n) => starts.find(([, k]) => k >= n)[0] - t0;
  assert.ok(at(20) < 200, `the first 20 go at once (${at(20)} ms)`);
  assert.ok(at(60) >= 9500 && at(60) <= 10600, `the other 40 at 4 a second: ${at(60)} ms`);
  assert.equal(c.stats().maxInFlight, 4);
});

await test('a 206 is success: the ids the API has no row for are "missing", not failed; an all-unknown 404 is missing too', async () => {
  const clock = fakeClock();
  const fetch = fakeFetch((url) => { const want = ids(url).filter((x) => x < 100); return want.length ? json(206, want.map(priceRow)) : json(404, { text: 'all ids provided are invalid' }); });
  const c = Api.createClient({ fetch, ...clock });
  const r = await c.prices([1, 2, 150]);
  assert.deepEqual([[...r.rows.keys()], [...r.missing], r.failed, r.error], [[1, 2], [150], [], null]);
  const n = await c.prices([300, 400]);
  assert.deepEqual([n.rows.size, [...n.missing].sort(), n.error], [0, [300, 400], null]);
});

await test('malformed rows, rows for ids not asked for, and a body that is not JSON are never taken as prices, nor as "missing"', async () => {
  const clock = fakeClock();
  const fetch = fakeFetch((url, n) => (n === 1 ? json(200, [priceRow(1), { id: 2, buys: { unit_price: 'x', quantity: 1 }, sells: { unit_price: 3, quantity: 1 } }, priceRow(9), null, 'x'])
    : { status: 200, json: async () => { throw new SyntaxError('bad'); } }));
  const c = Api.createClient({ fetch, ...clock });
  const r = await c.prices([1, 2]);
  // Id 2 came back unreadable: a failure the page says is one, never "not on the Trading Post".
  assert.deepEqual([[...r.rows.keys()], [...r.missing], r.failed, [...r.errors], r.error], [[1], [], [2], [[2, 'bad-data']], 'bad-data']);
  const b = await c.prices([3]);
  assert.deepEqual([b.rows.size, b.failed, b.error], [0, [3], 'bad-data'], 'not JSON: failed, not retried');
  assert.equal(fetch.calls.length, 2);
});

await test('429, 5xx and network errors are tried again after 2, 4 and 8 s, then reported; nothing throws', async () => {
  for (const [fail, error] of [[json(429, { text: 'too many' }), 'rate-limited'], [json(503, {}), 'server'], ['throw', 'network']]) {
    const clock = fakeClock(), fetch = fakeFetch(() => fail);
    const c = Api.createClient({ fetch, ...clock });
    let done = null;
    c.prices([7]).then((r) => { done = r; });
    await clock.advance(0);
    const times = [];
    for (const wait of [2000, 4000, 8000]) { times.push(fetch.calls.length); await clock.advance(wait - 1); assert.equal(fetch.calls.length, times[times.length - 1], `${error}: not before ${wait} ms`); await clock.advance(1); }
    await clock.advance(10);
    assert.equal(fetch.calls.length, 4, `${error}: one try and three more`);
    assert.deepEqual([done.rows.size, done.failed, done.error], [0, [7], error]);
  }
});

await test('a 429 holds the whole queue for its wait; a retry that then succeeds gives the prices', async () => {
  const clock = fakeClock();
  const fetch = fakeFetch((url, n) => (n === 1 ? json(429, {}) : okPrices(url)));
  const c = Api.createClient({ fetch, ...clock, concurrency: 1 });
  const a = c.prices([1]);
  await clock.advance(0);
  const b = c.prices([2]);
  await clock.advance(1999);
  assert.equal(fetch.calls.length, 1, 'nothing else starts while the queue is held');
  await clock.advance(2);
  await clock.advance(10);
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.rows.has(1), rb.rows.has(2), ra.error], [true, true, null]);
  assert.equal(c.stats().rateLimited, 1);
});

await test('400 and other refusals are not tried again', async () => {
  const clock = fakeClock(), fetch = fakeFetch(() => json(400, { text: 'id list too long' }));
  const c = Api.createClient({ fetch, ...clock });
  const r = await c.prices([1]);
  assert.deepEqual([fetch.calls.length, r.error], [1, 'http']);
});

await test('a request with no answer times out after 8 s and is tried again; it gives up after the last wait', async () => {
  const clock = fakeClock(), fetch = fakeFetch(() => 'hold');
  const c = Api.createClient({ fetch, ...clock });
  let done = null;
  c.prices([1]).then((r) => { done = r; });
  await clock.advance(7999);
  assert.equal(done, null);
  await clock.advance(1);
  await clock.advance(2000);
  assert.equal(fetch.calls.length, 2, 'tried again after the timeout and 2 s');
  await clock.advance(8000 + 4000 + 8000 + 8000 + 8000 + 100);
  assert.deepEqual([fetch.calls.length, done && done.error], [4, 'timeout']);
});

await test('cancelling stops queued requests from ever being sent and ends those in flight; a cancelled batch is "aborted", not an error to show', async () => {
  const clock = fakeClock(), fetch = fakeFetch(() => 'hold');
  const c = Api.createClient({ fetch, ...clock });
  const ctl = new AbortController();
  let done = null, batches = 0;
  c.prices(Array.from({ length: 2000 }, (_, i) => i + 1), { signal: ctl.signal, onBatch: () => { batches++; } }).then((r) => { done = r; });
  await clock.advance(0);
  assert.equal(fetch.calls.length, 4);
  assert.equal(c.stats().queued, 6);
  ctl.abort();
  assert.equal(c.stats().queued, 0, 'out of the queue at once, not when the queue next moves');
  await clock.advance(20000);
  assert.equal(fetch.calls.length, 4, 'nothing more is sent');
  assert.equal(done.error, 'aborted');
  assert.equal(done.failed.length, 2000);
  assert.equal(batches, 10, 'every batch reports, so progress ends');
  assert.equal(c.stats().inFlight, 0);
  // A cancelled request waiting for a retry is never sent again.
  const f2 = fakeFetch(() => json(503, {})), c2 = Api.createClient({ fetch: f2, ...clock });
  const ctl2 = new AbortController();
  const p2 = c2.prices([1], { signal: ctl2.signal });
  await clock.advance(10);
  ctl2.abort();
  await clock.advance(20000);
  assert.deepEqual([f2.calls.length, (await p2).error], [1, 'aborted']);
  // Already cancelled: nothing at all.
  const f3 = fakeFetch(okPrices), c3 = Api.createClient({ fetch: f3, ...clock });
  const ctl3 = new AbortController(); ctl3.abort();
  assert.equal((await c3.prices([1], { signal: ctl3.signal })).error, 'aborted');
  assert.equal(f3.calls.length, 0);
});

await test('a whole-market load with some requests failing reports partial: rows for the rest, the failed ids, the worst error', async () => {
  const clock = fakeClock();
  const fetch = fakeFetch((url, n) => (ids(url)[0] === 401 ? json(400, {}) : ids(url)[0] === 1001 ? 'throw' : okPrices(url)));
  const c = Api.createClient({ fetch, ...clock, perSec: 1000, burst: 1000 });
  const progress = [];
  const p = c.prices(Array.from({ length: 1400 }, (_, i) => i + 1), { onBatch: (x) => progress.push(x) });
  await clock.advance(20000);
  const r = await p;
  assert.equal(r.requests, 7);
  assert.equal(r.answered, 5);
  assert.equal(r.rows.size, 1000);
  assert.equal(r.failed.length, 400);
  assert.equal(r.error, 'network', 'network is worse than a refusal');
  assert.deepEqual(progress[progress.length - 1], { requests: 7, done: 7, answered: 5, failed: 400 });
});

await test('items and listings: the record fields, and an order book cut to well-formed tiers; an unknown id is "not found"', async () => {
  const clock = fakeClock();
  const fetch = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/v2/items') return json(200, ids(url).map((id) => ({ id, name: `Item ${id}`, icon: 'https://render.guildwars2.com/file/X/1.png' })).concat([{ id: 5 }]));
    if (u.searchParams.get('id') === '9') return json(404, { text: 'no such id' });
    return json(200, { id: 19721, buys: [{ listings: 1, unit_price: 1706, quantity: 133 }, { listings: 1, unit_price: 0, quantity: 5 }, { listings: 1, unit_price: 'x', quantity: 5 }, { listings: 1, unit_price: 9, quantity: 0 }], sells: [{ listings: 2, unit_price: 1895, quantity: 231 }, { unit_price: 5, quantity: 5 }] });
  });
  const c = Api.createClient({ fetch, ...clock });
  const it = await c.items([3, 4]);
  assert.deepEqual([...it.rows.keys()], [3, 4]);
  assert.match(fetch.calls[0].url, /\/v2\/items\?ids=3,4&lang=en&v=/);
  const b = await c.listings(19721);
  assert.deepEqual([b.ok, b.book.buys.length, b.book.sells.length, b.book.at], [true, 1, 1, clock.now()]);
  assert.match(fetch.calls[1].url, /\/v2\/commerce\/listings\?id=19721&v=/);
  assert.deepEqual(await c.listings(9), { ok: true, notFound: true });
  assert.equal((await c.listings(-1)).ok, false);
});

await test('the worst error is reported, whichever request ends last: a refusal (400) is worse than an unreadable answer', async () => {
  const clock = fakeClock();
  const fetch = fakeFetch((url) => (ids(url)[0] === 1 ? json(400, {}) : { status: 200, json: async () => { throw new SyntaxError('bad'); } }));
  const c = Api.createClient({ fetch, ...clock, concurrency: 1 });
  const r = await (async () => { const p = c.prices(Array.from({ length: 400 }, (_, i) => i + 1)); await clock.advance(1000); return p; })();
  assert.deepEqual(fetch.calls.map((x) => ids(x.url)[0]), [1, 201], 'the refusal first, the unreadable answer last');
  assert.equal(r.error, 'http');
});

await test('after an idle spell the burst is still 20, never more: the bucket does not fill past it', async () => {
  const clock = fakeClock();
  const fetch = fakeFetch(okPrices);
  const c = Api.createClient({ fetch, ...clock, concurrency: 100 });
  await clock.advance(120000);
  const p = c.prices(Array.from({ length: 60 * 200 }, (_, i) => i + 1));
  await clock.advance(0);
  assert.equal(fetch.calls.length, 20, '20 at once after two idle minutes');
  await clock.advance(10000);
  await p;
  assert.equal(fetch.calls.length, 60, 'the other 40 at 4 a second');
});

await test('only the API saying so makes an id "missing": a list without it or a 404; a 200 that is not a list, or a list of rows that cannot be told apart, is "bad-data"', async () => {
  const clock = fakeClock();
  const answers = [json(200, { text: 'not a list' }), json(200, [null, { id: 'x' }]), json(206, [priceRow(1)]), json(200, [priceRow(1), { nope: 1 }])];
  const fetch = fakeFetch((url, n) => answers[n - 1]);
  const c = Api.createClient({ fetch, ...clock });
  const a = await c.prices([1, 2]);
  assert.deepEqual([a.rows.size, [...a.missing], a.failed, a.error, a.answered], [0, [], [1, 2], 'bad-data', 0], 'not a list: the request did not answer usably');
  const b = await c.prices([1, 2]);
  assert.deepEqual([b.rows.size, [...b.missing], b.failed, b.error], [0, [], [1, 2], 'bad-data'], 'rows with no usable id: none of the ids is known to be absent');
  const d = await c.prices([1, 2]);
  assert.deepEqual([[...d.rows.keys()], [...d.missing], d.failed, d.error], [[1], [2], [], null], 'a readable 206 without id 2: missing');
  const e = await c.prices([1, 2]);
  assert.deepEqual([[...e.rows.keys()], [...e.missing], e.failed, e.error], [[1], [], [2], 'bad-data'], 'one row that cannot be told apart: id 2 is not known to be absent');
});

await test('each failed id keeps its own error, beside the worst one for the whole set', async () => {
  const clock = fakeClock();
  const fetch = fakeFetch((url) => (ids(url)[0] === 1 ? json(400, {}) : ids(url)[0] === 201 ? 'throw' : okPrices(url)));
  const c = Api.createClient({ fetch, ...clock });
  const p = c.prices(Array.from({ length: 600 }, (_, i) => i + 1));
  await clock.advance(20000);
  const r = await p;
  assert.deepEqual([r.rows.size, r.failed.length, r.error], [200, 400, 'network']);
  assert.deepEqual([r.errors.get(1), r.errors.get(200), r.errors.get(201), r.errors.get(400), r.errors.has(401)], ['http', 'http', 'network', 'network', false]);
});

await test('a wait before a retry is told to onRetry; paused() is true only while a 429 holds the queue', async () => {
  const clock = fakeClock(), seen = [];
  const fetch = fakeFetch((url, n) => (n === 1 ? json(429, {}) : n === 2 ? json(503, {}) : okPrices(url)));
  const c = Api.createClient({ fetch, ...clock, onRetry: (x) => seen.push([x.error, x.wait]) });
  assert.equal(c.paused(), false);
  const p = c.prices([5]);
  await clock.advance(0);
  assert.deepEqual(seen, [['rate-limited', 2000]]);
  assert.equal(c.paused(), true, 'held by the 429');
  assert.equal(c.stats().pausedUntil, clock.now() + 2000);
  await clock.advance(2000);
  assert.deepEqual(seen, [['rate-limited', 2000], ['server', 4000]]);
  assert.equal(c.paused(), false, 'a 5xx wait does not hold the queue');
  await clock.advance(4000);
  const r = await p;
  assert.deepEqual([r.rows.has(5), r.error], [true, null]);
});

// ---- The gem exchange (post-v0.4.0 polish) ----

await test('gem exchange: one GET a direction, for the amount given, through the same queue; the quote says what is given and what is got, in which currency', async () => {
  const clock = fakeClock();
  // As the real API answered on 2026-11-16: 1,000,000 copper (100 gold) gets 225 gems; 400 gems get 1,197,567 copper.
  const fetch = fakeFetch((url) => (/exchange\/coins/.test(url) ? json(200, { coins_per_gem: 4444, quantity: 225 }) : json(200, { coins_per_gem: 2993, quantity: 1197567 })));
  const c = Api.createClient({ fetch, ...clock });
  const [buy, sell] = await Promise.all([c.exchange('coins', 1000000), c.exchange('gems', 400)]);
  assert.deepEqual(buy, { ok: true, quote: { direction: 'coins', give: 1000000, get: 225, coinsPerGem: 4444, at: clock.now() } });
  assert.deepEqual(sell, { ok: true, quote: { direction: 'gems', give: 400, get: 1197567, coinsPerGem: 2993, at: clock.now() } });
  const urls = fetch.calls.map((x) => x.url).sort();
  assert.deepEqual(urls, ['https://api.guildwars2.com/v2/commerce/exchange/coins?quantity=1000000&v=2025-08-29T01%3A00%3A00Z', 'https://api.guildwars2.com/v2/commerce/exchange/gems?quantity=400&v=2025-08-29T01%3A00%3A00Z']);
  assert.ok(fetch.calls.every((x) => x.init.method === 'GET' && x.init.credentials === 'omit' && x.init.referrerPolicy === 'no-referrer'));
  assert.equal(c.stats().started, 2, 'through the queue');
});

await test('gem exchange: a direction or amount that is not one never reaches the API; a refusal (400, too few coins), an unreadable answer and a 404 are errors, never a rate; 5xx is tried again', async () => {
  const clock = fakeClock();
  let mode = 'refuse';
  const fetch = fakeFetch(() => (mode === 'refuse' ? json(400, { text: 'too few coins' }) : mode === 'junk' ? json(200, { coins_per_gem: '44', quantity: 225 })
    : mode === 'zero' ? json(200, { coins_per_gem: 0, quantity: 0 }) : mode === 'gone' ? json(404, { text: 'no' }) : mode === 'down' ? json(503, {}) : json(200, { coins_per_gem: 4444, quantity: 225 })));
  const c = Api.createClient({ fetch, ...clock });
  for (const [d, q] of [['coin', 100], ['gems', 0], ['gems', -4], ['coins', 1.5], ['coins', '100'], [null, 100]]) assert.deepEqual(await c.exchange(d, q), { ok: false, error: 'http' }, `${d} ${q}`);
  assert.equal(fetch.calls.length, 0, 'nothing sent for those');
  assert.deepEqual(await c.exchange('coins', 100), { ok: false, error: 'http', status: 400 });
  assert.equal(fetch.calls.length, 1, 'a refusal is not tried again');
  for (const m of ['junk', 'zero', 'gone']) { mode = m; assert.equal((await c.exchange('coins', 1000000)).error, 'bad-data', m); }
  mode = 'down';
  const p = c.exchange('gems', 400);
  await clock.advance(1000);
  const tries = fetch.calls.length;
  mode = 'ok';
  await clock.advance(1500);
  assert.equal(fetch.calls.length, tries + 1, 'tried again after 2 s');
  assert.deepEqual((await p).quote.get, 225, 'then the rate');
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
