// Tests for js/catalog.js (the Trading Post item list and its search) and tools/build-items.mjs (which makes the
// list). Run alone with `node tests/catalog.mjs`, or through tests/run.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Catalog = require('../js/catalog.js');
const Money = require('../js/money.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { buildIndex, checkIndex, cleanName, RARITY_ORDER } = await import('../tools/build-items.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

// A small list, made by the tool itself from item records shaped like /v2/items answers.
const RECORDS = [
  [19721, 'Glob of Ectoplasm', 'CraftingMaterial', 'Exotic', 0], [19976, 'Mystic Coin', 'CraftingMaterial', 'Rare', 0],
  [24295, 'Vial of Powerful Blood', 'CraftingMaterial', 'Rare', 0], [46731, 'Pile of Bloodstone Dust', 'CraftingMaterial', 'Exotic', 0],
  [30684, 'Frostfang', 'Weapon', 'Legendary', 80], [12345, 'Sword of the Ecto Lord', 'Weapon', 'Exotic', 80],
  [12346, "Zojja's Café Sword", 'Weapon', 'Ascended', 80], [100, 'Glob', 'Trophy', 'Basic', 0], [101, 'Ecto', 'Trophy', 'Fine', 5],
  [102, 'Ectoplasmic Glob Remnant', 'Trophy', 'Masterwork', 0], [77, 'Not Traded', 'Trophy', 'Basic', 0],
].map(([id, name, type, rarity, level]) => ({ id, name, type, rarity, level, description: '', flags: [] }));
const PRICED = RECORDS.filter((r) => r.id !== 77).map((r) => r.id).concat([999999]);
const BUILT = buildIndex({ items: RECORDS, priceIds: PRICED, asOf: '2026-11-15T12:36:57Z', build: 210361 });
const CAT = Catalog.parse(BUILT.text).catalog;
const names = (r) => r.indexes.map((i) => CAT.names[i]);

test('the module needs nothing from a page and sets one global', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'catalog.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['GW2Catalog']);
});

test('the tool keeps only priced items with a record, in id order, and counts what it left out', () => {
  assert.equal(CAT.count, 10);
  assert.deepEqual(CAT.ids, [100, 101, 102, 12345, 12346, 19721, 19976, 24295, 30684, 46731]);
  assert.deepEqual(BUILT.skipped, { noRecord: 1, emptyName: 0 });
  assert.deepEqual(CAT.rarities, ['Basic', 'Fine', 'Masterwork', 'Rare', 'Exotic', 'Ascended', 'Legendary'], 'the game order, only those used');
  assert.deepEqual(CAT.types, ['CraftingMaterial', 'Trophy', 'Weapon']);
  assert.equal(BUILT.lock.count, 10);
  assert.equal(BUILT.lock.noItemRecord, 1);
  assert.match(BUILT.lock.sha256, /^[0-9a-f]{64}$/);
});

test('the tool is deterministic: the same answers in any order give the same bytes', () => {
  const again = buildIndex({ items: RECORDS.slice().reverse(), priceIds: PRICED.slice().reverse(), asOf: '2026-11-15T12:36:57Z', build: 210361 });
  assert.equal(again.text, BUILT.text);
  assert.deepEqual(again.lock, BUILT.lock);
});

test('names are cleaned to one line, and dashes become hyphens, as the news headlines do', () => {
  const EM = String.fromCharCode(0x2014), EN = String.fromCharCode(0x2013);
  assert.equal(cleanName(`Light of Deldrimor Plate${EM}Bottom Half`), 'Light of Deldrimor Plate - Bottom Half');
  assert.equal(cleanName(`Tier 3${EN}5`), 'Tier 3-5');
  assert.equal(cleanName(' A\tB\nC  D '), 'A B C D');
  const r = buildIndex({ items: [{ id: 5, name: `X${EM}Y`, type: 'Trophy', rarity: 'Fine' }, { id: 6, name: ' \t ', type: 'Trophy', rarity: 'Fine' }], priceIds: [5, 6], asOf: '2026-11-15T12:36:57Z', build: 1 });
  assert.ok(!r.text.includes(EM));
  assert.deepEqual(r.skipped, { noRecord: 0, emptyName: 1 });
});

test('the tool refuses bad input: no time, no build, or a record that is not an item', () => {
  assert.throws(() => buildIndex({ items: RECORDS, priceIds: PRICED, asOf: '2026-11-15', build: 1 }), /asOf/);
  assert.throws(() => buildIndex({ items: RECORDS, priceIds: PRICED, asOf: '2026-11-15T12:36:57Z', build: 0 }), /build/);
  assert.throws(() => buildIndex({ items: [{ id: 1 }], priceIds: [1], asOf: '2026-11-15T12:36:57Z', build: 1 }), /not an item record/);
  assert.deepEqual(RARITY_ORDER, ['Junk', 'Basic', 'Fine', 'Masterwork', 'Rare', 'Exotic', 'Ascended', 'Legendary']);
});

test('parse refuses a damaged list as a whole: format, count, ids, codes, levels, names', () => {
  const d = JSON.parse(BUILT.text);
  const bad = (change, why) => { const x = JSON.parse(JSON.stringify(d)); change(x); const r = Catalog.parse(JSON.stringify(x)); assert.equal(r.ok, false, why); return r.error; };
  assert.equal(Catalog.parse('not json').ok, false);
  assert.equal(Catalog.parse('null').ok, false);
  bad((x) => { x.format = 2; }, 'format');
  bad((x) => { x.count = 11; }, 'count too high');
  bad((x) => { x.rows = x.rows.split('\n').slice(0, -1).join('\n'); }, 'a row cut off');
  bad((x) => { x.rows = x.rows.replace(/^\d+/, '0'); }, 'an id that does not increase');
  bad((x) => { x.rows = x.rows.replace(/^\d+/, '-3'); }, 'a negative step');
  bad((x) => { x.rows = x.rows.replace(/\t\d+\t(\d+)\t/, '\t99\t$1\t'); }, 'a type code out of range');
  bad((x) => { x.rows = x.rows.replace(/\t(\d+)$/m, '\t81'); }, 'a level over 80');
  bad((x) => { x.rows = x.rows.replace(/\tGlob\t/, '\t\t'); }, 'an empty name');
  bad((x) => { x.rows = x.rows.replace(/\tGlob\t/, '\t Glob\t'); }, 'an untrimmed name');
  bad((x) => { x.asOf = 'yesterday'; }, 'asOf');
  bad((x) => { x.types = []; }, 'types');
  bad((x) => { x.rows += '\textra'; }, 'a sixth field');
  assert.equal(Catalog.parse(d).ok, true, 'an object parses as well as its text');
});

test('the committed list agrees with its lock and with the tool, and the page can read it', () => {
  const c = checkIndex();
  assert.deepEqual(c.errors, []);
  assert.ok(c.catalog.count > 27000, `${c.catalog.count} items`);
  assert.equal(new Set(c.catalog.ids).size, c.catalog.count, 'ids once each');
  assert.ok(c.catalog.ids.every((id, i) => i === 0 || id > c.catalog.ids[i - 1]), 'id order');
  const raw = readFileSync(join(ROOT, 'data', 'tp-items.json'), 'utf8');
  assert.ok(!raw.includes(String.fromCharCode(0x2014)) && !raw.includes(String.fromCharCode(0x2013)), 'no dash characters');
  assert.equal(c.lock.pricedIds - c.lock.noItemRecord - c.lock.emptyName, c.lock.count);
});

test('a changed byte in the list, or a stale lock, is caught by --check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw2-items-'));
  try {
    const list = join(dir, 'tp-items.json'), lock = join(dir, 'tp-items.lock.json');
    writeFileSync(list, BUILT.text); writeFileSync(lock, JSON.stringify(BUILT.lock));
    assert.deepEqual(checkIndex({ list, lock }).errors, []);
    writeFileSync(list, BUILT.text.replace('Mystic Coin', 'Mystic Coim'));
    assert.match(checkIndex({ list, lock }).errors.join(), /sha256/);
    writeFileSync(list, BUILT.text); writeFileSync(lock, JSON.stringify({ ...BUILT.lock, count: 9 }));
    assert.match(checkIndex({ list, lock }).errors.join(), /lock says 9/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('search: every word must appear; order and case do not matter; accents and apostrophes are ignored', () => {
  assert.deepEqual(names(Catalog.search(CAT, { query: 'glob of ecto' })), ['Glob of Ectoplasm']);
  assert.deepEqual(names(Catalog.search(CAT, { query: 'ECTO GLOB' })).sort(), ['Ectoplasmic Glob Remnant', 'Glob of Ectoplasm']);
  assert.deepEqual(names(Catalog.search(CAT, { query: 'zojjas cafe' })), ["Zojja's Café Sword"]);
  assert.deepEqual(names(Catalog.search(CAT, { query: "Zojja's CAFÉ" })), ["Zojja's Café Sword"]);
  assert.deepEqual(names(Catalog.search(CAT, { query: 'nothing like it' })), []);
});

test('search ranks the whole name, then names that start with the query, then word starts, then the rest, each by name', () => {
  assert.deepEqual(names(Catalog.search(CAT, { query: 'ecto' })), ['Ecto', 'Ectoplasmic Glob Remnant', 'Glob of Ectoplasm', 'Sword of the Ecto Lord']);
  assert.deepEqual(names(Catalog.search(CAT, { query: 'glob' })), ['Glob', 'Glob of Ectoplasm', 'Ectoplasmic Glob Remnant']);
  assert.deepEqual(names(Catalog.search(CAT, { query: 'lood' })), ['Pile of Bloodstone Dust', 'Vial of Powerful Blood'], 'substring only: by name');
  assert.deepEqual(names(Catalog.search(CAT, { query: 'ecto', sort: 'name' })), ['Ecto', 'Ectoplasmic Glob Remnant', 'Glob of Ectoplasm', 'Sword of the Ecto Lord']);
});

test('the word-start rank needs every typed word to start a word: one that is only inside a word ranks lower, even when its name comes first', () => {
  const own = Catalog.parse(buildIndex({ items: [
    { id: 1, name: 'Brem Ecto Charm', type: 'Trophy', rarity: 'Fine' },     // "ecto" starts a word, "rem" only inside "Brem"
    { id: 2, name: 'Ectoplasmic Glob Remnant', type: 'Trophy', rarity: 'Fine' }, // both start a word
  ], priceIds: [1, 2], asOf: '2026-11-15T12:36:57Z', build: 1 }).text).catalog;
  assert.deepEqual(Catalog.search(own, { query: 'ecto rem' }).indexes.map((i) => own.names[i]), ['Ectoplasmic Glob Remnant', 'Brem Ecto Charm']);
});
test('an id finds its item first; one letter alone asks for more; nothing typed and no filter is idle', () => {
  assert.equal(names(Catalog.search(CAT, { query: '19721' }))[0], 'Glob of Ectoplasm');
  assert.equal(Catalog.search(CAT, { query: 'e' }).status, 'short');
  assert.equal(Catalog.search(CAT, { query: '' }).status, 'idle');
  assert.equal(Catalog.search(CAT, { query: '  ,; ' }).status, 'idle');
  assert.equal(Catalog.search(CAT, { query: 'e', type: 2 }).status, 'ok', 'one letter with a filter');
});

test('filters: type, rarity and a set of ids (favorites), alone or with a query, listed by name', () => {
  const W = CAT.types.indexOf('Weapon'), EX = CAT.rarities.indexOf('Exotic');
  assert.deepEqual(names(Catalog.search(CAT, { type: W })), ['Frostfang', 'Sword of the Ecto Lord', "Zojja's Café Sword"]);
  assert.deepEqual(names(Catalog.search(CAT, { rarity: EX })), ['Glob of Ectoplasm', 'Pile of Bloodstone Dust', 'Sword of the Ecto Lord']);
  assert.deepEqual(names(Catalog.search(CAT, { type: W, rarity: EX, query: 'sword' })), ['Sword of the Ecto Lord']);
  assert.deepEqual(names(Catalog.search(CAT, { only: new Set([19976, 30684, 424242]) })), ['Frostfang', 'Mystic Coin']);
  assert.deepEqual(names(Catalog.search(CAT, { only: new Set() })), [], 'no favorites, nothing');
  assert.equal(Catalog.search(CAT, { query: 'x'.repeat(200) }).query.length, 60, 'the query is cut at 60');
});

test('a price sort ranks by the value, high to low or low to high, ties by name; a missing side and an unloaded price come after, by name', () => {
  const P = {
    19721: { buys: { quantity: 9, unit_price: 1710 }, sells: { quantity: 9, unit_price: 1910 } },
    19976: { buys: { quantity: 9, unit_price: 21000 }, sells: { quantity: 0, unit_price: 0 } },
    24295: { buys: { quantity: 0, unit_price: 0 }, sells: { quantity: 4, unit_price: 1910 } },
    46731: { buys: { quantity: 9, unit_price: 50 }, sells: { quantity: 9, unit_price: 80 } },
    100: { buys: { quantity: 9, unit_price: 1 }, sells: { quantity: 9, unit_price: 3 } },
  };
  const q = (id) => (P[id] ? Money.quote(P[id]) : undefined);
  const all = Catalog.search(CAT, { only: new Set(CAT.ids) }).indexes;
  const s = (key, dir) => { const r = Catalog.priceSort(CAT, all, key, dir, q); return [r.order.map((i) => CAT.names[i]), r.ranked, r.noSide, r.unpriced]; };
  const unpriced = ['Ecto', 'Ectoplasmic Glob Remnant', 'Frostfang', 'Sword of the Ecto Lord', "Zojja's Café Sword"];
  assert.deepEqual(s('sell', 'desc'), [['Glob of Ectoplasm', 'Vial of Powerful Blood', 'Pile of Bloodstone Dust', 'Glob', 'Mystic Coin', ...unpriced], 4, 1, 5], 'a tie at 1910 by name');
  assert.deepEqual(s('sell', 'asc')[0].slice(0, 5), ['Glob', 'Pile of Bloodstone Dust', 'Glob of Ectoplasm', 'Vial of Powerful Blood', 'Mystic Coin'], 'no sell listings is last, not first');
  assert.deepEqual(s('buy', 'asc')[0].slice(0, 5), ['Glob', 'Pile of Bloodstone Dust', 'Glob of Ectoplasm', 'Mystic Coin', 'Vial of Powerful Blood'], 'no buy orders is last, not a price of 0');
  assert.deepEqual(s('spread', 'desc')[0].slice(0, 3), ['Glob of Ectoplasm', 'Pile of Bloodstone Dust', 'Glob']);
  assert.deepEqual(s('spread', 'desc').slice(1), [3, 2, 5]);
  assert.deepEqual(s('margin', 'desc')[0].slice(0, 3), ['Pile of Bloodstone Dust', 'Glob', 'Glob of Ectoplasm'], 'margins: 80-4-8-50=18, 3-1-1-1=0, 1623-1710=-87');
  assert.throws(() => Catalog.priceSort(CAT, all, 'volume', 'desc', q), /unknown sort/);
  // The margin as a share of the buy price ranks differently from the margin in copper: 1,000g buy, 1,300g sell
  // leaves 130000 - 6500 - 13000 - 100000 = 10500 (10.5%); 50c buy, 80c sell leaves 18 (36%); 1c buy, 3c sell 0 (0%).
  // An item with no buy orders has no denominator: after the ranked ones, never as 0%.
  const P2 = Object.assign({}, P, { 19721: { buys: { quantity: 9, unit_price: 100000 }, sells: { quantity: 9, unit_price: 130000 } } });
  delete P2[19976];
  const q2 = (id) => (P2[id] ? Money.quote(P2[id]) : undefined);
  const s2 = (key) => { const r = Catalog.priceSort(CAT, all, key, 'desc', q2); return [r.order.slice(0, 4).map((i) => CAT.names[i]), r.ranked, r.noSide, r.unpriced]; };
  assert.deepEqual(s2('margin'), [['Glob of Ectoplasm', 'Pile of Bloodstone Dust', 'Glob', 'Vial of Powerful Blood'], 3, 1, 6]);
  assert.deepEqual(s2('marginPct'), [['Pile of Bloodstone Dust', 'Glob of Ectoplasm', 'Glob', 'Vial of Powerful Blood'], 3, 1, 6], '36% before 10.5% before 0%');
  assert.deepEqual(s('marginPct', 'desc').slice(1), [3, 2, 5], 'no buy orders, and no sell listings, both come after the ranked ones');
  // The same answer whatever order the matches come in (ties by name, not by arrival).
  for (const [key, dir] of [['sell', 'desc'], ['buy', 'asc'], ['spread', 'desc'], ['margin', 'desc'], ['marginPct', 'desc']]) {
    assert.deepEqual(Catalog.priceSort(CAT, all.slice().reverse(), key, dir, q).order, Catalog.priceSort(CAT, all, key, dir, q).order, `${key} ${dir}`);
  }
});

test('item descriptions lose the game\'s markup and control characters, and keep line breaks', () => {
  assert.equal(Catalog.plainText('<c=@flavor>A fine glob.</c><br>Used in crafting.'), 'A fine glob.\nUsed in crafting.');
  assert.equal(Catalog.plainText('<script>alert(1)</script>x\u0007'), 'alert(1)x');
  assert.equal(Catalog.plainText(null), '');
});

test('on the real list, searches take well under 50 ms here, and the ranking holds for real names', () => {
  const real = checkIndex().catalog;
  for (const q of ['ec', 'ecto', 'glob of ecto', 'sword', 'mystic coin', '19721']) {
    const t = process.hrtime.bigint();
    const r = Catalog.search(real, { query: q });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    assert.ok(ms < 50, `${q}: ${ms} ms`);
    assert.equal(r.status, 'ok');
  }
  assert.equal(real.names[Catalog.search(real, { query: 'glob of ecto' }).indexes[0]], 'Glob of Ectoplasm');
  assert.equal(real.names[Catalog.search(real, { query: 'mystic coin' }).indexes[0]], 'Mystic Coin');
  assert.equal(Catalog.search(real, { query: 'deldrimor plate bottom' }).indexes.length > 0, true, 'a name that had a dash');
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
