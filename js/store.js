// Saved settings. Everything stays in this browser's localStorage under one prefix, because one
// origin (github.io, radmagelabs.com) serves several apps. Saved data is never trusted: it is
// checked against the current dataset on every load, so a stale or edited value falls back to the
// default instead of breaking the page.
(function (root) {
  'use strict';

  const PREFIX = 'gw2-timer:v1:';
  const FILTERS = ['all', 'world-boss', 'meta', 'starred'];
  const AHEAD = [60, 120, 240, 480];
  const THEMES = ['dark', 'light', 'system'];

  function defaults(regionIds) {
    return { filter: 'all', regions: regionIds.slice(), starred: [], hidden: [], aheadMin: 120, compact: false, showUtc: true, theme: 'dark', news: true };
  }

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
  const idList = (v, known) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && known.has(x)))] : []);

  /** Saved preferences, cleaned against the dataset's event and region ids. */
  function sanitizePrefs(raw, eventIds, regionIds) {
    const d = defaults(regionIds);
    if (!isObj(raw)) return d;
    const events = new Set(eventIds), regions = new Set(regionIds);
    return {
      filter: pick(raw.filter, FILTERS, d.filter),
      regions: Array.isArray(raw.regions) ? idList(raw.regions, regions) : d.regions,
      starred: idList(raw.starred, events),
      hidden: idList(raw.hidden, events),
      aheadMin: pick(raw.aheadMin, AHEAD, d.aheadMin),
      compact: raw.compact === true,
      showUtc: raw.showUtc !== false,
      theme: pick(raw.theme, THEMES, d.theme),
      news: raw.news !== false,
    };
  }

  /** Saved start-time overrides: only for adjustable "every" events, with a whole-minute offset inside the period. */
  function sanitizeOverrides(raw, events) {
    const out = {};
    if (!isObj(raw)) return out;
    for (const e of events) {
      const o = raw[e.id];
      if (!e.adjustable || e.schedule.type !== 'every' || !isObj(o)) continue;
      if (Number.isInteger(o.offsetMin) && o.offsetMin >= 0 && o.offsetMin < e.schedule.periodMin) {
        out[e.id] = { offsetMin: o.offsetMin, setAt: Number.isFinite(o.setAt) ? o.setAt : 0 };
      }
    }
    return out;
  }

  // localStorage can be missing or throw (private windows, blocked storage); the page still works.
  function read(storage, key) {
    try { const s = storage && storage.getItem(PREFIX + key); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function write(storage, key, value) {
    try { storage.setItem(PREFIX + key, JSON.stringify(value)); return true; } catch (e) { return false; }
  }

  const Store = { PREFIX, FILTERS, AHEAD, THEMES, defaults, sanitizePrefs, sanitizeOverrides, read, write };
  if (typeof module === 'object' && module.exports) module.exports = Store;
  else root.GW2Store = Store;
})(typeof globalThis !== 'undefined' ? globalThis : this);
