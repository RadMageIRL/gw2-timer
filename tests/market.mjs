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
    if (s.key) assert.equal(label, `${s.short || (s.what === 'potential margin after fees' ? 'Potential margin' : s.what[0].toUpperCase() + s.what.slice(1))}, ${s.how}`, v);
    else assert.equal(label, s.label, v);
  }
  assert.equal(Market.scopeText({ ...base, sort: 'name' }), 'Sorted by name.');
  assert.equal(Market.scopeText({ ...base, sort: 'relevance' }), 'Best matches first, then by name.');
  // The margin as a percentage says what it is a percentage of, and that items with no buy orders (no denominator) come last.
  assert.equal(Market.SORTS['marginpct-desc'].key, 'marginPct');
  assert.equal(Market.scopeText({ ...base, sort: 'marginpct-desc', matches: 358, ranked: 350, noSide: 8, unpriced: 0 }),
    'Ranked by potential margin as a share of the highest buy order, largest first, among all 358 matching items. Not a ranking of the whole market. 8 items with no buy orders or no sell listings come after the ranked ones.');
  assert.equal(Market.scopeText({ ...base, sort: 'marginpct-desc', matches: 1075, ranked: 48, noSide: 2, unpriced: 1025 }),
    'Ranked by potential margin as a share of the highest buy order, largest first, among only the 50 of 1,075 matching items whose prices are loaded. Not a ranking of every match, or of the whole market. To rank every match, narrow the search to 1,000 items or fewer, or load the whole market. 2 items with no buy orders or no sell listings come after the ranked ones.');
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

// ---- The home (post-v0.4.0 landing page) ----

const Catalog = require('../js/catalog.js');
const CAT = Catalog.parse(readFileSync(join(ROOT, 'data', 'tp-items.json'), 'utf8')).catalog;

test('Market Watch is the eight hand-picked items, in its order, each in the committed item list; an id the list loses is left out', () => {
  assert.deepEqual(Market.WATCH, [19976, 19721, 68063, 24277, 24295, 19701, 19725, 19746]);
  assert.deepEqual(Market.watchIds(CAT).map((id) => CAT.names[CAT.byId.get(id)]),
    ['Mystic Coin', 'Glob of Ectoplasm', 'Amalgamated Gemstone', 'Pile of Crystalline Dust', 'Vial of Powerful Blood', 'Orichalcum Ore', 'Ancient Wood Log', 'Bolt of Gossamer']);
  const fewer = { byId: new Map([[19721, 0], [24295, 1]]) };
  assert.deepEqual(Market.watchIds(fewer), [19721, 24295]);
  assert.deepEqual(Market.watchIds({ byId: new Map() }), []);
});

test('the home\'s types are exactly the item list\'s, ordered as the Type list, each with its count and a drawing; a type with no drawing gets the box', () => {
  const tiles = Market.typeTiles(CAT);
  assert.equal(tiles.length, CAT.types.length);
  assert.deepEqual(tiles.map((t) => t.type).sort(), CAT.types.slice().sort(), 'no type invented, none left out');
  assert.equal(tiles.reduce((a, t) => a + t.count, 0), CAT.count, 'every item counted once');
  for (const t of tiles) {
    assert.equal(t.count, Array.from(CAT.type).filter((x) => x === t.index).length, t.type);
    assert.equal(t.label, Market.typeLabel(t.type));
    assert.equal(CAT.types[t.index], t.type);
    assert.ok(Market.TYPE_ICON[t.type], `${t.type} has its own drawing`);
    assert.equal(t.icon, Market.TYPE_ICON[t.type]);
  }
  assert.deepEqual(tiles.map((t) => t.label), tiles.map((t) => t.label).slice().sort(), 'by label');
  assert.equal(tiles.find((t) => t.type === 'Weapon').count, 11780);
  // A refreshed list with a type this page has no drawing for still shows it, with the plain box.
  const odd = { types: ['Weapon', 'Novelty'], count: 3, type: Uint8Array.from([0, 1, 1]) };
  const t2 = Market.typeTiles(odd);
  assert.deepEqual(t2.map((t) => [t.label, t.count]), [['Novelty', 2], ['Weapon', 1]]);
  assert.equal(t2[0].icon, 'M5 5h14v14H5z M5 9h14');
  // Each drawing is a path of commands and numbers only.
  for (const [k, d] of Object.entries(Market.TYPE_ICON)) assert.match(d, /^[MmLlHhVvCcSsAaZz0-9 .,-]+$/, k);
});

test('the line beside "Trading Post home" names the results: type, rarity, Favorites and what is typed, or every item', () => {
  const s = (o) => ({ query: '', type: -1, rarity: -1, favOnly: false, ...o });
  const w = CAT.types.indexOf('Weapon'), ex = CAT.rarities.indexOf('Exotic');
  assert.equal(Market.crumbText(s({ type: w }), CAT), 'Weapon');
  assert.equal(Market.crumbText(s({ type: w, rarity: ex }), CAT), 'Weapon · Exotic');
  assert.equal(Market.crumbText(s({ rarity: ex, favOnly: true, query: '  glob ' }), CAT), 'Exotic · Favorites · “glob”');
  assert.equal(Market.crumbText(s({ query: 'iron sword' }), CAT), '“iron sword”');
  assert.equal(Market.crumbText(s({}), CAT), 'Every item', 'a price sort with nothing typed ranks every item');
  assert.equal(Market.crumbText(s({ type: 99, rarity: 99 }), CAT), 'Every item', 'an index the list does not have names nothing');
});

test('the home shows the newest favorites first, at most 8; saved ids the item list no longer has are counted once each, junk is not', () => {
  assert.equal(Market.FAV_HOME, 8);
  assert.deepEqual(Market.favHome([19721, 24295, 19976]), [19976, 24295, 19721], 'favorites are saved oldest first');
  assert.deepEqual(Market.favHome(Array.from({ length: 12 }, (_, i) => i + 1)), [12, 11, 10, 9, 8, 7, 6, 5]);
  assert.deepEqual(Market.favHome([]), []);
  const known = new Map([[19721, 0], [24295, 1]]);
  assert.equal(Market.lostFavorites([19721, 999999999, 999999999, 'x', 1.5, -3, 0, 24295, 123], known), 2, '999999999 once, and 123');
  assert.equal(Market.lostFavorites([19721, 24295], known), 0);
  for (const raw of ['19721', null, undefined, { 0: 1 }]) assert.equal(Market.lostFavorites(raw, known), 0);
});

test('the gem exchange quotes what 100 gold buys and what 400 gems sell for: a fixed amount each way, named on the page', () => {
  assert.deepEqual([Market.GEM_GOLD, Market.GEM_GEMS], [1000000, 400]);
  const mk = readFileSync(join(ROOT, 'js', 'market.js'), 'utf8');
  assert.ok(mk.includes("client.exchange(k, k === 'coins' ? GEM_GOLD : GEM_GEMS, { signal: gemCtl.signal })"), 'coins gives gold and gets gems; gems gives gems and gets gold');
});

test('the amount the calculator works with: what is typed, or the ready amount; a whole number from 1 to 250 in digits, or an error, never a guess', () => {
  const read = (t, chip = 10) => Market.readAmount(t, chip, 250);
  assert.deepEqual(Market.CALC_CHIPS, [1, 5, 10, 50, 100]);
  assert.deepEqual([read(''), read('   '), read(undefined), read(null)], [{ n: 10 }, { n: 10 }, { n: 10 }, { n: 10 }], 'nothing typed: the ready amount');
  assert.deepEqual([read('1'), read('250'), read(' 37 '), read('007')], [{ n: 1 }, { n: 250 }, { n: 37 }, { n: 7 }]);
  assert.deepEqual([read('0'), read('251'), read('1000'), read('999999999')], [{ error: 'range' }, { error: 'range' }, { error: 'range' }, { error: 'range' }]);
  for (const t of ['2.5', '-3', '+3', '1e2', 'ten', '1,000', '5 units', '0x10', '1 0', '9999999999', '٣']) assert.deepEqual(read(t), { error: 'not-whole' }, t);
  assert.deepEqual(Market.readAmount('5', 1, 3), { error: 'range' }, 'the most is whatever one transaction holds');
});

test('the calculator tells what is at once from what is only hoped for, says the book may have changed, and asks for the order book only when asked', () => {
  const mk = readFileSync(join(ROOT, 'js', 'market.js'), 'utf8');
  for (const said of ['Changing the amount asks ArenaNet for nothing.', 'An estimate, never a promise: the book may have changed.', 'Not something the order book fills now: it fills only if sellers come to it, and it may never fill.',
    'Not something the order book fills now: only if it sells.', 'ArenaNet does not publish which applies, and neither is a limit.', 'The calculator uses the order book only.', 'Refresh it before relying on these figures.',
    "receivedText('book', time.format(book.at), t - book.at, f)", 'nothing is worked out for the other', 'another may be missing',
    // v0.5.0 Phase 3: depth near the best price is observed, never promised; the return on cost says what it is made of.
    "h('h4', { text: 'Observed book depth near the best price' })", 'Not a guarantee that this many can be bought or sold', ') divided by the cost (', 'Uncertain: worked out from prices where the order book is not sure']) assert.ok(mk.includes(said), said);
  // One place asks for an order book, and only a press of its button leads there.
  assert.equal(mk.split('client.listings(').length - 1, 1, 'one listings call');
  assert.equal(mk.split('loadBook(').length - 1, 2, 'loadBook: its definition and the button');
  assert.ok(mk.includes("else if (a('data-tp-book')) loadBook(Number(a('data-tp-book')));"));
  // The calculator's choices are never saved and never in the address.
  assert.ok(!/Store\.write\([^)]*calc/.test(mk) && !/pushState\([^)]*calc|replaceState\([^)]*calc/.test(mk));
});

// ---- The price filters (v0.5.0 Phase 2) ----
const MoneyForFilters = require('../js/money.js');
const readF = (raw) => Market.readFilters(raw, MoneyForFilters);

test('the price filters are read as typed: coins, a percentage in tenths, whole units; an unreadable field is said and not applied, the others still are', () => {
  assert.deepEqual(Market.PF_FIELDS.map((f) => f.key), require('../js/catalog.js').FILTER_KEYS, 'the page offers exactly the filters the list knows');
  const all = readF({ buyMin: '1s', buyMax: '2g', sellMin: '1s 50c', sellMax: '3G 5S', marginMin: '40c', pctMin: '12.5%', wantedMin: '1,000', listedMin: '250' });
  assert.deepEqual(all.filters, { buyMin: 100, buyMax: 20000, sellMin: 150, sellMax: 30500, marginMin: 40, pctMin: 125, wantedMin: 1000, listedMin: 250 });
  assert.deepEqual([all.set, all.errors], [8, []]);
  // A bound of 0 is a filter like any other ("has buy orders", "any margin that is not a loss"): never dropped as if nothing were typed.
  assert.deepEqual([readF({ buyMin: '0c', marginMin: '0', pctMin: '0', wantedMin: '0' }).filters, readF({ buyMin: '0c', marginMin: '0', pctMin: '0', wantedMin: '0' }).set], [{ buyMin: 0, marginMin: 0, pctMin: 0, wantedMin: 0 }, 4]);
  assert.equal(all.said, 'Applied: highest buy order from 1s 00c; highest buy order to 2g 00s 00c; lowest sell listing from 1s 50c; lowest sell listing to 3g 05s 00c; potential margin at least 40c; potential margin % at least 12.5%; total queued units wanted, in all buy orders, at least 1,000; total queued units listed, in all sell listings, at least 250.');
  // Nothing typed, or only spaces: no filter.
  for (const raw of [{}, null, undefined, { buyMin: '', sellMax: '   ', pctMin: null }]) assert.deepEqual(readF(raw), { filters: {}, errors: [], set: 0, said: '' });
  // Percentages: whole or one decimal, with or without the sign; never two decimals, a sign, or text.
  assert.deepEqual([readF({ pctMin: '10' }).filters.pctMin, readF({ pctMin: '0' }).filters.pctMin, readF({ pctMin: '7.5' }).filters.pctMin, readF({ pctMin: '150 %' }).filters.pctMin], [100, 0, 75, 1500]);
  for (const t of ['10.25', '-5', '.5', '5.', 'ten', '1e2', '10%%']) assert.deepEqual([readF({ pctMin: t }).filters, readF({ pctMin: t }).errors.length], [{}, 1], t);
  // Units: digits, with thousands separators or without.
  assert.deepEqual([readF({ wantedMin: '0' }).filters.wantedMin, readF({ listedMin: '2,219,204' }).filters.listedMin], [0, 2219204]);
  for (const t of ['1.5', '-1', '1,00', '12k', '1 000']) assert.equal(readF({ wantedMin: t }).errors.length, 1, t);
  // One bad field: said, with what was typed, and not applied; the good one beside it still is.
  const mixed = readF({ buyMin: '2.5g', sellMax: '90s' });
  assert.deepEqual(mixed.filters, { sellMax: 9000 });
  assert.deepEqual(mixed.errors, [{ key: 'buyMin', text: 'Highest buy order from: “2.5g” is not a coin amount. Type one like 2g 50s 10c, 75s or 40c. It is not applied.' }]);
  assert.equal(mixed.set, 1);
  assert.equal(readF({ wantedMin: 'x'.repeat(40) }).errors[0].text, `Total queued units wanted, in all buy orders, at least: “${'x'.repeat(24)}...” is not a whole number of units. It is not applied.`);
  assert.match(readF({ sellMin: '999999999g 99s 99c' }).errors[0].text, /is more than this page can work with\. It is not applied\.$/);
});

test('a range whose from is above its to is refused in words and neither end is applied: never swapped, never half applied', () => {
  const r = readF({ buyMin: '3g', buyMax: '2g', sellMin: '1s', sellMax: '1s' });
  assert.deepEqual(r.filters, { sellMin: 100, sellMax: 100 }, 'from equal to to is a range of one price');
  assert.deepEqual(r.errors, [{ key: 'buyMin', also: 'buyMax', text: 'Highest buy order: from 3g 00s 00c is above to 2g 00s 00c, so nothing could pass. Neither is applied.' }]);
  assert.equal(r.said, 'Applied: lowest sell listing from 1s 00c; lowest sell listing to 1s 00c.');
  assert.equal(readF({ sellMin: '2c', sellMax: '1c' }).errors[0].text, 'Lowest sell listing: from 2c is above to 1c, so nothing could pass. Neither is applied.');
});

test('the price filters say what they cover: three counts; "all" only when every match was checked; the whole item list only with no search and no other filter', () => {
  const base = { matches: 312, passed: 37, failed: 13, unchecked: 262, loading: false, failedLoad: false, listCount: 27983, filtered: true, wholeAll: false };
  const partial = 'Price filters: 37 pass and 13 do not, among only the 50 of 312 matching items whose prices are loaded. The other 262 are not checked: listed after the ones that pass, and not known to pass or to fail.';
  assert.equal(Market.filterText(base), partial);
  assert.equal(Market.filterText({ ...base, loading: true }), partial + ' Loading their prices...');
  assert.equal(Market.filterText({ ...base, failedLoad: true }), partial + ' Their prices could not be loaded.');
  assert.equal(Market.filterText({ ...base, matches: 5000, unchecked: 4950 }), 'Price filters: 37 pass and 13 do not, among only the 50 of 5,000 matching items whose prices are loaded. The other 4,950 are not checked: listed after the ones that pass, and not known to pass or to fail. To check every match, narrow the search to 1,000 items or fewer, or load the whole market.');
  assert.equal(Market.filterText({ ...base, matches: 5000, unchecked: 4950, loading: true }).endsWith(' Loading their prices...'), true, 'while the shown rows load, it says so');
  assert.equal(Market.filterText({ ...base, passed: 1, failed: 1, unchecked: 1, matches: 3 }), 'Price filters: 1 passes and 1 does not, among only the 2 of 3 matching items whose prices are loaded. The other 1 is not checked: listed after the ones that pass, and not known to pass or to fail.');
  // Every match checked.
  assert.equal(Market.filterText({ ...base, failed: 275, unchecked: 0 }), 'Price filters: 37 of all 312 matching items pass; 275 do not. Every match was checked. Not a filter of the whole market.');
  assert.equal(Market.filterText({ ...base, passed: 0, failed: 312, unchecked: 0 }), 'Price filters: 0 of all 312 matching items pass; 312 do not. Every match was checked. Not a filter of the whole market.');
  // The whole item list: only with nothing typed, no other filter, and every item checked.
  const whole = { ...base, matches: 27983, passed: 1204, failed: 26779, unchecked: 0, filtered: false };
  assert.equal(Market.filterText(whole), 'Price filters: 1,204 of all 27,983 items in the item list pass; 26,779 do not.');
  assert.equal(Market.filterText({ ...whole, wholeAll: true }), 'Price filters: 1,204 of all 27,983 items in the item list pass, from the whole-market load; 26,779 do not.');
  assert.match(Market.filterText({ ...whole, filtered: true }), /Not a filter of the whole market\.$/, 'with a type chosen, 27,983 matches would still not be the whole market');
  assert.match(Market.filterText({ ...whole, failed: 26778, unchecked: 1 }), /among only the 27,982 of 27,983 matching items/, 'one item unchecked: not "all"');
  assert.match(Market.filterText({ ...base, failed: 275, unchecked: 0, filtered: false }), /^Price filters: 37 of all 312 matching items pass; .* Not a filter of the whole market\.$/, 'fewer matches than the list holds is never the whole list, whatever else is set');
  // Exactly 1,000 matches is within what is loaded in full: the reason given is the failure, not the size.
  assert.match(Market.filterText({ ...base, matches: 1000, unchecked: 950, failedLoad: true }), /not known to pass or to fail\. Their prices could not be loaded\.$/);
  assert.match(Market.filterText({ ...base, matches: 1001, unchecked: 951, failedLoad: true }), /or load the whole market\.$/);
  assert.equal(Market.filterText({ ...base, matches: 0, passed: 0, failed: 0, unchecked: 0 }), '');
});

test('a price sort under price filters ranks the items that pass, and says "so far" while some matches are not checked', () => {
  const s = { sort: 'margin-desc', matches: 37, ranked: 37, noSide: 0, unpriced: 0, loading: false, failed: false, wholeAll: true, listCount: 27983, filtered: false };
  assert.equal(Market.scopeText({ ...s, pf: { unchecked: 0 } }), 'Ranked by potential margin after fees, largest first, among the 37 items that pass the price filters. Not a ranking of the whole market.');
  assert.equal(Market.scopeText({ ...s, pf: { unchecked: 262 } }), 'Ranked by potential margin after fees, largest first, among the 37 items that pass the price filters so far. Not a ranking of the whole market.');
  assert.equal(Market.scopeText({ ...s, matches: 1, ranked: 0, noSide: 1, sort: 'buy-asc', pf: { unchecked: 0 } }), 'Ranked by highest buy order, low to high, among the 1 item that passes the price filters. Not a ranking of the whole market. 1 item with no buy orders come after the ranked ones.');
  assert.equal(Market.scopeText({ ...s, sort: 'name', pf: { unchecked: 3 } }), 'Sorted by name.');
  // Without price filters the line is the one it has always been.
  assert.equal(Market.scopeText({ ...s, matches: 27983, ranked: 27983 }), 'Ranked by potential margin after fees, largest first, across the whole market: all 27,983 items in the item list, from the whole-market load.');
});

test('prices that are no longer current are said, by the oldest one used', () => {
  const T = Date.parse('2026-11-18T12:00:00Z');
  assert.equal(Market.ageNote(T - 4 * 60000, T), '');
  assert.equal(Market.ageNote(T - 12 * 60000, T), ' The oldest price used was received 12 minutes ago: stale, and may have changed.');
  assert.equal(Market.ageNote(T - 90 * 60000, T), ' The oldest price used was received 90 minutes ago: old, and may have changed.');
  assert.deepEqual([Market.ageNote(NaN, T), Market.ageNote(Infinity, T), Market.ageNote(undefined, T)], ['', '', ''], 'no price used, nothing said');
});

test('freshness in item details: when this page received the answer, and that when ArenaNet last updated it is not known, with its reuse window', () => {
  // The windows are ArenaNet's own Cache-Control max-age (120 s for prices, 1,200 s for an order book, read on the real API).
  assert.deepEqual(Market.REUSE_MIN, { prices: 2, book: 20 });
  assert.equal(Market.receivedText('prices', '7:00 AM', 0, 'current'), 'Prices received at 7:00 AM, just now (current). That is when this page got them; when ArenaNet last updated them is not known: the answer carries no time, and ArenaNet lets an answer be reused for up to 2 minutes, so they may date from before 7:00 AM.');
  assert.equal(Market.receivedText('book', '7:00 AM', 6 * 60000, 'stale'), 'Order book received at 7:00 AM, 6 minutes ago (stale). That is when this page got it; when ArenaNet last updated it is not known: the answer carries no time, and ArenaNet lets an answer be reused for up to 20 minutes, so it may date from before 7:00 AM and be older than the prices above.');
  assert.match(Market.receivedText('book', '9:15 PM', 61 * 60000, 'old'), /^Order book received at 9:15 PM, 61 minutes ago \(old\)\./);
  // The age words and the three states are the same ones every other line uses.
  const T = Date.parse('2026-11-18T12:00:00Z');
  assert.deepEqual([Market.freshness(T - 4 * 60000 - 59999, T), Market.freshness(T - 5 * 60000, T), Market.freshness(T - 60 * 60000 + 1, T), Market.freshness(T - 60 * 60000, T)], ['current', 'stale', 'stale', 'old']);
});

test('one freshness vocabulary across the page: "received", never "fetched" or "Prices from" a time; ArenaNet\'s own time and an API delay never claimed; no request past the browser\'s cache', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8'), mk = readFileSync(join(ROOT, 'js', 'market.js'), 'utf8'), api = readFileSync(join(ROOT, 'js', 'api.js'), 'utf8');
  // What the page writes (strings in the code and the page's text), not the comments that explain them.
  const code = mk.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  const tp = html.slice(html.indexOf('<section class="view market-view'), html.indexOf('</main>'));
  const about = html.slice(html.indexOf('<h3>Trading Post</h3>'), html.indexOf('<h3>Privacy</h3>'));
  for (const [what, text] of [['market.js', code], ['the Trading Post section', tp], ['About', about]]) {
    assert.ok(!/\bfetched (at )?\$\{|\bPrices from \$\{|\bRates from \$\{|\basked for at\b|was asked for \$\{/.test(text), `${what}: a time is "received", never "fetched", "from" or "asked for"`);
    assert.ok(!/minutes behind|can be a few minutes behind|may itself be/.test(text), `${what}: no delay of ArenaNet's API is claimed`);
  }
  for (const said of ['Prices received ${when}', 'Rates received ${when}', 'price, received ${ago(', 'The oldest price used was received', 'This order book was received', 'received at ${when}', "when ArenaNet last updated ${it} is not known"]) assert.ok(mk.includes(said), said);
  assert.ok(tp.includes('with the time this page received them (when ArenaNet last updated them is not known: its answers carry no time)'), 'the Trading Post says it at the top');
  assert.ok(about.includes('says when this page received it, and when ArenaNet last updated it is not known'), 'and in About');
  // The gem exchange sends no reuse window, so none is claimed for it.
  assert.ok(!/REUSE_MIN\.(gems|coins|rates)|REUSE_MIN\[['"](gems|coins|rates)/.test(mk));
  // Decision D5: every request goes through the browser's ordinary cache. No cache mode, no request header, no cache-busting parameter.
  assert.ok(!/cache\s*:|no-store|no-cache|'reload'|"reload"|force-cache|Cache-Control|Pragma|_=\$\{|[?&]t=\$\{|Date\.now\(\)\s*\}`/.test(api + code), 'nothing bypasses the cache');
  assert.match(api, /o\.fetch\(job\.url, \{ method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl \? ctl\.signal : undefined \}\)/, 'the one fetch, as it was');
});

test('the line beside "Trading Post home" names the price filters too', () => {
  const cat = { types: ['Weapon'], rarities: ['Rare'] };
  assert.equal(Market.crumbText({ type: -1, rarity: -1, favOnly: false, query: '', pfCount: 2 }, cat), 'Every item · 2 price filters');
  assert.equal(Market.crumbText({ type: 0, rarity: -1, favOnly: false, query: 'sword', pfCount: 1 }, cat), 'Weapon · “sword” · 1 price filter');
  assert.equal(Market.crumbText({ type: 0, rarity: -1, favOnly: false, query: '', pfCount: 0 }, cat), 'Weapon');
});

test('the page has one field for each price filter, the quantity filters are named as totals, and nothing about them is saved or put in the address', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8'), mk = readFileSync(join(ROOT, 'js', 'market.js'), 'utf8');
  const fields = [...html.matchAll(/<input type="text" id="tp-pf-(\w+)" data-tp-pf="(\w+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(fields, Market.PF_FIELDS.map((f) => [f.key, f.key]));
  for (const said of ['<legend>Total queued units</legend>', 'wanted in all buy orders, at least', 'listed in all sell listings, at least',
    'They are not what can be bought or sold near the best price', 'an item with no price loaded is not checked, and is listed after the ones that pass, never among them']) assert.ok(html.includes(said), said);
  for (const f of Market.PF_FIELDS.filter((x) => x.kind === 'count')) assert.match(f.what, /^total queued units (wanted|listed), in all (buy orders|sell listings), at least$/);
  assert.ok(!/depth|liquid/i.test(html.slice(html.indexOf('id="tp-pf-panel"'), html.indexOf('id="tp-fav-unsaved"'))), 'never called depth or liquidity');
  // Read from memory only: the filters reach no storage and no history call.
  assert.ok(!/Store\.write\([^)]*pf/i.test(mk) && !/(push|replace)State\([^)]*pf/i.test(mk));
  // One call asks for every match's price, and only up to the cap: never a scan the reader did not start.
  assert.ok(mk.includes('if (priceWork() && matches.length <= SORT_CAP) {'));
  assert.equal(mk.split('client.prices(').length - 1, 2, 'prices are asked for in loadPrices and in the whole-market load, nowhere else');
  for (const said of ['Not checked against the price filters:', 'Nothing is hidden for want of a price.']) assert.ok(mk.includes(said), said);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
