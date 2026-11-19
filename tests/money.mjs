// Tests for js/money.js: fees, proceeds, margins and how money is written. Run alone with `node tests/money.mjs`,
// or through tests/run.mjs. The expected numbers are worked out by hand here, not with the module.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Money = require('../js/money.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MINUS = String.fromCharCode(0x2212);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

test('the module needs nothing from a page and sets one global', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'money.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['GW2Money']);
});

test('the fees are the documented 5% listing fee and 10% exchange fee', () => {
  assert.equal(Money.LISTING_PCT, 5);
  assert.equal(Money.EXCHANGE_PCT, 10);
  assert.equal(Money.listingFee(10000), 500);
  assert.equal(Money.exchangeFee(10000), 1000);
});

test('each fee is at least 1 copper, also on a price of 1 to 9 copper', () => {
  for (const p of [1, 2, 5, 9]) { assert.equal(Money.listingFee(p), 1, `listing ${p}`); assert.equal(Money.exchangeFee(p), 1, `exchange ${p}`); }
  assert.equal(Money.listingFee(0), 1, 'a total of 0 still has the minimum');
});

test('a fraction of a copper rounds to the nearest copper, half up, at every boundary', () => {
  // listing 5%: 29c -> 1.45 -> 1; 30c -> 1.5 -> 2; 49c -> 2.45 -> 2; 50c -> 2.5 -> 3
  assert.deepEqual([29, 30, 49, 50, 69, 70].map(Money.listingFee), [1, 2, 2, 3, 3, 4]);
  // exchange 10%: 14c -> 1.4 -> 1; 15c -> 1.5 -> 2; 24c -> 2; 25c -> 3
  assert.deepEqual([14, 15, 24, 25, 104, 105].map(Money.exchangeFee), [1, 2, 2, 3, 10, 11]);
  // Large totals stay exact (integer arithmetic): 10,000 gold, and 250 units of it.
  assert.equal(Money.listingFee(100000000), 5000000);
  assert.equal(Money.exchangeFee(100000000 * 250), 2500000000);
  assert.equal(Money.listingFee(1234567), 61728); // 61728.35
  assert.equal(Money.exchangeFee(1234565), 123457); // 123456.5 rounds up
});

test('proceeds take both fees from the total of the transaction, not per unit', () => {
  assert.deepEqual(Money.proceeds(1710), { total: 1710, listing: 86, exchange: 171, net: 1453 });
  assert.deepEqual(Money.proceeds(1910), { total: 1910, listing: 96, exchange: 191, net: 1623 });
  // 250 units at 3c: per unit the minimums would take 2c of every 3c; on the total they take 15%.
  assert.deepEqual(Money.proceeds(3, 250), { total: 750, listing: 38, exchange: 75, net: 637 });
  assert.deepEqual(Money.proceeds(1), { total: 1, listing: 1, exchange: 1, net: -1 }, 'a 1c sale loses a copper');
});

test('proceeds refuse what is not a sale: zero, negative, fractional or too many units', () => {
  for (const [p, n] of [[0, 1], [-5, 1], [1.5, 1], [10, 0], [10, 251], [10, 2.5], [NaN, 1], ['10', 1]]) assert.equal(Money.proceeds(p, n), null, `${p} x ${n}`);
  assert.equal(Money.listingFee(-1), null);
  assert.equal(Money.exchangeFee(1.2), null);
});

test('a quote: both sides, spread, sell now, list at lowest and the potential margin', () => {
  const q = Money.quote({ id: 19721, buys: { quantity: 391900, unit_price: 1710 }, sells: { quantity: 2219204, unit_price: 1910 } });
  assert.deepEqual([q.buy, q.sell, q.buyQty, q.sellQty, q.spread], [1710, 1910, 391900, 2219204, 200]);
  assert.equal(q.sellNow.net, 1453);
  assert.equal(q.listAtLowest.net, 1623);
  assert.equal(q.margin, -87, '1623 - 1710');
  assert.ok(Math.abs(q.marginPct - -87 / 1710) < 1e-12);
  const up = Money.quote({ buys: { quantity: 5, unit_price: 100 }, sells: { quantity: 5, unit_price: 200 } });
  assert.deepEqual([up.spread, up.listAtLowest.net, up.margin], [100, 200 - 10 - 20, 70]);
});

test('an empty side ({ quantity: 0, unit_price: 0 }) is missing, never a price of 0, and nothing is worked out from it', () => {
  const nb = Money.quote({ buys: { quantity: 0, unit_price: 0 }, sells: { quantity: 7, unit_price: 500 } });
  assert.deepEqual([nb.buy, nb.buyQty, nb.spread, nb.sellNow, nb.margin, nb.marginPct], [null, 0, null, null, null, null]);
  assert.equal(nb.listAtLowest.net, 500 - 25 - 50);
  const ns = Money.quote({ buys: { quantity: 3, unit_price: 40 }, sells: { quantity: 0, unit_price: 0 } });
  assert.deepEqual([ns.sell, ns.spread, ns.listAtLowest, ns.margin], [null, null, null, null]);
  // A price with quantity 0, or a quantity with price 0, is still no side.
  assert.equal(Money.quote({ buys: { quantity: 0, unit_price: 50 }, sells: { quantity: 1, unit_price: 0 } }).buy, null);
  assert.equal(Money.quote({ buys: { quantity: 0, unit_price: 50 }, sells: { quantity: 1, unit_price: 0 } }).sell, null);
  assert.equal(Money.quote(null).buy, null);
  assert.equal(Money.quote({}).sell, null);
});

test('fees and proceeds agree at every price from 1c to 30 gold: minimum fees, rounding within half a copper, selling higher never gives less', () => {
  let prev = null;
  for (let p = 1; p <= 300000; p++) {
    const r = Money.proceeds(p);
    assert.equal(r.net, p - r.listing - r.exchange, `net at ${p}`);
    assert.ok(r.listing >= 1 && r.exchange >= 1, `minimum fees at ${p}`);
    // Each fee is its share rounded to the nearest copper, unless the 1c minimum lifts it.
    if (r.listing > 1) assert.ok(Math.abs(r.listing - p * 0.05) <= 0.5, `listing at ${p}`);
    if (r.exchange > 1) assert.ok(Math.abs(r.exchange - p * 0.1) <= 0.5, `exchange at ${p}`);
    assert.ok(r.net < p, `fees always take something at ${p}`);
    if (prev) assert.ok(r.net >= prev.net, `selling at ${p} gives no less than at ${p - 1}`);
    prev = r;
  }
  // The smallest prices, worked by hand: the two 1c minimums take all of 1c and 2c.
  assert.deepEqual([1, 2, 3, 9, 10, 14, 15, 20].map((p) => [p, Money.proceeds(p).listing, Money.proceeds(p).exchange, Money.proceeds(p).net]),
    [[1, 1, 1, -1], [2, 1, 1, 0], [3, 1, 1, 1], [9, 1, 1, 7], [10, 1, 1, 8], [14, 1, 1, 12], [15, 1, 2, 12], [20, 1, 2, 17]]);
});

test('a quote is consistent: sell now and list are what the fees leave of each side, the margin is list minus buy and never more than the spread, a loss below about 85%', () => {
  const sides = [1, 2, 3, 9, 10, 15, 99, 100, 101, 1710, 1910, 9999, 10000, 123457, 50000000];
  for (const buy of sides) for (const sell of sides) {
    const q = Money.quote({ buys: { quantity: 1, unit_price: buy }, sells: { quantity: 1, unit_price: sell } });
    assert.deepEqual([q.sellNow, q.listAtLowest], [Money.proceeds(buy), Money.proceeds(sell)], `${buy}/${sell}`);
    assert.equal(q.spread, sell - buy);
    assert.equal(q.margin, Money.proceeds(sell).net - buy);
    assert.ok(q.margin < q.spread, `fees make the margin less than the spread at ${buy}/${sell}`);
    assert.equal(q.margin < 0, Money.proceeds(sell).net < buy, 'a loss exactly when what listing leaves is under the buy price');
    assert.equal(Math.sign(q.marginPct), Math.sign(q.margin));
  }
  // A crossed book (a buy order above the lowest listing, as the API can show for a moment): a negative spread and a loss.
  const x = Money.quote({ buys: { quantity: 1, unit_price: 120 }, sells: { quantity: 1, unit_price: 100 } });
  assert.deepEqual([x.spread, x.margin], [-20, 100 - 5 - 10 - 120]);
});

test('coins: gold, silver and copper, with two digits after a larger unit, and the words a screen reader says', () => {
  const c = (n) => [Money.coins(n).text, Money.coins(n).spoken];
  assert.deepEqual(c(0), ['0c', '0 copper']);
  assert.deepEqual(c(7), ['7c', '7 copper']);
  assert.deepEqual(c(1710), ['17s 10c', '17 silver 10 copper']);
  assert.deepEqual(c(200), ['2s 00c', '2 silver']);
  assert.deepEqual(c(10000), ['1g 00s 00c', '1 gold']);
  assert.deepEqual(c(10305), ['1g 03s 05c', '1 gold 3 silver 5 copper']);
  assert.deepEqual(c(14502020), ['1,450g 20s 20c', '1,450 gold 20 silver 20 copper']);
  assert.deepEqual(c(100000000), ['10,000g 00s 00c', '10,000 gold']);
});

test('a loss has a real minus sign and is spoken as a loss', () => {
  assert.deepEqual([Money.coins(-87).text, Money.coins(-87).spoken], [`${MINUS}87c`, 'a loss of 87 copper']);
  assert.deepEqual([Money.coins(-220202).text, Money.coins(-220202).neg], [`${MINUS}22g 02s 02c`, true]);
  assert.equal(Money.coins(1.5), null);
});

test('counts and percents', () => {
  assert.deepEqual([Money.count(0), Money.count(999), Money.count(1000), Money.count(2219204), Money.count(-1500)], ['0', '999', '1,000', '2,219,204', '-1,500']);
  assert.deepEqual([Money.percent(0.125), Money.percent(-0.0509), Money.percent(0), Money.percent(-0.0001), Money.percent(NaN)], ['12.5%', `${MINUS}5.1%`, '0.0%', '0.0%', '']);
});

// ---- Break-even (post-v0.4.0 polish) ----

test('break-even: the lowest listing price that gives back the cost after both fees, worked by hand at the 1 copper minimums and at real prices', () => {
  // The two 1c minimums: 3c gives back 3 - 1 - 1 = 1c (2c gives 0c); 4c gives 2c; 5c gives 3c.
  assert.deepEqual([1, 2, 3].map(Money.breakEven), [3, 4, 5]);
  // 14c gives 12c; 15c gives 15 - 1 - 2 = 12c (the 10% fee reaches 2c at 15c), so 13c first comes back at 16c.
  assert.deepEqual([Money.breakEven(12), Money.breakEven(13)], [14, 16]);
  // Glob of Ectoplasm's 17s 10c buy order: 20s 12c gives back 2012 - 101 - 201 = 1710; 20s 11c gives 2011 - 101 - 201 = 1709.
  assert.equal(Money.breakEven(1710), 2012);
  // Mystic Coin at 2g 11s 00c: 2g 48s 23c gives back 24823 - 1241 - 2482 = 21100 exactly; 2g 48s 22c gives 21099.
  assert.equal(Money.breakEven(21100), 24823);
  // At least 1 copper more than the cost (the lowest price that makes any money): 2g 48s 24c gives 21101.
  assert.equal(Money.breakEven(21101), 24824);
});

test('break-even is never too low and never more than needed: every cost from 1c to 50 gold, and large ones', () => {
  for (let cost = 1; cost <= 500000; cost++) {
    const p = Money.breakEven(cost);
    if (Money.proceeds(p).net < cost || (p > 1 && Money.proceeds(p - 1).net >= cost)) assert.fail(`cost ${cost}: ${p}`);
  }
  for (const cost of [9999999, 123456789, 999999999, 7654321012]) {
    const p = Money.breakEven(cost);
    assert.ok(Money.proceeds(p).net >= cost && Money.proceeds(p - 1).net < cost, `${cost}: ${p}`);
    assert.ok(Math.abs(p - cost / 0.85) < 3, `${cost}: ${p} is about cost / 0.85`);
  }
});

test('break-even refuses anything that is not a whole, positive number of copper; quote() carries it, and none without buy orders', () => {
  for (const bad of [0, -1, -1710, 1.5, NaN, Infinity, '1710', null, undefined, {}, 2 ** 53, 9e15]) assert.equal(Money.breakEven(bad), null, String(bad));
  assert.equal(Money.quote({ buys: { quantity: 391900, unit_price: 1710 }, sells: { quantity: 2219204, unit_price: 1910 } }).breakEven, 2012);
  assert.equal(Money.quote({ buys: { quantity: 0, unit_price: 0 }, sells: { quantity: 5, unit_price: 1910 } }).breakEven, null, 'no buy orders: nothing to break even against');
  assert.equal(Money.quote({ buys: { quantity: 40, unit_price: 1 }, sells: { quantity: 0, unit_price: 0 } }).breakEven, 3, 'no sell listings: the break-even still stands');
  // The margin as a share of the buy price never divides by zero: no buy orders gives null, not Infinity.
  assert.equal(Money.quote({ buys: { quantity: 0, unit_price: 0 }, sells: { quantity: 5, unit_price: 1910 } }).marginPct, null);
  assert.equal(Money.quote({ buys: { quantity: 40, unit_price: 1 }, sells: { quantity: 12, unit_price: 2 } }).marginPct, -1, '1c buy, 2c sell: a loss of all of it');
});

// ---- The order book and a number of units (v0.5.0) ----
//
// Everything below is checked against reference implementations written here on purpose in another way than the
// module's: the book is turned into one price for every single unit and the first n are added up, in BigInt; a fee
// is the exact fraction rounded half up, in BigInt; a break-even is confirmed one copper either side. None of them
// calls the function it checks.

const B = (n) => BigInt(n);
/** A fee in exact arithmetic: pct% of the total, to the nearest copper with a half going up, at least 1. */
const refFee = (total, pct) => { const f = (B(total) * B(pct) * 2n + 100n) / 200n; return f < 1n ? 1n : f; };
const refNet = (total) => B(total) - refFee(total, 5) - refFee(total, 10);
/** The price of every single unit of a side, best first: rows that are price levels, the first row of each price only. */
function refUnitPrices(rows, side) {
  const first = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !Number.isSafeInteger(r.unit_price) || r.unit_price <= 0 || !Number.isSafeInteger(r.quantity) || r.quantity <= 0) continue;
    if (!first.has(r.unit_price)) first.set(r.unit_price, r.quantity);
  }
  const prices = [...first.keys()].sort((a, b) => (side === 'buys' ? b - a : a - b));
  const out = [];
  for (const p of prices) for (let k = 0; k < first.get(p) && out.length < 400; k++) out.push(p);
  return out;
}
/** A fixed sequence of numbers that looks random (mulberry32), so every run sees the same books. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A made-up side: a few to many levels around a price, sometimes with a repeated row, a row out of order or a row that is not one. */
function randomRows(rnd, side) {
  const n = 1 + Math.floor(rnd() * 14), rows = [];
  let p = 1 + Math.floor(rnd() * (rnd() < 0.3 ? 12 : 60000));
  for (let i = 0; i < n; i++) {
    rows.push({ listings: 1 + Math.floor(rnd() * 4), unit_price: p, quantity: 1 + Math.floor(rnd() * (rnd() < 0.5 ? 6 : 400)) });
    p = side === 'buys' ? p - 1 - Math.floor(rnd() * 5) : p + 1 + Math.floor(rnd() * 5);
    if (p < 1) break;
  }
  if (rnd() < 0.25 && rows.length > 1) { const k = 1 + Math.floor(rnd() * (rows.length - 1)); rows.splice(k, 0, Object.assign({}, rows[k - 1], rnd() < 0.5 ? {} : { quantity: rows[k - 1].quantity + 3 })); }
  if (rnd() < 0.15 && rows.length > 2) { const k = Math.floor(rnd() * (rows.length - 1)); [rows[k], rows[k + 1]] = [rows[k + 1], rows[k]]; }
  if (rnd() < 0.15) rows.splice(Math.floor(rnd() * rows.length), 0, [{ unit_price: 0, quantity: 5 }, { unit_price: 12, quantity: 0 }, { unit_price: 'x', quantity: 1 }, null, { unit_price: 2.5, quantity: 1 }][Math.floor(rnd() * 5)]);
  return rows;
}
const ECTO = { // tests/fixtures/tp-sample.json, the two sides of 19721 as the browser checks serve them
  buys: [[1706, 133], [1704, 247], [1703, 313], [1701, 1979], [1700, 500], [1694, 3250], [1693, 82], [1692, 281]].map(([unit_price, quantity]) => ({ listings: 1, unit_price, quantity })),
  sells: [[1895, 231], [1896, 100], [1897, 227], [1898, 52], [1899, 81], [1914, 510], [1915, 261], [1919, 2]].map(([unit_price, quantity]) => ({ listings: 1, unit_price, quantity })),
};
const sides = (b) => ({ buys: Money.cleanSide(b.buys, 'buys'), sells: Money.cleanSide(b.sells, 'sells') });

test('a side of the order book is cleaned, and what was wrong with it is kept: repeats, rows out of order, rows that are not price levels', () => {
  const ok = Money.cleanSide(ECTO.sells, 'sells');
  assert.deepEqual([ok.side, ok.levels.length, ok.depth, ok.repeats, ok.sure, ok.unsorted, ok.dropped], ['sells', 8, 1464, 0, 8, false, 0]);
  assert.deepEqual(ok.levels[0], { price: 1895, quantity: 231, orders: 1 });
  assert.equal(Money.cleanSide(ECTO.buys, 'buys').depth, 6785);
  // A repeated row is counted once (the first of that price), and the levels before it are the sure ones.
  const rep = Money.cleanSide([{ unit_price: 9, quantity: 4 }, { unit_price: 8, quantity: 2 }, { unit_price: 8, quantity: 2 }, { unit_price: 7, quantity: 5 }], 'buys');
  assert.deepEqual([rep.levels.map((l) => l.price), rep.depth, rep.repeats, rep.sure], [[9, 8, 7], 11, 1, 2]);
  // The same price with another quantity is still one level: the first row's, never the two added up.
  assert.equal(Money.cleanSide([{ unit_price: 8, quantity: 2 }, { unit_price: 8, quantity: 50 }], 'buys').depth, 2);
  // Out of order: sorted (buys from the highest, sells from the lowest), and said.
  const mixed = Money.cleanSide([{ unit_price: 5, quantity: 1 }, { unit_price: 3, quantity: 1 }, { unit_price: 4, quantity: 1 }], 'sells');
  assert.deepEqual([mixed.levels.map((l) => l.price), mixed.unsorted], [[3, 4, 5], true]);
  assert.deepEqual(Money.cleanSide([{ unit_price: 3, quantity: 1 }, { unit_price: 5, quantity: 1 }], 'buys').levels.map((l) => l.price), [5, 3]);
  // Rows that are not price levels are left out and counted, with the ones the caller already left out.
  const bad = Money.cleanSide([{ unit_price: 5, quantity: 1 }, { unit_price: 0, quantity: 9 }, { unit_price: 6, quantity: 0 }, { unit_price: 6.5, quantity: 1 }, { unit_price: '7', quantity: 1 }, null, 'x', { unit_price: -2, quantity: 1 }], 'sells', 2);
  assert.deepEqual([bad.levels.length, bad.depth, bad.dropped], [1, 1, 9]);
  // An empty side is empty, never a level at 0; something that is not a list is one row that could not be read.
  assert.deepEqual([Money.cleanSide([], 'buys').levels.length, Money.cleanSide([], 'buys').depth, Money.cleanSide([], 'buys').dropped], [0, 0, 0]);
  assert.deepEqual([Money.cleanSide(undefined, 'sells').dropped, Money.cleanSide(null, 'sells').dropped, Money.cleanSide({ unit_price: 5, quantity: 1 }, 'sells').dropped, Money.cleanSide('x', 'buys').levels.length], [0, 0, 1, 0]);
  assert.equal(Money.cleanSide([{ unit_price: 5, quantity: 1, listings: 0 }], 'sells').levels[0].orders, null, 'an order count that is not one is not shown as one');
});

test('a real order book with the API\'s repeated rows: each price once, and the walk says when it goes past what is sure', () => {
  const real = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'tp-book-repeats.json'), 'utf8'));
  const buys = Money.cleanSide(real.buys, 'buys'), sells = Money.cleanSide(real.sells, 'sells');
  assert.deepEqual([real.buys.length, buys.levels.length, buys.repeats, buys.sure], [210, 204, 6, 195]);
  assert.deepEqual([real.sells.length, sells.levels.length, sells.repeats, sells.sure], [210, 209, 1, 200]);
  assert.equal(new Set(buys.levels.map((l) => l.price)).size, buys.levels.length, 'no price twice');
  assert.ok(buys.depth < real.buys.reduce((a, r) => a + r.quantity, 0), 'the repeats are not added to the depth');
  // 250 units from the best prices stay far inside the sure levels: not uncertain.
  const w = Money.walk(buys, 250);
  assert.deepEqual([w.filled, w.short, w.uncertain, w.fills.length < 195], [250, 0, false, true]);
});

test('walking a side takes the best prices first, level by level, and reports a shortfall instead of inventing units', () => {
  const { buys, sells } = sides(ECTO);
  // 250 to buy: 231 at 1895 and 19 at 1896 = 437,745 + 36,024.
  const b = Money.walk(sells, 250);
  assert.deepEqual([b.asked, b.filled, b.short, b.total, b.best, b.worst, b.uncertain], [250, 250, 0, 473769, 1895, 1896, false]);
  assert.deepEqual(b.fills, [{ price: 1895, take: 231, of: 231, orders: 1 }, { price: 1896, take: 19, of: 100, orders: 1 }]);
  // 250 to sell: 133 at 1706 and 117 at 1704 = 226,898 + 199,368.
  const s = Money.walk(buys, 250);
  assert.deepEqual([s.total, s.best, s.worst, s.fills.map((f) => f.take)], [426266, 1706, 1704, [133, 117]]);
  // One unit, and a whole level exactly.
  assert.deepEqual([Money.walk(sells, 1).total, Money.walk(sells, 231).fills.length, Money.walk(sells, 231).total, Money.walk(sells, 232).fills.length], [1895, 1, 437745, 2]);
  // A thin side: 9 units in all. Asked for 10: 9 filled, 1 short, the total is for the 9.
  const thin = Money.cleanSide([{ unit_price: 100, quantity: 4 }, { unit_price: 105, quantity: 5 }], 'sells');
  const t = Money.walk(thin, 10);
  assert.deepEqual([t.filled, t.short, t.total, t.worst], [9, 1, 925, 105]);
  assert.deepEqual([Money.walk(thin, 9).short, Money.walk(thin, 9).total], [0, 925]);
  // An empty side: nothing filled, no price, no total of 0 passed off as a cost.
  const none = Money.walk(Money.cleanSide([], 'sells'), 5);
  assert.deepEqual([none.filled, none.short, none.total, none.best, none.worst, none.fills], [0, 5, 0, null, null, []]);
});

test('a walk is uncertain past a repeated row, when a side with repeats runs out, when rows were out of order or unreadable; never otherwise', () => {
  const rep = Money.cleanSide([{ unit_price: 9, quantity: 4 }, { unit_price: 8, quantity: 2 }, { unit_price: 8, quantity: 2 }, { unit_price: 7, quantity: 5 }], 'buys');
  assert.deepEqual([4, 5, 6, 7, 11].map((n) => Money.walk(rep, n).uncertain), [false, false, false, true, true], 'sure up to and with the repeated price, not past it');
  assert.equal(Money.walk(rep, 12).uncertain, true, 'short on a side with repeats');
  // The repeat is the last row: every level is sure, but a side with a repeat that runs out may be missing one.
  const tail = Money.cleanSide([{ unit_price: 9, quantity: 1 }, { unit_price: 8, quantity: 1 }, { unit_price: 8, quantity: 1 }], 'buys');
  assert.deepEqual([tail.sure, Money.walk(tail, 2).uncertain, Money.walk(tail, 3).uncertain, Money.walk(tail, 3).short], [2, false, true, 1]);
  assert.equal(Money.walk(Money.cleanSide([{ unit_price: 5, quantity: 1 }, { unit_price: 3, quantity: 1 }, { unit_price: 4, quantity: 1 }], 'sells'), 1).uncertain, true, 'out of order');
  assert.equal(Money.walk(Money.cleanSide([{ unit_price: 5, quantity: 9 }, null], 'sells'), 1).uncertain, true, 'a row could not be read');
  assert.equal(Money.walk(Money.cleanSide([{ unit_price: 5, quantity: 9 }], 'sells', 1), 1).uncertain, true, 'a row the caller left out');
  assert.equal(Money.walk(Money.cleanSide([{ unit_price: 5, quantity: 2 }], 'sells'), 9).uncertain, false, 'a clean side that is simply too small is short, not uncertain');
});

test('the amount is a whole number from 1 to 250, one transaction: nothing else is walked or planned', () => {
  const { sells } = sides(ECTO), book = sides(ECTO);
  for (const n of [0, -1, 251, 1000, 2.5, NaN, Infinity, '5', null, undefined, {}]) {
    assert.equal(Money.walk(sells, n), null, `walk ${String(n)}`);
    assert.equal(Money.plan(book, n, {}), null, `plan ${String(n)}`);
  }
  assert.equal(Money.MAX_UNITS, 250);
  assert.deepEqual([Money.walk(sells, 1).filled, Money.walk(sells, 250).filled, Money.plan(book, 1, {}).n, Money.plan(book, 250, {}).n], [1, 250, 1, 250]);
  assert.equal(Money.walk(null, 5), null);
  assert.equal(Money.walk({ levels: 'x' }, 5), null);
  assert.equal(Money.plan(null, 5, {}), null);
});

test('an average price is rounded against the reader and says when it was rounded', () => {
  assert.deepEqual(Money.average(473769, 250, true), { value: 1896, exact: false }, '1895.076 as a cost: up');
  assert.deepEqual(Money.average(426266, 250, false), { value: 1705, exact: false }, '1705.064 as proceeds: down');
  assert.deepEqual(Money.average(437745, 231, true), { value: 1895, exact: true });
  assert.deepEqual(Money.average(437745, 231, false), { value: 1895, exact: true });
  assert.deepEqual([Money.average(10, 0, true), Money.average(1.5, 1, true), Money.average(10, 2.5, true)], [null, null, null]);
});

test('selling across several prices: the fees on the whole sale and the fees on each price, both worked out, by hand', () => {
  const { buys } = sides(ECTO);
  // 426,266 in all. Whole sale: 5% = 21,313.3 -> 21,313; 10% = 42,626.6 -> 42,627; net 362,326.
  // Each price: 226,898 -> 11,345 and 22,690; 199,368 -> 9,968 and 19,937; fees 63,940; net 362,326. The same here.
  const f = Money.sellFees(Money.walk(buys, 250));
  assert.deepEqual(f.whole, { total: 426266, listing: 21313, exchange: 42627, net: 362326 });
  assert.deepEqual(f.byLevel, { total: 426266, listing: 21313, exchange: 42627, net: 362326 });
  assert.deepEqual([f.differ, f.low, f.high], [false, 362326, 362326]);
  // One at 9c and one at 8c. Whole sale, 17c: 0.85 -> 1 and 1.7 -> 2: net 14. Each price: 9c -> 1 and 1, 8c -> 1 and 1: net 13.
  const small = Money.sellFees(Money.walk(Money.cleanSide([{ unit_price: 9, quantity: 1 }, { unit_price: 8, quantity: 1 }], 'buys'), 2));
  assert.deepEqual([small.whole.net, small.byLevel.net, small.byLevel.listing, small.byLevel.exchange, small.differ, small.low, small.high], [14, 13, 2, 2, true, 13, 14]);
  // One at 3c and one at 2c: 5c less 1 and 1 = 3 on the whole sale; 3c -> 1 and 2c -> 0 on each price.
  const tiny = Money.sellFees(Money.walk(Money.cleanSide([{ unit_price: 3, quantity: 1 }, { unit_price: 2, quantity: 1 }], 'buys'), 2));
  assert.deepEqual([tiny.whole.net, tiny.byLevel.net, tiny.differ], [3, 1, true]);
  // One price only: the two are the same thing.
  const one = Money.sellFees(Money.walk(buys, 100));
  assert.deepEqual([one.differ, one.whole.net, one.byLevel.net], [false, 145010, 145010]); // 170,600 - 8,530 - 17,060
  assert.equal(Money.sellFees(Money.walk(Money.cleanSide([], 'buys'), 3)), null, 'nothing taken, no fees made up');
  assert.equal(Money.sellFees(null), null);
});

test('saleNet is proceeds for a total, and proceeds is unchanged by it', () => {
  assert.deepEqual(Money.saleNet(1710), Money.proceeds(1710));
  assert.deepEqual(Money.saleNet(750), Money.proceeds(3, 250));
  for (const bad of [0, -5, 1.5, NaN, '10', null, undefined]) assert.equal(Money.saleNet(bad), null, String(bad));
  for (let total = 1; total <= 60000; total++) {
    const s = Money.saleNet(total);
    if (B(s.listing) !== refFee(total, 5) || B(s.exchange) !== refFee(total, 10) || B(s.net) !== refNet(total)) assert.fail(`total ${total}: ${JSON.stringify(s)}`);
  }
  // The largest sale there can be (250 units at 10,000 gold) and the totals near it stay exact.
  for (const total of [25000000000, 24999999999, 24999999995, 24999999990, 12345678905, 12345678915]) {
    const s = Money.saleNet(total);
    assert.deepEqual([B(s.listing), B(s.exchange), B(s.net)], [refFee(total, 5), refFee(total, 10), refNet(total)], String(total));
  }
});

test('the plan for an amount: the four ways to trade, each figure by hand, on one order book', () => {
  const book = sides(ECTO);
  // 10 units. Buy now: 10 at 1895 = 18,950. Sell now: 10 at 1706 = 17,060, less 853 and 1,706 = 14,501.
  // Buy order at the highest, 1706: 17,060. List at the lowest, 1895: 18,950 less 948 (947.5 up) and 1,895 = 16,107.
  const nn = Money.plan(book, 10, { get: 'now', give: 'now' });
  assert.deepEqual([nn.n, nn.bid, nn.ask, nn.cost, nn.back, nn.gain, nn.executable, nn.why, nn.uncertain], [10, 1706, 1895, 18950, { low: 14501, high: 14501 }, { low: -4449, high: -4449 }, true, null, false]);
  assert.deepEqual(nn.breakEven, { kind: 'now', low: 1450, high: 1450 }, '14,501 / 10, rounded down');
  assert.ok(Math.abs(nn.roi.low - -4449 / 18950) < 1e-12 && nn.roi.low === nn.roi.high);
  assert.deepEqual([nn.buyNow.avg, nn.sellNow.avg], [{ value: 1895, exact: true }, { value: 1706, exact: true }]);
  const ol = Money.plan(book, 10, { get: 'order', give: 'list' });
  assert.deepEqual([ol.order, ol.list, ol.cost, ol.back, ol.gain, ol.executable], [{ price: 1706, total: 17060 }, { price: 1895, total: 18950, listing: 948, exchange: 1895, net: 16107 }, 17060, { low: 16107, high: 16107 }, { low: -953, high: -953 }, false]);
  // Break-even for 10 that cost 17,060: 2,007 each gives 20,070 - 1,004 (1,003.5 up) - 2,007 = 17,059, one short; 2,008 gives 17,068.
  assert.deepEqual(ol.breakEven, { kind: 'list', price: 2008 });
  const nl = Money.plan(book, 10, { get: 'now', give: 'list' });
  assert.deepEqual([nl.cost, nl.back.low, nl.gain.low, nl.executable], [18950, 16107, -2843, false]);
  const on = Money.plan(book, 10, { get: 'order', give: 'now' });
  assert.deepEqual([on.cost, on.back.low, on.gain.low, on.executable, on.breakEven], [17060, 14501, -2559, false, { kind: 'now', low: 1450, high: 1450 }]);
  // The default is at once both ways; an unknown choice is that too, never a third thing.
  assert.deepEqual([Money.plan(book, 10).get, Money.plan(book, 10).give, Money.plan(book, 10, { get: 'x', give: 7 }).executable], ['now', 'now', true]);
  // One unit by buy order and listing is the potential margin the page has always shown, when the book's best
  // prices are the prices: the two cannot drift apart.
  const q = Money.quote({ buys: { quantity: 6785, unit_price: 1706 }, sells: { quantity: 1464, unit_price: 1895 } });
  const one = Money.plan(book, 1, { get: 'order', give: 'list' });
  assert.deepEqual([one.gain.low, one.breakEven.price, one.roi.low], [q.margin, q.breakEven, q.marginPct]);
});

test('the plan across prices: 250 units, and the two fee estimates kept apart when they differ', () => {
  const p = Money.plan(sides(ECTO), 250, { get: 'now', give: 'now' });
  assert.deepEqual([p.cost, p.back, p.gain], [473769, { low: 362326, high: 362326 }, { low: -111443, high: -111443 }]);
  assert.deepEqual([p.buyNow.avg, p.sellNow.avg, p.buyNow.fills.length, p.sellNow.fills.length], [{ value: 1896, exact: false }, { value: 1705, exact: false }, 2, 2]);
  const copper = { buys: Money.cleanSide([{ unit_price: 9, quantity: 1 }, { unit_price: 8, quantity: 1 }], 'buys'), sells: Money.cleanSide([{ unit_price: 11, quantity: 5 }], 'sells') };
  const c = Money.plan(copper, 2, { get: 'now', give: 'now' });
  assert.deepEqual([c.cost, c.back, c.gain, c.breakEven], [22, { low: 13, high: 14 }, { low: -9, high: -8 }, { kind: 'now', low: 6, high: 7 }]);
  assert.ok(c.roi.low < c.roi.high && Math.abs(c.roi.high - -8 / 22) < 1e-12);
});

test('not enough in the order book: no cost, proceeds, gain, return or break-even for the amount, and the reason', () => {
  const thin = { buys: Money.cleanSide([{ unit_price: 50, quantity: 3 }], 'buys'), sells: Money.cleanSide([{ unit_price: 100, quantity: 4 }, { unit_price: 105, quantity: 5 }], 'sells') };
  const a = Money.plan(thin, 10, { get: 'now', give: 'now' });
  assert.deepEqual([a.cost, a.back, a.gain, a.roi, a.breakEven, a.why], [null, null, null, null, null, 'short-sells']);
  assert.deepEqual([a.buyNow.filled, a.buyNow.short, a.buyNow.total, a.sellNow.filled, a.sellNow.short], [9, 1, 925, 3, 7]);
  // The average is over the units there are (925 / 9 = 102.8, up), never over the 10 asked for.
  assert.deepEqual([a.buyNow.avg, a.sellNow.avg], [{ value: 103, exact: false }, { value: 50, exact: true }]);
  // 4 units: the sell listings hold them, the buy orders do not.
  const b = Money.plan(thin, 4, { get: 'now', give: 'now' });
  assert.deepEqual([b.cost, b.back, b.gain, b.why, b.breakEven], [400, null, null, 'short-buys', null]);
  // The same 4 by listing: nothing is short, since a listing takes nothing from the book.
  assert.deepEqual([Money.plan(thin, 4, { get: 'now', give: 'list' }).why, Money.plan(thin, 4, { get: 'now', give: 'list' }).gain.low], [null, 340 - 400]); // 400 - 20 - 40
  // 10 by buy order and listing: both are only hoped for, and neither needs the book's depth.
  const c = Money.plan(thin, 10, { get: 'order', give: 'list' });
  assert.deepEqual([c.cost, c.back.low, c.why], [500, 850, null]);
  // No sell listings at all, no buy orders at all.
  const noSells = { buys: thin.buys, sells: Money.cleanSide([], 'sells') }, noBuys = { buys: Money.cleanSide([], 'buys'), sells: thin.sells };
  assert.deepEqual([Money.plan(noSells, 1, { get: 'now', give: 'now' }).why, Money.plan(noSells, 1, { get: 'order', give: 'list' }).why, Money.plan(noSells, 1, { get: 'order', give: 'list' }).list], ['no-sells', 'no-sells', null]);
  assert.deepEqual([Money.plan(noBuys, 1, { get: 'now', give: 'now' }).why, Money.plan(noBuys, 1, { get: 'order', give: 'list' }).why, Money.plan(noBuys, 1, { get: 'order', give: 'list' }).order, Money.plan(noBuys, 1, {}).cost], ['no-buys', 'no-buys', null, 100]);
  const empty = Money.plan({ buys: Money.cleanSide([], 'buys'), sells: Money.cleanSide([], 'sells') }, 1, {});
  assert.deepEqual([empty.bid, empty.ask, empty.cost, empty.back, empty.gain, empty.why], [null, null, null, null, null, 'no-sells']);
});

test('at a few copper the minimum fees take everything, and the plan shows it as it is', () => {
  const book = { buys: Money.cleanSide([{ unit_price: 1, quantity: 500 }], 'buys'), sells: Money.cleanSide([{ unit_price: 2, quantity: 500 }], 'sells') };
  const one = Money.plan(book, 1, { get: 'now', give: 'now' });
  assert.deepEqual([one.cost, one.back, one.gain], [2, { low: -1, high: -1 }, { low: -3, high: -3 }]);
  // 250 at 1c in one sale: 250 less 13 (12.5 up) and 25 = 212.
  assert.deepEqual(Money.plan(book, 250, { get: 'order', give: 'now' }).back, { low: 212, high: 212 });
});

test('a plan is uncertain exactly when a leg taken at once reaches what the book is not sure of', () => {
  const book = { buys: Money.cleanSide([{ unit_price: 9, quantity: 1 }, { unit_price: 8, quantity: 1 }, { unit_price: 8, quantity: 1 }, { unit_price: 7, quantity: 5 }], 'buys'), sells: Money.cleanSide([{ unit_price: 20, quantity: 50 }], 'sells') };
  assert.deepEqual([2, 3].map((n) => Money.plan(book, n, { get: 'now', give: 'now' }).uncertain), [false, true]);
  assert.equal(Money.plan(book, 3, { get: 'now', give: 'list' }).uncertain, false, 'a listing takes nothing from the buy orders');
  assert.equal(Money.plan(book, 3, { get: 'order', give: 'now' }).uncertain, true);
  // The other way round: unsure sell listings matter to buying now, not to a buy order.
  const flip = { buys: Money.cleanSide([{ unit_price: 5, quantity: 50 }], 'buys'), sells: Money.cleanSide([{ unit_price: 20, quantity: 1 }, { unit_price: 21, quantity: 1 }, { unit_price: 21, quantity: 1 }, { unit_price: 22, quantity: 9 }], 'sells') };
  assert.deepEqual([Money.plan(flip, 3, { get: 'now', give: 'list' }).uncertain, Money.plan(flip, 3, { get: 'order', give: 'list' }).uncertain, Money.plan(flip, 3, { get: 'order', give: 'now' }).uncertain, Money.plan(flip, 2, { get: 'now', give: 'now' }).uncertain], [true, false, false, false]);
});

test('break-even for several units: the lowest price for each that gives back the cost, confirmed one copper either side', () => {
  assert.equal(Money.breakEvenFor(17060, 10), 2008);
  assert.equal(Money.breakEvenFor(1710, 1), Money.breakEven(1710));
  assert.deepEqual([Money.breakEvenFor(1, 250), Money.breakEvenFor(213, 250), Money.breakEvenFor(212, 250)], [1, 2, 1], '250 at 1c give back 212');
  for (const bad of [[0, 1], [-1, 1], [1.5, 1], [100, 0], [100, 251], [100, 2.5], [NaN, 1], ['100', 1], [100, '2'], [2 ** 53, 1], [9e15, 250]]) assert.equal(Money.breakEvenFor(bad[0], bad[1]), null, String(bad));
  const rnd = seeded(20261118);
  let checked = 0;
  for (const n of [1, 2, 3, 4, 7, 10, 19, 50, 100, 249, 250]) {
    for (let k = 0; k < 400; k++) {
      const cost = 1 + Math.floor(rnd() * (k % 3 ? 2000000 : 400)) * (k % 5 ? 1 : n);
      const p = Money.breakEvenFor(cost, n);
      if (refNet(p * n) < B(cost)) assert.fail(`${n} units costing ${cost}: ${p} does not give it back`);
      if (p > 1 && refNet((p - 1) * n) >= B(cost)) assert.fail(`${n} units costing ${cost}: ${p - 1} already gives it back`);
      checked++;
    }
  }
  assert.equal(checked, 4400);
});

test('what a listing gives back never falls as its price rises, for every amount from 1 to 250', () => {
  for (let n = 1; n <= 250; n++) {
    let last = Money.proceeds(1, n).net;
    for (let p = 2; p <= 400; p++) { const net = Money.proceeds(p, n).net; if (net < last) assert.fail(`${n} units: ${p - 1} gives ${last}, ${p} gives ${net}`); last = net; }
  }
});

test('against the unit-by-unit reference: every amount on the sample book, and made-up books with repeats, disorder and bad rows', () => {
  const check = (rows, label) => {
    const book = { buys: Money.cleanSide(rows.buys, 'buys'), sells: Money.cleanSide(rows.sells, 'sells') };
    const ub = refUnitPrices(rows.buys, 'buys'), us = refUnitPrices(rows.sells, 'sells');
    return (n) => {
      const p = Money.plan(book, n, { get: 'now', give: 'now' });
      const sum = (a) => a.slice(0, n).reduce((x, y) => x + B(y), 0n);
      const where = `${label}, ${n} units`;
      // Buying now: the first n single units of the sell side.
      assert.equal(p.buyNow.filled, Math.min(n, us.length), `${where}: bought`);
      assert.equal(B(p.buyNow.total), sum(us), `${where}: cost`);
      assert.equal(p.buyNow.short, n - Math.min(n, us.length), `${where}: short to buy`);
      // Selling now: the first n single units of the buy side, and the two fee estimates.
      assert.equal(p.sellNow.filled, Math.min(n, ub.length), `${where}: sold`);
      assert.equal(B(p.sellNow.total), sum(ub), `${where}: gross`);
      if (p.sellNow.filled) {
        const part = new Map();
        for (const price of ub.slice(0, n)) part.set(price, (part.get(price) || 0n) + B(price));
        let byLevel = 0n;
        for (const total of part.values()) byLevel += refNet(total);
        assert.equal(B(p.sellNow.fees.whole.net), refNet(sum(ub)), `${where}: net on the whole sale`);
        assert.equal(B(p.sellNow.fees.byLevel.net), byLevel, `${where}: net on each price`);
        assert.equal(p.sellNow.fees.differ, refNet(sum(ub)) !== byLevel, `${where}: differ`);
        // The two estimates stay close: each fee is rounded once for the sale or once for each price, and the
        // minimum of 1 copper can add at most 1 for each fee of each price.
        assert.ok(Math.abs(p.sellNow.fees.whole.net - p.sellNow.fees.byLevel.net) <= 2 * part.size, `${where}: the estimates are ${p.sellNow.fees.whole.net} and ${p.sellNow.fees.byLevel.net}`);
      }
      const full = us.length >= n && ub.length >= n;
      assert.equal(p.gain === null, !full, `${where}: a result only when both sides fill`);
      if (full) {
        assert.equal(B(p.gain.high), [refNet(sum(ub)), [...new Set(ub.slice(0, n))].reduce((a, price) => a + refNet(B(price) * B(ub.slice(0, n).filter((x) => x === price).length)), 0n)].reduce((a, b2) => (a > b2 ? a : b2)) - sum(us), `${where}: gain`);
        assert.ok(p.gain.low <= p.gain.high);
      }
      return p;
    };
  };
  const onSample = check(ECTO, 'sample');
  let lastCost = 0, lastGross = 0, lastAvgBuy = 0, lastAvgSell = Infinity;
  for (let n = 1; n <= 250; n++) {
    const p = onSample(n);
    // More units never cost less or sell for less in all; each costs no less on average and sells for no more.
    assert.ok(p.buyNow.total > lastCost && p.sellNow.total > lastGross, `sample ${n}: totals grow`);
    assert.ok(p.buyNow.total * (n - 1) >= lastCost * n || n === 1, `sample ${n}: the average cost does not fall`);
    assert.ok(p.buyNow.avg.value >= lastAvgBuy && p.sellNow.avg.value <= lastAvgSell, `sample ${n}: averages`);
    [lastCost, lastGross, lastAvgBuy, lastAvgSell] = [p.buyNow.total, p.sellNow.total, p.buyNow.avg.value, p.sellNow.avg.value];
  }
  const rnd = seeded(5005), amounts = [1, 2, 3, 5, 10, 37, 50, 100, 249, 250];
  let books = 0, withRepeats = 0, unsorted = 0, dropped = 0, shorts = 0, differ = 0;
  for (let k = 0; k < 1500; k++) {
    const rows = { buys: randomRows(rnd, 'buys'), sells: randomRows(rnd, 'sells') };
    const run = check(rows, `book ${k}`);
    for (const n of amounts) { const p = run(n); if (p.buyNow.short || p.sellNow.short) shorts++; if (p.sellNow.fees && p.sellNow.fees.differ) differ++; }
    const b = Money.cleanSide(rows.buys, 'buys'), s = Money.cleanSide(rows.sells, 'sells');
    books++; if (b.repeats || s.repeats) withRepeats++; if (b.unsorted || s.unsorted) unsorted++; if (b.dropped || s.dropped) dropped++;
  }
  // The made-up books really do contain what they are for.
  assert.ok(books === 1500 && withRepeats > 100 && unsorted > 100 && dropped > 100 && shorts > 1000 && differ > 500, JSON.stringify({ books, withRepeats, unsorted, dropped, shorts, differ }));
});

// ---- Depth near the best price (v0.5.0 Phase 3) ----

/**
 * The reference for near(), from the raw rows, with none of the module's code: the first row of each price in price
 * order, a price counted when it lies within 5% of the best in exact arithmetic (100 x price against 95 or 105 x
 * best, in BigInt, no rounding), and unsure when rows were out of order or unreadable, or when the next copper past
 * the first price that comes twice is still in range (a level missing there could belong in it).
 */
function refNear(rows, side, given = 0) {
  const ok = (r) => Boolean(r) && Number.isSafeInteger(r.unit_price) && r.unit_price > 0 && Number.isSafeInteger(r.quantity) && r.quantity > 0;
  const list = Array.isArray(rows) ? rows : [], good = list.filter(ok);
  const better = (a, b) => (side === 'buys' ? a > b : a < b);
  const unsorted = good.some((r, i) => i > 0 && better(r.unit_price, good[i - 1].unit_price));
  const dropped = given + (Array.isArray(rows) ? list.length - good.length : rows === undefined || rows === null ? 0 : 1);
  const sorted = good.map((r, i) => [r, i]).sort((x, y) => (side === 'buys' ? y[0].unit_price - x[0].unit_price : x[0].unit_price - y[0].unit_price) || x[1] - y[1]).map((x) => x[0]);
  const qty = new Map();
  let repeated = null;
  for (const r of sorted) { if (qty.has(r.unit_price)) { if (repeated === null) repeated = r.unit_price; } else qty.set(r.unit_price, r.quantity); }
  if (!qty.size) return null;
  const prices = [...qty.keys()], best = B(prices[0]);
  const inRange = (p) => (side === 'sells' ? 100n * B(p) <= 105n * best : 100n * B(p) >= 95n * best);
  const within = prices.filter(inRange);
  const gap = repeated !== null && inRange(side === 'sells' ? repeated + 1 : repeated - 1);
  return { best: prices[0], units: within.reduce((a, p) => a + qty.get(p), 0), prices: within.length, unsure: unsorted || dropped > 0 || gap, inRange };
}
const lv = (unit_price, quantity) => ({ listings: 1, unit_price, quantity });
const nearOf = (rows, side, given) => Money.near(Money.cleanSide(rows, side, given));

test('depth near the best price: the units within 5% of the best, both ends included, the limit rounded so nothing past 5% counts, by hand', () => {
  assert.equal(Money.NEAR_PCT, 5);
  // 5% of 1s 00c is 5c exactly: sell listings up to 1s 05c, buy orders down to 95c; one copper past is out.
  assert.deepEqual(nearOf([lv(100, 3), lv(103, 4), lv(105, 5), lv(106, 7)], 'sells'), { side: 'sells', best: 100, limit: 105, units: 12, prices: 3, uncertain: false });
  assert.deepEqual(nearOf([lv(100, 2), lv(97, 3), lv(95, 4), lv(94, 9)], 'buys'), { side: 'buys', best: 100, limit: 95, units: 9, prices: 3, uncertain: false });
  // 5% of 1s 10c is 5.5c: up to 1s 15c (115.5 rounded down) and down to 1s 05c (104.5 rounded up), never 1s 16c or 1s 04c.
  assert.deepEqual([nearOf([lv(110, 1), lv(115, 2), lv(116, 4)], 'sells').limit, nearOf([lv(110, 1), lv(115, 2), lv(116, 4)], 'sells').units], [115, 3]);
  assert.deepEqual([nearOf([lv(110, 1), lv(105, 2), lv(104, 4)], 'buys').limit, nearOf([lv(110, 1), lv(105, 2), lv(104, 4)], 'buys').units], [105, 3]);
  // Under 20 copper, 5% is less than 1 copper: only the best price itself. At 20 copper the next copper counts.
  assert.deepEqual([nearOf([lv(19, 5), lv(20, 6)], 'sells').limit, nearOf([lv(19, 5), lv(20, 6)], 'sells').units, nearOf([lv(19, 5), lv(18, 6)], 'buys').limit, nearOf([lv(19, 5), lv(18, 6)], 'buys').units], [19, 5, 19, 5]);
  assert.deepEqual([nearOf([lv(20, 5), lv(21, 6), lv(22, 1)], 'sells').units, nearOf([lv(20, 5), lv(19, 6), lv(18, 1)], 'buys').units], [11, 11]);
  assert.deepEqual([nearOf([lv(1, 9), lv(2, 1)], 'sells').units, nearOf([lv(1, 9)], 'buys').limit], [9, 1]);
  // The sample book: every level of both sides lies within 5% (sells to 19s 89c, buys down to 16s 21c).
  const s = Money.near(Money.cleanSide(ECTO.sells, 'sells')), b = Money.near(Money.cleanSide(ECTO.buys, 'buys'));
  assert.deepEqual([s.limit, s.units, s.prices, b.limit, b.units, b.prices], [1989, 1464, 8, 1621, 6785, 8]);
  // A level far past the best stops the count there: the rest of the side is not added.
  assert.deepEqual([nearOf([lv(1000, 7), lv(1060, 50), lv(1050, 1)], 'sells').units, nearOf([lv(1000, 7), lv(1050, 1), lv(1060, 50)], 'sells').units], [8, 8]);
  // Nothing to count: no levels, or not a side. Never a depth of 0 at a price of 0.
  for (const x of [Money.cleanSide([], 'sells'), Money.cleanSide([{ unit_price: 0, quantity: 5 }], 'buys'), null, undefined, {}, { levels: 'x' }]) assert.equal(Money.near(x), null);
  // Large prices stay exact: 9,999g 99s 99c, the most a listing can be.
  // 99,999,999 x 1.05 = 104,999,998.95, down; x 0.95 = 94,999,999.05, up.
  assert.deepEqual([nearOf([lv(99999999, 1), lv(104999998, 2), lv(104999999, 3)], 'sells').limit, nearOf([lv(99999999, 1), lv(104999998, 2), lv(104999999, 3)], 'sells').units,
    nearOf([lv(99999999, 1), lv(95000000, 2), lv(94999999, 4)], 'buys').limit, nearOf([lv(99999999, 1), lv(95000000, 2), lv(94999999, 4)], 'buys').units], [104999998, 3, 95000000, 3]);
});

test('depth near the best price is uncertain by the walk\'s own rules: rows out of order or unreadable, or a repeated row whose missing level could lie in range', () => {
  // A repeat at 1s 99c on buy orders from 2s 00c: the range runs down to 1s 90c, so a level missing after 1s 99c could be in it.
  assert.deepEqual(nearOf([lv(200, 4), lv(199, 2), lv(199, 2), lv(150, 5)], 'buys'), { side: 'buys', best: 200, limit: 190, units: 6, prices: 2, uncertain: true });
  // The repeat at the limit itself: anything missing after it lies past 5%, so the figure is sure.
  assert.equal(nearOf([lv(200, 4), lv(190, 2), lv(190, 1), lv(150, 5)], 'buys').uncertain, false);
  // The repeat outside the range: sure.
  assert.deepEqual([nearOf([lv(200, 4), lv(180, 2), lv(180, 1)], 'buys').uncertain, nearOf([lv(200, 4), lv(180, 2), lv(180, 1)], 'buys').units], [false, 4]);
  // A repeat of the best price on 9c buy orders: the range is 9c alone, and the missing level would be below it.
  assert.equal(nearOf([lv(9, 4), lv(8, 2), lv(8, 2), lv(7, 5)], 'buys').uncertain, false);
  assert.equal(nearOf([lv(9, 4), lv(9, 4), lv(8, 1)], 'buys').uncertain, false, '5% of 9c is under a copper: nothing can be missing inside');
  // Sell listings the same way round.
  assert.deepEqual([nearOf([lv(100, 1), lv(104, 1), lv(104, 1), lv(120, 1)], 'sells').uncertain, nearOf([lv(100, 1), lv(105, 1), lv(105, 1), lv(120, 1)], 'sells').uncertain], [true, false]);
  // Out of order, a row that could not be read, or one the caller left out: uncertain, whatever the range.
  assert.equal(nearOf([lv(105, 1), lv(100, 2)], 'sells').uncertain, true);
  assert.equal(nearOf([lv(100, 2), null], 'sells').uncertain, true);
  assert.equal(nearOf([lv(100, 2)], 'sells', 1).uncertain, true);
  assert.equal(nearOf([lv(100, 2), lv(300, 1)], 'sells').uncertain, false, 'a clean side is sure');
});

test('depth near the best price against the exact reference: the sample, a real answer with repeats, and 4,000 made-up sides', () => {
  const real = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'tp-book-repeats.json'), 'utf8'));
  const same = (rows, side, label, given) => {
    const m = nearOf(rows, side, given), r = refNear(rows, side, given);
    if (r === null) { assert.equal(m, null, label); return null; }
    assert.deepEqual([m.best, m.units, m.prices, m.uncertain], [r.best, r.units, r.prices, r.unsure], label);
    // The limit is the farthest price in range: in it, and one copper farther is not.
    assert.ok(r.inRange(m.limit) && !r.inRange(side === 'sells' ? m.limit + 1 : m.limit - 1), `${label}: limit ${m.limit}`);
    const c = Money.cleanSide(rows, side, given);
    assert.ok(m.units <= c.depth && m.prices <= c.levels.length && m.units >= c.levels[0].quantity, `${label}: within the side`);
    return m;
  };
  same(ECTO.sells, 'sells', 'sample sells'); same(ECTO.buys, 'buys', 'sample buys');
  const rb = same(real.buys, 'buys', 'real buys'), rs = same(real.sells, 'sells', 'real sells');
  // The real answer's repeats stand near its 200th price, far past 5% of its best: not uncertain there.
  assert.deepEqual([rb.uncertain, rs.uncertain, rb.prices < 195, rs.prices < 200], [false, false, true, true]);
  const rnd = seeded(7007);
  let n = 0, partial = 0, unsureGap = 0, sureRepeat = 0, unsure = 0, single = 0;
  for (let k = 0; k < 2000; k++) {
    for (const side of ['buys', 'sells']) {
      // Prices from 1c to about 20g, each step a random share of up to 3% of the price, so ranges end mid-side.
      const rows = [];
      let p = rnd() < 0.3 ? 1 + Math.floor(rnd() * 40) : 1 + Math.floor(rnd() * 200000);
      for (let i = 0, len = 1 + Math.floor(rnd() * 20); i < len && p >= 1; i++) {
        rows.push(lv(p, 1 + Math.floor(rnd() * 500)));
        const step = 1 + Math.floor(rnd() * Math.max(1, p * 0.03));
        p = side === 'buys' ? p - step : p + step;
      }
      if (rnd() < 0.3 && rows.length > 1) { const at = 1 + Math.floor(rnd() * (rows.length - 1)); rows.splice(at, 0, Object.assign({}, rows[at - 1])); }
      if (rnd() < 0.1 && rows.length > 2) { const at = Math.floor(rnd() * (rows.length - 1)); [rows[at], rows[at + 1]] = [rows[at + 1], rows[at]]; }
      if (rnd() < 0.1) rows.splice(Math.floor(rnd() * rows.length), 0, [{ unit_price: 0, quantity: 5 }, null, { unit_price: 3.5, quantity: 1 }][Math.floor(rnd() * 3)]);
      const m = same(rows, side, `side ${k} ${side}`);
      const c = Money.cleanSide(rows, side);
      n++;
      if (m.prices < c.levels.length) partial++;
      if (m.limit === m.best) single++;
      if (m.uncertain) unsure++;
      if (c.repeats && !c.unsorted && !c.dropped) { if (m.uncertain) unsureGap++; else sureRepeat++; }
    }
  }
  // The made-up sides really do hold what they are for: ranges that end inside a side, single-price ranges, and repeats on both sides of the line.
  assert.ok(n === 4000 && partial > 1000 && single > 200 && unsure > 500 && unsureGap > 100 && sureRepeat > 100, JSON.stringify({ n, partial, single, unsure, unsureGap, sureRepeat }));
});

test('a coin amount is read as typed: gold, silver and copper once each and in order, or bare copper; anything else is refused, never guessed', () => {
  const ok = { '2g 50s 10c': 25010, '2g50s10c': 25010, '2G 50S': 25000, ' 75s ': 7500, '40c': 40, '150': 150, '0': 0, '0c': 0, '1,250g 5c': 12500005, '12,345,678g': 123456780000, '150s': 15000, '2g 250c': 20250, '1g 00s 00c': 10000, '007s': 700 };
  for (const [t, copper] of Object.entries(ok)) assert.deepEqual(Money.parseCoins(t), { copper }, t);
  for (const t of ['', '   ', null, undefined]) assert.deepEqual(Money.parseCoins(t), { empty: true }, String(t));
  for (const t of ['2.5g', '-3s', '+3s', '5s 2g', '10c 1s', '1g 1g', '1s2s', 'abc', 'g', '12 34', '1,2g', '1,0000g', ',100g', '1e3', '2g 50', '50 s 3', '2 gold', '1g, 2s', '٣g']) assert.deepEqual(Money.parseCoins(t), { error: 'not-coins' }, t);
  assert.deepEqual(Money.parseCoins('999999999g 99s 99c'), { error: 'too-large' });
  assert.deepEqual(Money.parseCoins('100000000g'), { copper: 1e12 }, 'the most it takes');
  assert.deepEqual(Money.parseCoins('100000000g 1c'), { error: 'too-large' });
  assert.deepEqual(Money.parseCoins('1000000000001'), { error: 'too-large' });
  // What is read is what coins() writes: every amount comes back as itself.
  for (const n of [0, 1, 99, 100, 101, 9999, 10000, 10001, 123456, 1000000, 25000000000]) assert.deepEqual(Money.parseCoins(Money.coins(n).text), { copper: n }, String(n));
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
