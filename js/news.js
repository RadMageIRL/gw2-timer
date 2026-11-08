// Latest news from ArenaNet's official RSS feed. The feed allows cross-origin reads, so the page reads
// it directly; nothing goes through a RadMage Labs server. Only titles, links and dates are used,
// always as plain text, and only links back to guildwars2.com are kept. Parsing is a pure function so
// the Node tests can check it.
(function (root) {
  'use strict';

  const FEED_URL = 'https://www.guildwars2.com/en/feed/';
  const NEWS_HOST = 'www.guildwars2.com';
  const MAX_ITEMS = 5;
  const SHOWN = 3; // headlines shown until the reader asks for all of them
  const REFRESH_MS = 30 * 60000; // the feed itself is cached for 15 minutes upstream
  const TIMEOUT_MS = 8000;

  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', ndash: '-', mdash: ' - ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
  // Built from code points so that no dash character sits in this file.
  const EM_DASH = String.fromCharCode(0x2014), EN_DASH = String.fromCharCode(0x2013);

  function decode(s) {
    return s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
  }
  // Control characters are dropped. Dashes pass through here and become hyphens in dashes() below,
  // which also catches dashes typed straight into the feed.
  function safeChar(code) {
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  }
  const tag = (block, name) => {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    return m ? m[1] : '';
  };
  // Titles are text: any markup inside is removed, then control and direction-override characters
  // (which could make a title read differently from what it is), then whitespace is collapsed.
  // Every dash, typed or written as an entity, becomes a hyphen: an em dash with spaces around it, so
  // "A&#8212;B" reads "A - B", an en dash without, so "3&#8211;10" reads "3-10".
  const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
  const dashes = (s) => s.split(EM_DASH).join(' - ').split(EN_DASH).join('-');
  const plain = (s) => dashes(s).replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim();
  const text = (s) => plain(decode(decode(s).replace(/<[^>]*>/g, '')));

  /** A guildwars2.com https link without tracking parameters, or null for anything else. */
  function cleanLink(raw) {
    let u;
    try { u = new URL(decode(raw).trim()); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.hostname !== NEWS_HOST) return null;
    for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  }

  /** The newest items of an RSS document: [{ title, link, dateMs }]. Items without a usable title or link are skipped. */
  function parseFeed(xml, max) {
    const items = [];
    const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
    const doc = String(xml).replace(/<!--[\s\S]*?-->/g, ''); // a commented-out item is not an item
    let m;
    while ((m = re.exec(doc)) && items.length < (max || MAX_ITEMS)) {
      const title = text(tag(m[1], 'title')).slice(0, 200);
      const link = cleanLink(tag(m[1], 'link'));
      const dateMs = Date.parse(text(tag(m[1], 'pubDate')));
      if (title && link) items.push({ title, link, dateMs: Number.isFinite(dateMs) ? dateMs : null });
    }
    return items;
  }

  /** A cached copy is used as is while it is younger than REFRESH_MS. */
  const isFresh = (cache, nowMs) => Boolean(cache && Number.isFinite(cache.fetchedAt) && nowMs - cache.fetchedAt < REFRESH_MS && nowMs >= cache.fetchedAt);

  /** A cached copy read back from storage: kept only if it still looks like what parseFeed returns. */
  function sanitizeCache(raw) {
    if (!raw || !Number.isFinite(raw.fetchedAt) || !Array.isArray(raw.items)) return null;
    // Titles saved by an earlier version get the same cleaning as fresh ones (dashes, control characters).
    const items = raw.items.filter((i) => i && typeof i.title === 'string' && plain(i.title) && typeof i.link === 'string' && cleanLink(i.link) === i.link)
      .slice(0, MAX_ITEMS).map((i) => ({ title: plain(i.title).slice(0, 200), link: i.link, dateMs: Number.isFinite(i.dateMs) ? i.dateMs : null }));
    return items.length ? { fetchedAt: raw.fetchedAt, items } : null;
  }

  const News = { FEED_URL, NEWS_HOST, MAX_ITEMS, SHOWN, REFRESH_MS, TIMEOUT_MS, parseFeed, cleanLink, isFresh, sanitizeCache };
  if (typeof module === 'object' && module.exports) module.exports = News;
  else root.GW2News = News;
})(typeof globalThis !== 'undefined' ? globalThis : this);
