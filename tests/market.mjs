// Tests for the parts of js/market.js that need no page: saved favorites, price freshness, and the words that say
// what a sort covers. The page itself is checked in tests/smoke-market.mjs. Run alone with `node tests/market.mjs`,
// or through tests/run.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Market = require('../js/market.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

test('the module loads with no page (mount needs one) and sets one global', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'market.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['GW2Market']);
  assert.equal(typeof ctx.GW2Market.mount, 'function');
});

test('saved favorites keep only whole item ids the list has, once each, at most 500', () => {
  const known = new Map([[19721, 0], [24295, 1], [30684, 2]]);
  assert.deepEqual(Market.sanitizeFavorites([19721, '24295', 19721, 1.5, -3, 0, 999, 30684, null, { id: 1 }], known), [19721, 30684]);
  assert.deepEqual(Market.sanitizeFavorites('19721', known), []);
  assert.deepEqual(Market.sanitizeFavorites(null, known), []);
  assert.deepEqual(Market.sanitizeFavorites({ 0: 19721 }, known), []);
  const many = Array.from({ length: 700 }, (_, i) => i + 1);
  assert.equal(Market.sanitizeFavorites(many, null).length, 500);
  assert.equal(Market.FAV_KEY, 'tp-favorites');
});

test('prices are current under 5 minutes, stale up to an hour, then old', () => {
  const t = 1e12, m = 60000;
  assert.deepEqual([0, 4 * m + 59999, 5 * m, 59 * m, 60 * m, 600 * m].map((d) => Market.freshness(t - d, t)), ['current', 'current', 'stale', 'stale', 'old', 'old']);
  assert.deepEqual([Market.CURRENT_MS, Market.OLD_MS, Market.SORT_CAP, Market.PAGE], [300000, 3600000, 1000, 50]);
});

const base = { sort: 'sell-desc', matches: 312, ranked: 300, noSide: 12, unpriced: 0, loading: false, failed: false, wholeAll: false, listCount: 27983, filtered: true };
test('a price sort over every match says it ranks all the matches, and that it is not the whole market', () => {
  assert.equal(Market.scopeText(base), 'Ranked by lowest sell listing, high to low, among all 312 matching items. Not a ranking of the whole market. 12 items with no sell listings come after the ranked ones.');
  assert.equal(Market.scopeText({ ...base, sort: 'buy-asc', noSide: 0, ranked: 312 }), 'Ranked by highest buy order, low to high, among all 312 matching items. Not a ranking of the whole market.');
  assert.equal(Market.scopeText({ ...base, matches: 1, ranked: 1, noSide: 0 }), 'Ranked by lowest sell listing, high to low, among all 1 matching item. Not a ranking of the whole market.');
});

test('a price sort over only some matches says how many, that it ranks neither every match nor the market, and what would complete it', () => {
  const part = { ...base, ranked: 40, noSide: 10, unpriced: 262 };
  assert.equal(Market.scopeText({ ...part, loading: true }), 'Ranked by lowest sell listing, high to low, among only the 50 of 312 matching items whose prices are loaded. Not a ranking of every match, or of the whole market. Loading the other prices... 10 items with no sell listings come after the ranked ones.');
  assert.equal(Market.scopeText({ ...part, failed: true, noSide: 0, ranked: 50 }), 'Ranked by lowest sell listing, high to low, among only the 50 of 312 matching items whose prices are loaded. Not a ranking of every match, or of the whole market. The other prices could not be loaded.');
  assert.equal(Market.scopeText({ ...part, matches: 1075, unpriced: 1025, noSide: 0, ranked: 50 }), 'Ranked by lowest sell listing, high to low, among only the 50 of 1,075 matching items whose prices are loaded. Not a ranking of every match, or of the whole market. To rank every match, narrow the search to 1,000 items or fewer, or load the whole market.');
});

test('only every item in the list, every price loaded, nothing typed and no filter is "the whole market"', () => {
  const all = { ...base, matches: 27983, ranked: 27700, noSide: 283, unpriced: 0, filtered: false };
  assert.equal(Market.scopeText({ ...all, wholeAll: true }), 'Ranked by lowest sell listing, high to low, across the whole market: all 27,983 items in the item list, from the whole-market load. 283 items with no sell listings come after the ranked ones.');
  assert.match(Market.scopeText({ ...all, filtered: true }), /among all 27,983 matching items\. Not a ranking of the whole market\./, 'a filter that happens to match everything is not the market');
  assert.match(Market.scopeText({ ...all, unpriced: 1, ranked: 27699 }), /among only the 27,982 of 27,983 matching items/, 'one price missing and it is partial');
  assert.match(Market.scopeText({ ...all, matches: 27900 }), /among all 27,900 matching items\. Not a ranking/, 'fewer than the whole list is not the market');
});

test('every sort the page offers has its words; name and best match say so', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const offered = [...html.slice(html.indexOf('<select id="tp-sort"'), html.indexOf('</select>', html.indexOf('<select id="tp-sort"'))).matchAll(/<option value="([a-z-]+)">([^<]+)</g)];
  assert.deepEqual(offered.map((m) => m[1]), Object.keys(Market.SORTS));
  for (const [, v, label] of offered) {
    const s = Market.SORTS[v];
    if (s.key) assert.equal(label, `${s.what === 'potential margin after fees' ? 'Potential margin' : s.what[0].toUpperCase() + s.what.slice(1)}, ${s.how}`, v);
    else assert.equal(label, s.label, v);
  }
  assert.equal(Market.scopeText({ ...base, sort: 'name' }), 'Sorted by name.');
  assert.equal(Market.scopeText({ ...base, sort: 'relevance' }), 'Best matches first, then by name.');
});

test('an item list that does not load: opened as a file it says the site must be served over HTTP or HTTPS, with no retry; served, the connection and reading messages stay', () => {
  const SITE = 'https://radmagelabs.com/gw2-timer/';
  const CONNECTION = 'The item list could not be loaded. Check your connection and try again. The timer is not affected.';
  const UNREADABLE = 'The item list that arrived could not be read, so nothing is searched. Try again later. The timer is not affected.';
  const FROM_FILE = 'The Trading Post needs this site to be served over HTTP or HTTPS. This copy was opened as a file, and this browser does not let a page opened that way request its own data, such as the item list. Open https://radmagelabs.com/gw2-timer/#market instead, or serve this folder with a local web server. The timer is not affected.';
  // Opened as a file (or from a phone's file viewer): no answer is a browser rule, not the connection.
  for (const protocol of ['file:', 'content:']) assert.deepEqual(Market.listFailure('network', protocol, SITE), { retry: false, text: FROM_FILE }, protocol);
  assert.doesNotMatch(FROM_FILE, /connection|try again/i);
  assert.match(Market.listFailure('network', 'file:', '').text, /Open the site from its web address instead, or serve this folder/);
  // Served over HTTP or HTTPS: a real network failure or an HTTP error is the connection's, and Try again is offered.
  for (const protocol of ['http:', 'https:']) {
    for (const error of ['network', 'HTTP 404', 'HTTP 503']) assert.deepEqual(Market.listFailure(error, protocol, SITE), { retry: true, text: CONNECTION }, `${protocol} ${error}`);
    assert.deepEqual(Market.listFailure('not the item list format', protocol, SITE), { retry: true, text: UNREADABLE });
  }
  // A list that did arrive from a file but cannot be read is still an unreadable list, not a file problem.
  assert.deepEqual(Market.listFailure('not the item list format', 'file:', SITE), { retry: true, text: UNREADABLE });
  // The page passes its own address and the site's, and offers Try again only when it is offered.
  const mk = readFileSync(join(ROOT, 'js', 'market.js'), 'utf8');
  assert.ok(mk.includes('const f = listFailure(r.error, location.protocol, canonical);\n        setBoot(f.text, f.retry);'));
});

test('item types read as words', () => {
  assert.deepEqual(['CraftingMaterial', 'UpgradeComponent', 'MiniPet', 'Back', 'JadeTechModule', 'SomethingNew'].map(Market.typeLabel), ['Crafting material', 'Upgrade component', 'Miniature', 'Back item', 'Jade Tech module', 'Something New']);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
