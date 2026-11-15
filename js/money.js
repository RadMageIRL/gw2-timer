// Trading Post money: coins, fees and margins, all in whole copper. Pure, so the page and the Node tests
// share it. Loaded only when the Trading Post is opened.
//
// The fees are ArenaNet's, as the Guild Wars 2 Wiki documents them (page "Trading Post", read 2026-11-15):
// a listing fee of 5% "immediately taken ... when you list or instantly sell", and an exchange fee of 10%
// "deducted from coins delivered to the seller", each "based on the total sale price" with "a minimum of 1".
// How a fraction of a copper is rounded is NOT documented. This module rounds each fee to the nearest copper,
// half up, on the transaction's total, and the page calls every result an estimate (decision D5, manual
// check M1 in the Phase A report).
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
    const total = price * n, listing = listingFee(total), exchange = exchangeFee(total);
    return { total, listing, exchange, net: total - listing - exchange };
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
   *   marginPct        margin / buy, as a fraction
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

  /** A whole number with thousands separators ("2,219,204"); the page writes counts with it. */
  const count = (n) => (whole(n) ? (n < 0 ? '-' : '') + group(Math.abs(n)) : '');

  /** A fraction as a percent with one decimal ("12.5%"), with a real minus sign. */
  function percent(f) {
    if (typeof f !== 'number' || !Number.isFinite(f)) return '';
    const v = Math.round(Math.abs(f) * 1000) / 10;
    return `${f < 0 && v > 0 ? MINUS : ''}${v.toFixed(1)}%`;
  }

  const Money = { LISTING_PCT, EXCHANGE_PCT, MAX_UNITS, fee, listingFee, exchangeFee, proceeds, quote, coins, count, percent };
  if (typeof module === 'object' && module.exports) module.exports = Money;
  else root.GW2Money = Money;
})(typeof globalThis !== 'undefined' ? globalThis : this);
