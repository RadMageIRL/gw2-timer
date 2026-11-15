// Requests to ArenaNet's public Guild Wars 2 API, for the Trading Post. Loaded only when the Trading Post is
// opened. No key, no cookies, no referrer: plain GETs with nothing of the reader's.
//
// Every request goes through one queue that keeps well under the documented limits (wiki "API:Best practices":
// a bucket of 300 per IP, refilled at 5 a second, then HTTP 429): at most `concurrency` requests in flight and
// a token bucket of `perSec` a second with a burst of `burst`. Ids go in batches of 200, the API's own limit.
// A request that times out, fails on the network, or is answered 429 or 5xx is tried again after a wait (2, 4,
// then 8 seconds); a 429 also holds the whole queue for that wait. A 429 may come without CORS headers, so a
// page sees it only as a network error: both are treated the same. Nothing here throws into the page: every
// answer is { ok: true, data } or { ok: false, error }, and nothing is ever made up when the API does not answer.
//
// createClient() takes its fetch, clock and timers, so the Node tests drive it on a fake clock.
(function (root) {
  'use strict';

  const BASE = 'https://api.guildwars2.com';
  /** The schema version the page was written against (the newest in /v2.json on 2026-11-15). A header would need a preflight, which the API refuses. */
  const SCHEMA = '2025-08-29T01:00:00Z';
  const BATCH = 200;
  const DEFAULTS = { perSec: 4, burst: 20, concurrency: 4, timeoutMs: 8000, backoff: [2000, 4000, 8000] };
  /** The errors, worst first: the one a batch of requests reports is the worst of its parts. */
  const ERRORS = ['rate-limited', 'network', 'timeout', 'server', 'http', 'bad-data', 'aborted'];

  const chunks = (ids) => { const s = [...new Set(ids)].filter((x) => Number.isSafeInteger(x) && x > 0).sort((a, b) => a - b); const out = []; for (let i = 0; i < s.length; i += BATCH) out.push(s.slice(i, i + BATCH)); return out; };
  const worst = (a, b) => (!a ? b : !b ? a : ERRORS.indexOf(a) <= ERRORS.indexOf(b) ? a : b);

  function createClient(options) {
    const o = Object.assign({}, DEFAULTS, options || {});
    if (typeof o.fetch !== 'function') throw new Error('createClient needs fetch');
    const now = o.now || (() => Date.now());
    const later = o.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    const cancel = o.clearTimeout || ((t) => clearTimeout(t));
    const queue = [];
    let inFlight = 0, tokens = o.burst, filled = now(), pausedUntil = 0, wake = null, wakeAt = 0;
    const stats = { started: 0, maxInFlight: 0, retries: 0, rateLimited: 0 };

    function refill() {
      const t = now();
      tokens = Math.min(o.burst, tokens + ((t - filled) * o.perSec) / 1000);
      filled = t;
    }
    function schedule(at) {
      if (wake && wakeAt <= at) return;
      if (wake) cancel(wake);
      wakeAt = at;
      wake = later(() => { wake = null; pump(); }, Math.max(0, at - now()));
    }
    function pump() {
      while (queue.length && inFlight < o.concurrency) {
        const t = now();
        if (t < pausedUntil) { schedule(pausedUntil); return; }
        refill();
        if (tokens < 1) { schedule(t + Math.ceil(((1 - tokens) * 1000) / o.perSec)); return; }
        const job = queue.shift();
        if (job.signal && job.signal.aborted) { job.done({ ok: false, error: 'aborted' }); continue; }
        tokens -= 1;
        inFlight++;
        stats.started++;
        stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
        attempt(job).then((r) => { inFlight--; job.settle(r); pump(); });
      }
    }

    /** One try: resolves { ok, status, data, partial } or { ok: false, error, status, retry }. */
    function attempt(job) {
      return new Promise((resolve) => {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        let finished = false, timedOut = false;
        const end = (r) => { if (finished) return; finished = true; cancel(timer); if (job.signal) job.signal.removeEventListener('abort', onAbort); resolve(r); };
        const timer = later(() => { timedOut = true; if (ctl) ctl.abort(); end({ ok: false, error: 'timeout', retry: true }); }, o.timeoutMs);
        const onAbort = () => { if (ctl) ctl.abort(); end({ ok: false, error: 'aborted' }); };
        if (job.signal) job.signal.addEventListener('abort', onAbort);
        let req;
        try { req = o.fetch(job.url, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined }); } catch (e) { end({ ok: false, error: 'network', retry: true }); return; }
        Promise.resolve(req).then(async (res) => {
          const status = res.status;
          if (status === 429) { stats.rateLimited++; end({ ok: false, error: 'rate-limited', status, retry: true }); return; }
          if (status >= 500) { end({ ok: false, error: 'server', status, retry: true }); return; }
          let body;
          try { body = await res.json(); } catch (e) { end(timedOut || (job.signal && job.signal.aborted) ? { ok: false, error: timedOut ? 'timeout' : 'aborted' } : { ok: false, error: 'bad-data', status }); return; }
          if (status === 200 || status === 206) end({ ok: true, status, data: body, partial: status === 206 });
          else if (status === 404) end({ ok: true, status, data: null, notFound: true });
          else end({ ok: false, error: 'http', status });
        }, () => { end(job.signal && job.signal.aborted ? { ok: false, error: 'aborted' } : { ok: false, error: 'network', retry: true }); });
      });
    }

    /** A GET of `path` with `params`, through the queue, tried again as described above. */
    function get(path, params, opts) {
      const signal = opts && opts.signal;
      const q = Object.entries(Object.assign({}, params, { v: SCHEMA })).map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%2C/g, ',')}`).join('&');
      const url = `${o.base || BASE}${path}?${q}`;
      return new Promise((resolve) => {
        let tries = 0;
        const job = { url, signal, done: resolve };
        job.settle = (r) => {
          if (r.ok || !r.retry || tries >= o.backoff.length || (signal && signal.aborted)) { const { retry, ...out } = r; resolve(out); return; }
          const wait = o.backoff[tries++];
          stats.retries++;
          if (r.error === 'rate-limited') pausedUntil = Math.max(pausedUntil, now() + wait);
          if (o.onRetry) o.onRetry({ error: r.error, wait, pausedUntil });
          later(() => { if (signal && signal.aborted) { resolve({ ok: false, error: 'aborted' }); return; } queue.push(job); pump(); }, wait);
        };
        if (signal && signal.aborted) { resolve({ ok: false, error: 'aborted' }); return; }
        // Cancelled while waiting: out of the queue at once, so it never takes a request.
        if (signal) signal.addEventListener('abort', () => { const k = queue.indexOf(job); if (k >= 0) queue.splice(k, 1); resolve({ ok: false, error: 'aborted' }); }, { once: true });
        queue.push(job);
        pump();
      });
    }

    /**
     * Rows for many ids from a batch endpoint, 200 ids a request:
     *   { rows: Map(id -> row), missing: Set(ids the API answered it has no row for), failed: [ids with no usable
     *     answer], errors: Map(failed id -> its error), error (the worst error, or null), requests, answered }
     * An id is missing only when the API says so: a 404 (none of the ids has a row) or a readable list without
     * it. A malformed row, a row that cannot be told apart, or a body that is not a list is 'bad-data' for its
     * ids, never "missing". onBatch(progress) is called after each request with { requests, done, answered, failed }.
     */
    async function many(path, ids, params, check, opts) {
      const parts = chunks(ids);
      const rows = new Map(), missing = new Set(), failed = [], errors = new Map();
      let error = null, done = 0, answered = 0;
      const fail = (list, why) => { for (const id of list) { failed.push(id); errors.set(id, why); } error = worst(error, why); };
      await Promise.all(parts.map(async (part) => {
        const r = await get(path, Object.assign({ ids: part.join(',') }, params), opts);
        done++;
        if (r.ok && (r.notFound || Array.isArray(r.data))) {
          answered++;
          const list = r.notFound ? [] : r.data, at = now(), seen = new Set();
          let junk = false;
          for (const row of list) {
            const id = row && row.id;
            if (!Number.isSafeInteger(id) || !part.includes(id)) { junk = true; continue; }
            seen.add(id);
            if (check(row)) rows.set(id, Object.assign({ at }, row));
          }
          const bad = part.filter((id) => !rows.has(id) && (seen.has(id) || junk));
          for (const id of part) if (!rows.has(id) && !bad.includes(id)) missing.add(id);
          if (bad.length) fail(bad, 'bad-data');
        } else fail(part, r.ok ? 'bad-data' : r.error);
        if (opts && opts.onBatch) opts.onBatch({ requests: parts.length, done, answered, failed: failed.length });
      }));
      return { rows, missing, failed, errors, error, requests: parts.length, answered };
    }

    const side = (s) => s && Number.isSafeInteger(s.unit_price) && s.unit_price >= 0 && Number.isSafeInteger(s.quantity) && s.quantity >= 0;
    const priceRow = (r) => r && Number.isSafeInteger(r.id) && side(r.buys) && side(r.sells);
    const itemRow = (r) => r && Number.isSafeInteger(r.id) && typeof r.name === 'string';
    const tier = (t) => t && Number.isSafeInteger(t.unit_price) && t.unit_price > 0 && Number.isSafeInteger(t.quantity) && t.quantity > 0 && Number.isSafeInteger(t.listings);

    return {
      get,
      /** The best buy order and sell listing of each id (/v2/commerce/prices). */
      prices: (ids, opts) => many('/v2/commerce/prices', ids, {}, priceRow, opts),
      /** Item records (/v2/items, English): icon, description, vendor value, chat code, flags. */
      items: (ids, opts) => many('/v2/items', ids, { lang: 'en' }, itemRow, opts),
      /** One item's order book (/v2/commerce/listings): { ok, book: { buys, sells, at } }, { ok, notFound } or { ok: false, error }. */
      async listings(id, opts) {
        if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: 'http' };
        const r = await get('/v2/commerce/listings', { id }, opts);
        if (!r.ok) return r;
        if (r.notFound || !r.data) return { ok: true, notFound: true };
        const list = (a) => (Array.isArray(a) ? a.filter(tier) : []);
        return { ok: true, book: { buys: list(r.data.buys), sells: list(r.data.sells), at: now() } };
      },
      /** How many requests a set of ids takes. */
      requestsFor: (ids) => chunks(ids).length,
      stats: () => Object.assign({ inFlight, queued: queue.length, pausedUntil }, stats),
      /** True while a 429 holds the queue. */
      paused: () => now() < pausedUntil,
    };
  }

  const Api = { BASE, SCHEMA, BATCH, DEFAULTS, ERRORS, createClient, chunks };
  if (typeof module === 'object' && module.exports) module.exports = Api;
  else root.GW2Api = Api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
