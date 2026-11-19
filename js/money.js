// Trading Post money: coins, fees and margins, all in whole copper. Pure, so the page and the Node tests
// share it. Loaded only when the Trading Post is opened.
//
// The fees are ArenaNet's, as the Guild Wars 2 Wiki documents them (page "Trading Post", read 2026-11-15):
// a listing fee of 5% "immediately taken ... when you list or instantly sell", and an exchange fee of 10%
// "deducted from coins delivered to the seller", each "based on the total sale price" with "a minimum of 1".
// How a fraction of a copper is rounded is NOT documented. This module rounds each fee to the nearest copper,
// half up, on the transaction's total, and the page calls every result an estimate (decision D5, manual
// check M1 in the Phase A report). For a number of units (v0.5.0) the order book is walked level by level; whether
// the fees of a sale that crosses several prices are worked out on the whole sale or on each price is not documented
// either, so both are worked out and shown as two estimates (sellFees).
(function (root) {
  'use strict';

  const LISTING_PCT = 5;
  const EXCHANGE_PCT = 10;
  /** The most units one Trading Post transaction can hold. */
  const MAX_UNITS = 250;

  const whole = (n) => Number.isSafeInteger(n);

  /** pct% of a total in copper, to the nearest copper (half up), at least 1. Integer arithmetic only. */
  function fee(total, pct) {
    if (!whole(total) || total < 0) return null;
    return Math.max(1, Math.floor((total * pct + 50) / 100));
  }
  const listingFee = (total) => fee(total, LISTING_PCT);
  const exchangeFee = (total) => fee(total, EXCHANGE_PCT);

  /**
   * What a sale of `units` at `price` each would hand the seller, after both fees: { total, listing, exchange, net }.
   * Both fees apply whether the item is listed or sold at once to a buy order. null for a price or count that
   * is not a whole, positive number.
   */
  function proceeds(price, units) {
    const n = units === undefined ? 1 : units;
    if (!whole(price) || price <= 0 || !whole(n) || n < 1 || n > MAX_UNITS) return null;
    return saleNet(price * n);
  }

  /** What a sale with the total `total` leaves after both fees, each worked out on that total: { total, listing, exchange, net }. */
  function saleNet(total) {
    if (!whole(total) || total <= 0) return null;
    const listing = listingFee(total), exchange = exchangeFee(total);
    return { total, listing, exchange, net: total - listing - exchange };
  }

  /**
   * The break-even listing price for one unit that cost `cost`: the lowest price at which listing it would give back
   * at least `cost` after both fees, by proceeds() itself (so the same fees and rounding). What a listing gives never
   * falls as its price rises: the 5% fee steps up only at prices of 10 copper mod 20 and the 10% fee only at 5 mod 10,
   * never on the same copper. So the first price that covers the cost is the answer. breakEven(cost + 1) is the
   * lowest price that gives back at least 1 copper more than the cost. null for a cost that is not a whole, positive
   * number of copper, or one too large to work out in exact whole numbers (far above any Trading Post price).
   */
  const breakEven = (cost) => breakEvenFor(cost, 1);

  /**
   * breakEven for `units` (1 to MAX_UNITS, one transaction) that cost `cost` together: the lowest price for each at
   * which listing them all in one transaction gives back at least that. The same reasoning holds: a price one copper
   * higher adds `units` copper to the total and never as much to the two fees.
   */
  function breakEvenFor(cost, n) {
    if (!whole(cost) || cost <= 0 || !whole(n) || n < 1 || n > MAX_UNITS) return null;
    const keep = 100 - LISTING_PCT - EXCHANGE_PCT;
    let p = Math.max(1, Math.floor((cost * 100) / (keep * n)) - 2);
    if (!whole(cost * 100) || !whole(p * n * 100)) return null;
    while (proceeds(p, n).net < cost) p++;
    while (p > 1 && proceeds(p - 1, n).net >= cost) p--;
    return p;
  }

  // ---- The order book and a number of units (v0.5.0) ----
  //
  // /v2/commerce/listings gives each side as price levels { unit_price, quantity, listings }: buy orders from the
  // highest price down, sell listings from the lowest up. Real answers repeat a level here and there (seen near
  // every 200th level on 2026-11-18), and a repeat can stand where another level should have been. So a side is
  // cleaned before anything is counted, and what was wrong with it is kept, never hidden: `repeats` (rows left out
  // because their price was already there), `sure` (how many levels from the best price come before the first
  // repeat; past them a level may be missing), `unsorted` (the rows were not in order) and `dropped` (rows that
  // could not be read at all).

  const level = (r) => Boolean(r) && whole(r.unit_price) && r.unit_price > 0 && whole(r.quantity) && r.quantity > 0;

  /**
   * One side of an order book, ready to walk: { side, levels: [{ price, quantity, orders }], depth, repeats, sure,
   * unsorted, dropped }. side: 'buys' (the best price is the highest) or 'sells' (the lowest). Rows that are not a
   * price level are left out and counted in `dropped`, together with the `dropped` given (rows the caller left out).
   */
  function cleanSide(rows, side, dropped) {
    const buys = side === 'buys';
    const list = Array.isArray(rows) ? rows : [];
    const good = list.filter(level);
    let unsorted = false;
    for (let i = 1; i < good.length; i++) if (buys ? good[i].unit_price > good[i - 1].unit_price : good[i].unit_price < good[i - 1].unit_price) unsorted = true;
    // A stable sort: rows of one price stay in the order the API gave them, so the first is the one kept.
    const sorted = unsorted ? good.slice().sort((a, b) => (buys ? b.unit_price - a.unit_price : a.unit_price - b.unit_price)) : good;
    const levels = [];
    let repeats = 0, sure = -1, depth = 0;
    for (const r of sorted) {
      if (levels.length && levels[levels.length - 1].price === r.unit_price) { repeats++; if (sure < 0) sure = levels.length; continue; }
      levels.push({ price: r.unit_price, quantity: r.quantity, orders: whole(r.listings) && r.listings > 0 ? r.listings : null });
      depth += r.quantity;
    }
    const given = whole(dropped) && dropped > 0 ? dropped : 0;
    const unread = Array.isArray(rows) ? list.length - good.length : rows === undefined || rows === null ? 0 : 1;
    return { side: buys ? 'buys' : 'sells', levels, depth, repeats, sure: sure < 0 ? levels.length : sure, unsorted, dropped: given + unread };
  }

  /**
   * Taking `n` units from a cleaned side, best price first: { asked, filled, short, total, best, worst, fills:
   * [{ price, take, of, orders }], uncertain }. short is how many of the n the side does not hold. uncertain: the
   * walk went past the levels that are sure, or found too few units in a side that had repeats, or the rows were out
   * of order, or some could not be read: its numbers may be off. null for an n that is not a whole number from 1 to
   * MAX_UNITS, or for something that is not a cleaned side.
   */
  function walk(side, n) {
    if (!side || !Array.isArray(side.levels) || !whole(n) || n < 1 || n > MAX_UNITS) return null;
    const fills = [];
    let left = n, total = 0;
    for (const l of side.levels) {
      if (left <= 0) break;
      const take = Math.min(left, l.quantity);
      fills.push({ price: l.price, take, of: l.quantity, orders: l.orders });
      total += take * l.price;
      left -= take;
    }
    const uncertain = fills.length > side.sure || (left > 0 && side.repeats > 0) || side.unsorted || side.dropped > 0;
    return { asked: n, filled: n - left, short: left, total, best: fills.length ? fills[0].price : null, worst: fills.length ? fills[fills.length - 1].price : null, fills, uncertain };
  }

  /** Depth near the best price counts the price levels within this many percent of a side's best price (v0.5.0 Phase 3). */
  const NEAR_PCT = 5;

  /**
   * What a cleaned side holds near its best price: the units queued at prices within NEAR_PCT% of it, as the order
   * book showed them. Observed depth, never a promise that this many can be bought or sold. Returns { side, best,
   * limit, units, prices, uncertain }: limit is the farthest price that counts, in whole copper, both ends included
   * (sell listings: at most 5% above the lowest, rounded down; buy orders: at least 5% below the highest, rounded up,
   * so a price is never counted that lies past 5%); units and prices are the units and price levels from the best
   * price to the limit. uncertain, by the walk's own rules: the rows were out of order or some could not be read, or
   * the side has a repeated row (where a level may be missing, right after the last sure level) and that place still
   * lies inside the range, so a missing level could hold units that belong here. null for a side with no levels.
   */
  function near(side) {
    if (!side || !Array.isArray(side.levels) || !side.levels.length) return null;
    const buys = side.side === 'buys', best = side.levels[0].price;
    // Both exact: best x 95 and best x 105 are whole numbers far inside exact arithmetic.
    const limit = buys ? Math.ceil((best * (100 - NEAR_PCT)) / 100) : Math.floor((best * (100 + NEAR_PCT)) / 100);
    let units = 0, prices = 0;
    for (const l of side.levels) {
      if (buys ? l.price < limit : l.price > limit) break;
      units += l.quantity;
      prices++;
    }
    const edge = side.repeats > 0 ? side.levels[side.sure - 1] : null;
    const gap = Boolean(edge) && (buys ? edge.price > limit : edge.price < limit);
    return { side: buys ? 'buys' : 'sells', best, limit, units, prices, uncertain: Boolean(side.unsorted) || side.dropped > 0 || gap };
  }

  /**
   * A total over a number of units as a price for each, in whole copper: { value, exact }. A cost is rounded up and
   * proceeds down (`up`), so the rounding never flatters; exact says no rounding was needed.
   */
  function average(total, units, up) {
    if (!whole(total) || !whole(units) || units < 1) return null;
    return { value: up ? Math.ceil(total / units) : Math.floor(total / units), exact: total % units === 0 };
  }

  /**
   * What selling into the buy orders a walk took would leave after fees, two ways, because ArenaNet does not publish
   * which applies when a sale crosses several prices: `whole`, both fees worked out once on the whole sale, and
   * `byLevel`, both fees worked out on each price's part of it. Each is { total, listing, exchange, net }. `differ`
   * says the two nets are not the same; `low` and `high` are the smaller and the larger net. Two estimates, not
   * limits: the game's own rounding is not published either. null for a walk that took nothing.
   */
  function sellFees(w) {
    if (!w || !Array.isArray(w.fills) || !w.fills.length) return null;
    const all = saleNet(w.total);
    if (!all) return null;
    const byLevel = { total: w.total, listing: 0, exchange: 0, net: 0 };
    for (const f of w.fills) { const s = saleNet(f.take * f.price); byLevel.listing += s.listing; byLevel.exchange += s.exchange; byLevel.net += s.net; }
    return { whole: all, byLevel, differ: all.net !== byLevel.net, low: Math.min(all.net, byLevel.net), high: Math.max(all.net, byLevel.net) };
  }

  /**
   * Every figure the quantity calculator shows, for `n` units of one item, from its cleaned order book alone
   * ({ buys, sells } of cleanSide) and the reader's two choices:
   *   way.get   'now'   buy at once from the sell listings, lowest first (no fee), or
   *             'order' place a buy order at the book's highest buy order: paid at once, filled only if someone sells;
   *   way.give  'now'   sell at once to the buy orders, highest first (both fees), or
   *             'list'  list at the book's lowest sell listing: both fees, paid out only if someone buys.
   * Returns { n, bid, ask, buyNow, sellNow, order, list, get, give, cost, back, gain, roi, breakEven, why, executable,
   * uncertain }:
   *   buyNow    the walk of the sell listings, with avg; sellNow: the walk of the buy orders, with fees (sellFees) and avg
   *   order     { price, total }; list: { price, total, listing, exchange, net }
   *   cost      what getting the n units takes, or null; back: { low, high }, what giving them brings after fees
   *             (they differ only when the two fee estimates do); gain: { low, high } = back - cost
   *   roi       { low, high }: gain as a share of cost (fractions)
   *   breakEven give 'list': { kind: 'list', price }, the lowest listing price for each that gives back the cost;
   *             give 'now':  { kind: 'now', low, high }, the most each unit may have cost (back / n, rounded down)
   *   why       when there is no cost or nothing back: 'no-sells', 'short-sells', 'no-buys' or 'short-buys'
   *   executable  both legs happen at once (so they depend only on the book still being as it was reported)
   * A leg the book cannot fill in full gives no cost, proceeds, gain or break-even: nothing is made up for the rest.
   * null for an n that is not a whole number from 1 to MAX_UNITS.
   */
  function plan(book, n, way) {
    if (!book || !whole(n) || n < 1 || n > MAX_UNITS) return null;
    const get = way && way.get === 'order' ? 'order' : 'now', give = way && way.give === 'list' ? 'list' : 'now';
    const top = (s) => (s && Array.isArray(s.levels) && s.levels.length ? s.levels[0].price : null);
    const bid = top(book.buys), ask = top(book.sells);
    const buyNow = walk(book.sells, n), sellNow = walk(book.buys, n);
    if (buyNow) buyNow.avg = buyNow.filled ? average(buyNow.total, buyNow.filled, true) : null;
    if (sellNow) { sellNow.fees = sellFees(sellNow); sellNow.avg = sellNow.filled ? average(sellNow.total, sellNow.filled, false) : null; }
    const order = bid === null ? null : { price: bid, total: bid * n };
    const list = ask === null ? null : Object.assign({ price: ask }, proceeds(ask, n));
    let cost = null, back = null, why = null;
    if (get === 'order') { if (order) cost = order.total; else why = 'no-buys'; }
    else if (!buyNow || !buyNow.filled) why = 'no-sells';
    else if (buyNow.short) why = 'short-sells';
    else cost = buyNow.total;
    if (give === 'list') { if (list) back = { low: list.net, high: list.net }; else why = why || 'no-sells'; }
    else if (!sellNow || !sellNow.filled) why = why || 'no-buys';
    else if (sellNow.short) why = why || 'short-buys';
    else back = { low: sellNow.fees.low, high: sellNow.fees.high };
    const gain = cost !== null && back !== null ? { low: back.low - cost, high: back.high - cost } : null;
    const roi = gain ? { low: gain.low / cost, high: gain.high / cost } : null;
    let even = null;
    if (give === 'list') { const price = cost === null ? null : breakEvenFor(cost, n); if (price !== null) even = { kind: 'list', price }; }
    else if (back !== null) even = { kind: 'now', low: Math.floor(back.low / n), high: Math.floor(back.high / n) };
    const uncertain = Boolean((get === 'now' && buyNow && buyNow.uncertain) || (give === 'now' && sellNow && sellNow.uncertain));
    return { n, bid, ask, buyNow, sellNow, order, list, get, give, cost, back, gain, roi, breakEven: even, why, executable: get === 'now' && give === 'now', uncertain };
  }

  /**
   * The numbers for one item's two best prices. A side with no orders has quantity 0 (the API's empty side
   * is { quantity: 0, unit_price: 0 }) and gives null, never a price of 0.
   *   buy, sell        the highest buy order and the lowest sell listing, or null
   *   spread           sell - buy, when both exist
   *   sellNow          proceeds of selling one unit to the highest buy order now
   *   listAtLowest     proceeds of listing one unit at the lowest sell listing, if it sells (not guaranteed)
   *   margin           listAtLowest.net - buy: buying at the highest buy order and listing at the lowest sell
   *                    listing; a potential margin, before undercutting and before either order fills
   *   marginPct        margin / buy, as a fraction: the potential margin as a share of the highest buy order, what
   *                    buying one unit costs (never a zero denominator: a side with no orders is null, not 0)
   *   breakEven        breakEven(buy): the lowest listing price that gives back the buy price after fees, or null
   */
  function quote(p) {
    const side = (s) => (s && whole(s.unit_price) && s.unit_price > 0 && whole(s.quantity) && s.quantity > 0 ? s.unit_price : null);
    const buy = side(p && p.buys), sell = side(p && p.sells);
    const sellNow = buy === null ? null : proceeds(buy);
    const listAtLowest = sell === null ? null : proceeds(sell);
    const margin = buy !== null && listAtLowest ? listAtLowest.net - buy : null;
    return {
      buy, sell,
      buyQty: buy === null ? 0 : p.buys.quantity,
      sellQty: sell === null ? 0 : p.sells.quantity,
      spread: buy !== null && sell !== null ? sell - buy : null,
      sellNow, listAtLowest, margin,
      marginPct: margin === null ? null : margin / buy,
      breakEven: buy === null ? null : breakEven(buy),
    };
  }

  const MINUS = String.fromCharCode(0x2212);
  const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /**
   * A copper amount as coins: { g, s, c, neg, text: "1g 05s 00c", spoken: "1 gold 5 silver" }. A unit after a
   * larger one has two digits; a negative amount starts with a real minus sign and is spoken as a loss.
   */
  function coins(copper) {
    if (!whole(copper)) return null;
    const neg = copper < 0, a = Math.abs(copper);
    const g = Math.floor(a / 10000), s = Math.floor((a % 10000) / 100), c = a % 100;
    const pad = (n, on) => (on ? String(n).padStart(2, '0') : String(n));
    const parts = [];
    if (g) parts.push(`${group(g)}g`);
    if (g || s) parts.push(`${pad(s, g > 0)}s`);
    parts.push(`${pad(c, g > 0 || s > 0)}c`);
    const words = [g ? `${group(g)} gold` : '', s ? `${s} silver` : '', c || (!g && !s) ? `${c} copper` : ''].filter(Boolean).join(' ');
    return { g, s, c, neg, text: (neg ? MINUS : '') + parts.join(' '), spoken: neg ? `a loss of ${words}` : words };
  }

  /**
   * A coin amount as a reader types it, in whole copper: "2g 50s 10c", "2g", "75s", "40c", "1,250g 5c", or a bare
   * number, which is copper. Gold, silver and copper each at most once and in that order; spaces and capitals do
   * not matter. { copper } for an amount; { empty: true } for nothing typed; { error: 'not-coins' } for anything
   * else (a fraction, a sign, a unit twice or out of order), and { error: 'too-large' } past what can be worked out
   * exactly. Never a guess at what was meant.
   */
  function parseCoins(text) {
    const t = String(text === undefined || text === null ? '' : text).trim().toLowerCase();
    if (!t) return { empty: true };
    let g = 0, s = 0, c = 0;
    if (/^\d{1,15}$/.test(t)) c = Number(t);
    else {
      const m = /^(?:(\d{1,3}(?:,\d{3})+|\d{1,9})\s*g)?\s*(?:(\d{1,9})\s*s)?\s*(?:(\d{1,9})\s*c)?$/.exec(t);
      if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined)) return { error: 'not-coins' };
      g = m[1] === undefined ? 0 : Number(m[1].replace(/,/g, ''));
      s = m[2] === undefined ? 0 : Number(m[2]);
      c = m[3] === undefined ? 0 : Number(m[3]);
    }
    const copper = g * 10000 + s * 100 + c;
    // 100,000,000 gold: far above any price, and far inside exact whole numbers.
    if (!whole(copper) || copper > 1e12) return { error: 'too-large' };
    return { copper };
  }

  /** A whole number with thousands separators ("2,219,204"); the page writes counts with it. */
  const count = (n) => (whole(n) ? (n < 0 ? '-' : '') + group(Math.abs(n)) : '');

  /** A fraction as a percent with one decimal ("12.5%"), with a real minus sign. */
  function percent(f) {
    if (typeof f !== 'number' || !Number.isFinite(f)) return '';
    const v = Math.round(Math.abs(f) * 1000) / 10;
    return `${f < 0 && v > 0 ? MINUS : ''}${v.toFixed(1)}%`;
  }

  const Money = { LISTING_PCT, EXCHANGE_PCT, MAX_UNITS, NEAR_PCT, fee, listingFee, exchangeFee, proceeds, saleNet, breakEven, breakEvenFor, cleanSide, walk, near, average, sellFees, plan, quote, coins, parseCoins, count, percent };
  if (typeof module === 'object' && module.exports) module.exports = Money;
  else root.GW2Money = Money;
})(typeof globalThis !== 'undefined' ? globalThis : this);
