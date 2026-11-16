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

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
