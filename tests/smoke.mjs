// Browser tests on the built site (dist/, from node tools/build.mjs), in headless Chrome over the
// DevTools protocol with no dependencies. Each check opens a fresh tab with a simulated clock and time
// zone; the news feed is answered from a fixture, failed, or cut off, so no test reaches ArenaNet.
//
//   node tests/smoke.mjs [--dir dist] [--only <part of a check name>] [--shots <folder>]
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { launchChrome } from './lib/cdp.mjs';
import { serve } from '../tools/serve.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : d; };
const DIR = resolve(ROOT, opt('dir', 'dist'));
const ONLY = opt('only', '');
const SHOTS = opt('shots', null);
if (!existsSync(join(DIR, 'index.html'))) { console.error(`No site in ${DIR}: run node tools/build.mjs first.`); process.exit(1); }

const DATA = createRequire(import.meta.url)(join(DIR, 'events-data.js'));
const fmtDay = (iso) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(iso + 'T12:00:00Z'));
const S = createRequire(import.meta.url)(join(DIR, 'js', 'schedule.js'));
const FEED = readFileSync(join(ROOT, 'tests', 'fixtures', 'news-feed.xml'), 'utf8');
const HOSTILE = readFileSync(join(ROOT, 'tests', 'fixtures', 'news-feed-hostile.xml'), 'utf8');
// Built here because no project file may hold an em dash: real ArenaNet titles do (November 2026).
const DASH_FEED = `<rss><channel><item><title>Announcing Guild Wars Afterlife${String.fromCharCode(0x2014)}Prepurchase Available Now!</title><link>https://www.guildwars2.com/en/news/afterlife/</link><pubDate>Tue, 03 Nov 2026 16:00:00 +0000</pubDate></item>`
  + `<item><title>Festival Nov 3${String.fromCharCode(0x2013)}10</title><link>https://www.guildwars2.com/en/news/festival/</link></item></channel></rss>`;
// Titles as long as ArenaNet's usually are (40 to 66 characters in November 2026), for the layout checks.
const LONG_FEED = '<rss><channel>' + ['Announcing the Example Expansion: Prepurchase Available Today', 'Example Living World Seasons Now Come with Every Expansion Pack',
  'The Example Autumn Festival 2026 Is Now Live', 'Support the Example Charity Team This November', 'Try the New Example Borderlands Map in a Weekend Beta on Nov 10']
  .map((t, i) => `<item><title>${t}</title><link>https://www.guildwars2.com/en/news/example-${i}/</link><pubDate>Tue, 0${i + 1} Nov 2026 16:00:00 +0000</pubDate></item>`).join('') + '</channel></rss>';
const VERSION = /^## v(\d+\.\d+\.\d+) /m.exec(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))[1];
const FEED_URL = 'https://www.guildwars2.com/en/feed/';
const utc = (iso) => Date.parse(iso);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EV = new Map(DATA.events.map((e) => [e.id, e]));

const { server, port } = await serve(DIR, 0, { sendDate: false });
const { server: dated, port: datedPort } = await serve(DIR, 0, { sendDate: true });
// A server whose Date header is `skewMs` away from this machine's clock: the "true" time for a page's
// clock check, set per check (reminders, v0.3.0 Phase E).
const { server: skewed, port: skewedPort } = await serve(DIR, 0, { sendDate: false });
let skewMs = 0;
skewed.prependListener('request', (req, res) => res.setHeader('Date', new Date(Date.now() + skewMs).toUTCString()));
const SKEWED = `http://127.0.0.1:${skewedPort}/`;
const BASE = `http://127.0.0.1:${port}/`;
const chrome = await launchChrome();
await chrome.grant(BASE.slice(0, -1), ['clipboardReadWrite', 'clipboardSanitizedWrite']);

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/**
 * A fresh tab: storage cleared, a simulated clock and zone, and the news feed answered by `news.mode`.
 * Since v0.3.0 Phase E also: `offset`, a fixed amount added to this machine's clock (tabs given the same
 * offset read the same time, to the millisecond); `seed`, storage keys written before the page first
 * loads (not again on a reload); `init`, scripts run before the page's own in every load; and `clock`:
 * 'fail' makes the page's clock check fail at once (unavailable), 'hold' leaves it unanswered.
 */
async function open({ at, offset, tz = 'America/Chicago', width = 1280, height = 900, mobile = false, news = { mode: 'fixture' }, url = BASE, keepStorage = false, seed = null, init = [], clock = null, api = null, local = null, wait = true } = {}) {
  const page = await chrome.newPage();
  const origin = /^https?:/.test(url) ? new URL(url).origin : BASE.slice(0, -1);
  if (!keepStorage) await page.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
  await page.emulate({ timezone: tz, locale: 'en-US' });
  await page.viewport(width, height, mobile);
  if (at) await page.startClockAt(at);
  else if (offset !== undefined) await page.beforeLoad(`(() => { const real = Date.now; Date.now = () => real() + ${Number(offset)}; })();`);
  if (seed && Object.keys(seed).length) {
    const writes = Object.entries(seed).map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === 'string' ? v : JSON.stringify(v))});`).join(' ');
    await page.beforeLoad(`try { if (!sessionStorage.getItem('gw2-test-seeded')) { ${writes} sessionStorage.setItem('gw2-test-seeded', '1'); } } catch (e) {}`);
  }
  for (const source of init) await page.beforeLoad(source);
  page.newsRequests = 0; page.clockRequests = 0; page.apiRequests = []; page.iconRequests = 0;
  // Since v0.4.0 every tab also answers ArenaNet's API and its icon server itself (the Trading Post): with `api`,
  // a handler of tests/smoke-market.mjs; without one, any API request is recorded and refused, so a check that
  // never opens the Trading Post can prove it asked the API for nothing.
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.guildwars2.com/*' }, { urlPattern: 'https://api.guildwars2.com/*' }, { urlPattern: 'https://render.guildwars2.com/*' }, ...(clock ? [{ urlPattern: '*clock=*' }] : []), ...(local ? local.patterns.map((urlPattern) => ({ urlPattern })) : [])] });
  page.on('Fetch.requestPaused', async (p) => {
    // `local`: this site's own files a check answers itself (the Trading Post's code and item list).
    if (local && local.patterns.some((x) => p.request.url.includes(x.split('*').join('')))) { await local.handler(page, p); return; }
    if (p.request.url.startsWith('https://api.guildwars2.com/')) {
      page.apiRequests.push(p.request.url);
      // A page a check has already closed can no longer be answered: that is fine (Market Watch's icons may still be on their way).
      if (api) await api(page, p); else await page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      return;
    }
    if (p.request.url.startsWith('https://render.guildwars2.com/')) {
      page.iconRequests++;
      await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, body: ICON_PNG, responseHeaders: [{ name: 'Content-Type', value: 'image/png' }, { name: 'Access-Control-Allow-Origin', value: '*' }] }).catch(() => {});
      return;
    }
    if (/[?&]clock=/.test(p.request.url)) {
      page.clockRequests++;
      if (clock === 'fail') await page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' });
      return; // 'hold': never answered
    }
    page.newsRequests++;
    if (news.mode === 'hold') { page.held = p.requestId; return; }
    // fixture and hostile answer with a feed; garbage with an HTML error page; http500 with a server error.
    const answer = { fixture: [200, FEED], long: [200, LONG_FEED], hostile: [200, HOSTILE], dashes: [200, DASH_FEED], garbage: [200, '<html><body>Bad gateway</body></html>'], http500: [500, 'error'] }[news.mode];
    if (answer) {
      await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: answer[0], body: Buffer.from(answer[1]).toString('base64'),
        responseHeaders: [{ name: 'Content-Type', value: 'text/xml; charset=utf-8' }, { name: 'Access-Control-Allow-Origin', value: '*' }] });
    } else {
      await page.send('Fetch.failRequest', { requestId: p.requestId, errorReason: news.mode === 'offline' ? 'InternetDisconnected' : 'Failed' });
    }
  });
  await page.goto(url);
  if (wait) await page.waitFor("document.querySelectorAll('#next-list .row, #next-empty:not([hidden])').length > 0");
  return page;
}
// A 1 x 1 PNG for every item icon (render.guildwars2.com), so no check depends on ArenaNet's servers.
const ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const text = (page, sel) => page.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
const rows = (page) => page.eval("[...document.querySelectorAll('#next-list .row')].map((r) => ({ id: r.dataset.id, start: Number(r.dataset.start), t: r.querySelector('.t').textContent, utc: (r.querySelector('.utc') || {}).textContent || '' }))");
const cards = (page) => page.eval("[...document.querySelectorAll('#now-list .event')].map((c) => c.dataset.id)");
const click = (page, sel) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('no ' + ${JSON.stringify(sel)}); el.click(); return true; })()`);
const settle = () => sleep(150);
// Problems other than the ones a check provokes on purpose.
const unexpected = (page, allow = []) => page.problems.filter((p) => !allow.some((a) => a.test(p)));

// ---- Loading and what the page shows ----

check('desktop load at 23:50 UTC in Chicago: header, footer, Scheduled now and Coming up are right', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    assert.equal(await page.eval('document.title'), 'GW2 Timer | Unofficial Guild Wars 2 Fansite');
    assert.equal(await text(page, '.brand .tag'), `v${VERSION} · Guild Wars 2 Boss & Meta Timers · RadMage Labs`);
    assert.equal(await text(page, '#now-title'), 'Scheduled now');
    assert.equal(await text(page, '#revision'), `Schedule r${DATA.meta.datasetRevision} · reviewed ${fmtDay(DATA.meta.reviewedOn)}`);
    const now = await cards(page);
    for (const id of ['dragons-stand', 'shadow-behemoth', 'battle-for-the-jade-sea', 'secrets-of-the-weald']) assert.ok(now.includes(id), `${id} is in its window`);
    for (const id of ['claw-of-jormag', 'octovine', 'karka-queen']) assert.ok(!now.includes(id), `${id} window closed`);
    const r = await rows(page);
    assert.deepEqual(r.slice(0, 4).map((x) => x.id).sort(), ['admiral-taidha-covington', 'defense-of-amnytas', 'kaineng-blackout', 'tequatl-the-sunless']);
    assert.deepEqual([r[0].start, r[0].t, r[0].utc], [utc('2026-10-26T00:00:00Z'), '7:00 PM', '00:00 UTC']);
    assert.ok(r.every((x, i) => i === 0 || r[i - 1].start <= x.start), 'time order');
    assert.match(await text(page, '#strip'), /Daily reset7:00 PMin (10m 0\d|9m 5\d)s/);
    assert.match(await text(page, '#strip'), /Weekly resetMon 2:30 AM/);
    assert.match(await text(page, '.explain'), /no public live-event feed/);
    assert.match(await text(page, '#now-list .event[data-id="dragons-stand"] .since'), /^Started 6:30 PM · 23:30 UTC$/);
    assert.equal(await page.eval("/\\blive\\b/i.test([...document.querySelectorAll('main .badge, main h2, main h3, main .hint, main .countdown')].map((e) => e.textContent).join(' '))"), false, 'nothing is labeled live');
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

check('countdowns tick every second without rebuilding the lists', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.eval("window.__row = document.querySelector('#next-list .row')");
    const a = await text(page, '#next-list .row .in');
    await sleep(1300);
    const b = await text(page, '#next-list .row .in');
    assert.notEqual(a, b);
    assert.equal(await page.eval("window.__row === document.querySelector('#next-list .row')"), true, 'same row element');
  } finally { await page.close(); }
});

check('at midnight UTC the daily reset rolls over and the 00:00 events move into Scheduled now', async () => {
  const page = await open({ at: utc('2026-10-25T23:59:55Z') });
  try {
    assert.ok(!(await cards(page)).includes('tequatl-the-sunless'));
    await page.waitFor("[...document.querySelectorAll('#now-list .event')].some((c) => c.dataset.id === 'tequatl-the-sunless')", 12000);
    assert.match(await text(page, '#strip'), /Daily reset7:00 PMin 23h 5\dm/);
    const r = await rows(page);
    assert.ok(!r.some((x) => x.start === utc('2026-10-26T00:00:00Z')), 'the 00:00 starts left Coming up');
  } finally { await page.close(); }
});

check('an event that starts moves from Coming up into Scheduled now on its own (00:15, not midnight)', async () => {
  const page = await open({ at: utc('2026-10-25T00:14:57Z') });
  try {
    assert.ok((await rows(page)).some((r) => r.id === 'svanir-shaman-chief' && r.start === utc('2026-10-25T00:15:00Z')));
    assert.ok(!(await cards(page)).includes('svanir-shaman-chief'));
    await page.waitFor("[...document.querySelectorAll('#now-list .event')].some((c) => c.dataset.id === 'svanir-shaman-chief')", 8000);
    assert.ok(!(await rows(page)).some((r) => r.start === utc('2026-10-25T00:15:00Z')));
  } finally { await page.close(); }
});

check('across the US DST change, 07:00 UTC shows as 1:00 AM CST and 06:50 UTC is 1:50 AM CDT', async () => {
  const page = await open({ at: utc('2026-11-01T06:50:00Z') });
  try {
    assert.match(await text(page, '#local-time'), /^1:50:0\d AM$/);
    const r = await rows(page);
    const seven = r.find((x) => x.start === utc('2026-11-01T07:00:00Z'));
    assert.equal(seven.t, '1:00 AM');
    const eight = r.find((x) => x.start === utc('2026-11-01T08:00:00Z'));
    assert.equal(eight.t, '2:00 AM');
  } finally { await page.close(); }
});

check('across the UK DST change, 00:30 UTC is 1:30 AM BST and 01:30 UTC is 1:30 AM GMT', async () => {
  const page = await open({ at: utc('2026-10-25T00:20:00Z'), tz: 'Europe/London', news: { mode: 'fail' } });
  try {
    const r = await rows(page);
    assert.equal(r.find((x) => x.start === utc('2026-10-25T00:30:00Z')).t, '1:30 AM');
    assert.equal(r.find((x) => x.start === utc('2026-10-25T01:30:00Z')).t, '1:30 AM');
  } finally { await page.close(); }
});

check('starts after local midnight sit under a Tomorrow heading', async () => {
  const page = await open({ at: utc('2026-10-26T04:30:00Z') }); // 11:30 PM CDT
  try {
    const order = await page.eval("[...document.querySelectorAll('#next-list > li')].map((li) => li.classList.contains('day-sep') ? 'SEP:' + li.textContent : Number(li.dataset.start))");
    const sep = order.indexOf('SEP:Tomorrow');
    assert.ok(sep > 0, JSON.stringify(order.slice(0, 5)));
    assert.ok(order.slice(0, sep).every((s) => s < utc('2026-10-26T05:00:00Z')) && order.slice(sep + 1).every((s) => s >= utc('2026-10-26T05:00:00Z')));
    // The break is hidden from screen readers, so each later row says its day.
    assert.equal(await page.eval("[...document.querySelectorAll('#next-list .row')].filter((r) => Number(r.dataset.start) >= " + utc('2026-10-26T05:00:00Z') + ").every((r) => r.querySelector('.when .sr-only').textContent === 'Tomorrow, ')"), true);
    assert.equal(await page.eval("[...document.querySelectorAll('#next-list .row')].filter((r) => Number(r.dataset.start) < " + utc('2026-10-26T05:00:00Z') + ").some((r) => r.querySelector('.when .sr-only'))"), false);
  } finally { await page.close(); }
});

// ---- Preferences ----

check('filters, region chips, stars, hide, compact, time span and theme are saved and come back after reload', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await click(page, '[data-filter="world-boss"]'); await settle();
    assert.ok((await rows(page)).every((r) => EV.get(r.id).kind === 'world-boss'));
    await click(page, '[data-filter="all"]'); await settle();
    await click(page, '[data-region="voe"]'); await settle();
    assert.ok((await rows(page)).every((r) => EV.get(r.id).region !== 'voe'));
    await click(page, '#next-list .row[data-id="kaineng-blackout"] [data-star]'); await settle();
    await click(page, '#next-list .row[data-id="tequatl-the-sunless"] [data-hide]'); await settle();
    await page.eval("(() => { const s = document.getElementById('ahead'); s.value = '240'; s.dispatchEvent(new Event('change')); })()"); await settle();
    await click(page, '#compact-btn'); await click(page, '#theme-btn'); await settle();
    const before = await rows(page);
    assert.equal(before[0].id, 'kaineng-blackout', 'the starred event lists first');
    assert.ok(!before.some((r) => r.id === 'tequatl-the-sunless'));
    await page.reload();
    await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    const after = await rows(page);
    assert.equal(after[0].id, 'kaineng-blackout');
    assert.ok(!after.some((r) => r.id === 'tequatl-the-sunless') && !after.some((r) => EV.get(r.id).region === 'voe'));
    assert.deepEqual(await page.eval("[document.getElementById('ahead').value, document.body.classList.contains('compact'), document.documentElement.dataset.theme, document.querySelector('[data-region=\"voe\"]').getAttribute('aria-pressed'), document.getElementById('hidden-btn').textContent]"),
      ['240', true, 'light', 'false', 'Hidden (1)']);
    assert.ok(Math.max(...after.map((r) => r.start)) > utc('2026-10-26T02:50:00Z'), 'four hours ahead');
    await click(page, '#hidden-btn'); await settle();
    await click(page, '[data-unhide="tequatl-the-sunless"]'); await settle();
    assert.ok((await rows(page)).some((r) => r.id === 'tequatl-the-sunless'));
  } finally { await page.close(); }
});

check('broken saved settings fall back to the defaults instead of breaking the page', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.eval("localStorage.setItem('gw2-timer:v1:prefs', '{not json'); localStorage.setItem('gw2-timer:v1:overrides', JSON.stringify({ 'octovine': { offsetMin: 5 }, 'shackles-of-the-ancients': { offsetMin: 999 } }))");
    await page.reload();
    await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    assert.equal(await page.eval("document.querySelectorAll('.badge.adjusted').length"), 0);
    assert.equal(await page.eval("document.querySelector('[data-filter=\"all\"]').getAttribute('aria-pressed')"), 'true');
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

// ---- Copy waypoint, links ----

check('Copy waypoint puts the exact chat code on the clipboard and says so', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.eval("document.querySelector('#next-list .row[data-id=\"tequatl-the-sunless\"] [data-copy]').click()");
    await page.waitFor("document.getElementById('toast').textContent.startsWith('Copied')");
    assert.equal(await page.eval('navigator.clipboard.readText()'), '[&BNABAAA=]');
    assert.match(await text(page, '#toast'), /Splintered Coast Waypoint/);
  } finally { await page.close(); }
});

check('every waypoint code and link on the page is right: chat codes match the data, links are https with noopener', async () => {
  const page = await open({ at: utc('2026-10-25T12:00:00Z') });
  try {
    await page.eval("(() => { const s = document.getElementById('ahead'); s.value = '480'; s.dispatchEvent(new Event('change')); })()"); await settle();
    const copies = await page.eval("[...document.querySelectorAll('[data-copy]')].map((b) => [b.dataset.copy, b.getAttribute('aria-label')])");
    assert.ok(copies.length > 20);
    for (const [id, label] of copies) assert.ok(label.endsWith(EV.get(id).waypoint.chat), id);
    const links = await page.eval("[...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, rel: a.rel, target: a.target, raw: a.getAttribute('href') }))");
    for (const l of links) {
      if (l.raw.startsWith('#')) continue;
      assert.ok(l.href.startsWith('https://'), l.href);
      if (l.target === '_blank') assert.ok(l.rel.includes('noopener') && l.rel.includes('noreferrer'), l.href);
    }
    const wiki = links.filter((l) => l.href.includes('guildwars2.com/wiki') || l.href.includes('Special:Search'));
    assert.ok(wiki.length > 20 && wiki.every((l) => new URL(l.href).hostname === 'wiki.guildwars2.com'));
  } finally { await page.close(); }
});

// ---- Adjust ----

check('Adjust sets a start time from the time seen, survives reload, nudges, and resets', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const sel = '#next-list .row[data-id="shackles-of-the-ancients"]';
    await click(page, `${sel} [data-adjust]`); await settle();
    // Seen at 6:10 PM CDT = 23:10 UTC: every 2 h from 01:10.
    await page.eval("(() => { const i = document.querySelector('[data-adj-input=\"shackles-of-the-ancients\"]'); i.value = '18:10'; })()");
    await click(page, '[data-adj-set="shackles-of-the-ancients"]'); await settle();
    assert.match(await text(page, '.adjust-panel .adj-now'), /Yours: every 2 h from 01:10 UTC/);
    assert.equal(await page.eval(`document.querySelector('${sel} .badge.adjusted') !== null`), true);
    assert.equal(await page.eval(`Number(document.querySelector('${sel}').dataset.start)`), utc('2026-10-26T01:10:00Z'));
    await page.reload();
    await page.waitFor(`document.querySelector('${sel} .badge.adjusted') !== null`);
    await click(page, `${sel} [data-adjust]`); await settle();
    await click(page, '[data-adj-nudge="shackles-of-the-ancients:5"]'); await settle();
    assert.match(await text(page, '.adjust-panel .adj-now'), /from 01:15 UTC/);
    await click(page, '[data-adj-reset="shackles-of-the-ancients"]'); await settle();
    assert.equal(await page.eval(`document.querySelector('${sel} .badge.adjusted')`), null);
    assert.equal(await page.eval("localStorage.getItem('gw2-timer:v1:overrides')"), '{}');
    assert.equal(await page.eval("document.querySelectorAll('[data-adjust]').length > 0 && [...document.querySelectorAll('[data-adjust]')].every((b) => ['depths-of-cruelty','nexus-of-eternity','secrets-of-the-weald','shackles-of-the-ancients'].includes(b.dataset.adjust))"), true, 'only the four unverified events offer Adjust');
  } finally { await page.close(); }
});

check('the Unverified label shows on the four unverified events only', async () => {
  const page = await open({ at: utc('2026-10-25T12:00:00Z') });
  try {
    await page.eval("(() => { const s = document.getElementById('ahead'); s.value = '480'; s.dispatchEvent(new Event('change')); })()"); await settle();
    const marked = await page.eval("[...new Set([...document.querySelectorAll('.badge.warn')].map((b) => b.closest('[data-id]').dataset.id))].sort()");
    assert.deepEqual(marked, ['depths-of-cruelty', 'nexus-of-eternity', 'secrets-of-the-weald', 'shackles-of-the-ancients']);
  } finally { await page.close(); }
});

// ---- News ----

const newsCount = (page) => page.eval("document.querySelectorAll('#news-list li').length");
const moreState = (page) => page.eval("(() => { const b = document.getElementById('news-more'); return [b.hidden, b.textContent, b.getAttribute('aria-expanded')]; })()");

check('news shows headlines as plain text with dates, names ArenaNet, says it contacts guildwars2.com, and can be turned off', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    assert.match(await text(page, '#news-note'), /guildwars2\.com \(ArenaNet\), so ArenaNet sees this request/);
    assert.equal(await text(page, '.news-source'), 'from ArenaNet');
    assert.equal(await page.eval("document.querySelector('#news-list script, #news-list b')"), null);
    assert.match(await text(page, '#news-list li:nth-child(2) a'), /alert\(1\)/);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news-list li')].map((li) => [(li.querySelector('time') || {}).textContent || '', (li.querySelector('time') || {}).dateTime || ''])"),
      [['Oct 13', '2026-10-13T16:06:21.000Z'], ['Oct 6', '2026-10-06T16:00:22.000Z'], ['', '']]);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news-list a')].map((a) => a.getAttribute('href'))").then((h) => h.slice(0, 2)),
      ['https://www.guildwars2.com/en/news/first-test-post/', 'https://www.guildwars2.com/en/news/second-post/?keep=1']);
    await click(page, '#news-toggle'); await settle();
    assert.match(await text(page, '#news-note'), /News is off/);
    assert.deepEqual(await moreState(page), [true, 'Show all 5', 'false'], 'no Show all while news is off');
    const before = page.newsRequests;
    // No cached copy to hide behind: a page that loaded news while it is off would have to ask for it. (A fresh
    // cache made this depend on how fast two loads ran: v0.4.0 Phase C, a negative control missed once.)
    await page.eval("localStorage.removeItem('gw2-timer:v1:news')");
    await page.reload();
    await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    await sleep(500);
    assert.equal(page.newsRequests, before, 'no request to guildwars2.com while news is off');
    assert.equal(await newsCount(page), 0);
  } finally { await page.close(); }
});

check('news shows the three newest, expands to all five, and remembers the choice', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news-list a')].map((a) => a.firstChild.textContent)"), ['First Test Post - Plain & Simple', 'Second Post with “Quotes”alert(1)', 'No date still shows']);
    assert.deepEqual(await moreState(page), [false, 'Show all 5', 'false']);
    await page.eval("document.getElementById('news-more').focus()");
    await click(page, '#news-more'); await settle();
    assert.equal(await newsCount(page), 5);
    assert.deepEqual(await moreState(page), [false, 'Show fewer', 'true']);
    assert.equal(await page.eval("document.activeElement.id"), 'news-more', 'focus stays on the button');
    assert.equal(JSON.parse(await page.eval("localStorage.getItem('gw2-timer:v1:prefs')")).newsExpanded, true);
    await page.reload();
    await page.waitFor("document.querySelectorAll('#news-list li').length === 5");
    assert.deepEqual(await moreState(page), [false, 'Show fewer', 'true']);
    await click(page, '#news-more'); await settle();
    assert.equal(await newsCount(page), 3);
    await page.reload();
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    await sleep(300);
    assert.equal(await newsCount(page), 3, 'collapsed stays collapsed');
  } finally { await page.close(); }
});

check('a hostile feed shows only plain text and guildwars2.com links, and runs nothing', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), news: { mode: 'hostile' } });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    await click(page, '#news-more'); await settle();
    assert.equal(await newsCount(page), 5);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news-list a')].map((a) => a.firstChild.textContent)"),
      ['Image tag as text', '<script>window.__pwned=2</script> Double encoded', 'gnp.exe Direction override', 'Null and bell characters', 'Uppercase host is kept']);
    assert.ok((await page.eval("[...document.querySelectorAll('#news-list a')].map((a) => a.href)")).every((h) => h.startsWith('https://www.guildwars2.com/en/news/')));
    assert.equal(await page.eval("document.querySelectorAll('#news-list *:not(li):not(a):not(time):not(span)').length"), 0, 'no element other than the list, links, dates and spans');
    await sleep(300);
    assert.equal(await page.eval('typeof window.__pwned'), 'undefined', 'nothing from the feed ran');
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

check('dashes typed into feed titles show as hyphens: no em dash reaches the page', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), news: { mode: 'dashes' } });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 2");
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news-list a')].map((a) => a.firstChild.textContent)"), ['Announcing Guild Wars Afterlife - Prepurchase Available Now!', 'Festival Nov 3-10']);
    assert.equal(await page.eval('document.body.innerText.includes(String.fromCharCode(0x2014))'), false);
    assert.equal(await page.eval("document.getElementById('news-more').hidden"), true, 'no Show all with only two headlines');
  } finally { await page.close(); }
});

check('a feed that answers with an error page or a server error shows the failure note, and the timer carries on', async () => {
  for (const mode of ['garbage', 'http500']) {
    const page = await open({ at: utc('2026-10-25T23:50:00Z'), news: { mode } });
    try {
      await page.waitFor("/could not load/.test(document.getElementById('news-note').textContent)");
      assert.equal(await newsCount(page), 0, mode);
      assert.equal(await page.eval("document.getElementById('news-more').hidden"), true, mode);
      assert.ok((await rows(page)).length > 10, mode);
      assert.deepEqual(unexpected(page, [/^HTTP 500 https:\/\/www\.guildwars2\.com/, /^log: Failed to load resource: the server responded with a status of 500/]), [], mode);
    } finally { await page.close(); }
  }
});

check('a failed news feed shows a short message and the timer carries on', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), news: { mode: 'fail' } });
  try {
    await page.waitFor("/could not load/.test(document.getElementById('news-note').textContent)");
    assert.ok((await rows(page)).length > 10);
    const t1 = await text(page, '#local-time'); await sleep(1200);
    assert.notEqual(await text(page, '#local-time'), t1);
    assert.deepEqual(unexpected(page, [/^failed: /, /^log: Failed to load resource: net::ERR_FAILED/]), []);
  } finally { await page.close(); }
});

check('offline after loading: saved headlines stay with a note, the schedule keeps working', async () => {
  const news = { mode: 'fixture' };
  const first = await open({ at: utc('2026-10-25T23:00:00Z'), news });
  await first.waitFor("document.querySelectorAll('#news-list li').length === 3");
  await first.close();
  news.mode = 'offline';
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), news, keepStorage: true });
  try {
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitFor("/did not answer; these are the headlines saved/.test(document.getElementById('news-note').textContent)");
    assert.equal(await newsCount(page), 3);
    const t1 = await text(page, '#local-time'); await sleep(1200);
    assert.notEqual(await text(page, '#local-time'), t1);
    assert.ok((await rows(page)).length > 10);
  } finally { await page.close(); }
});

// ---- Security and independence ----

check('the CSP blocks a request to any other site', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const r = await page.eval(`new Promise((done) => {
      let violation = false;
      document.addEventListener('securitypolicyviolation', () => { violation = true; });
      fetch('https://example.com/', { mode: 'no-cors' }).then(() => done({ fetched: true, violation }), () => setTimeout(() => done({ fetched: false, violation }), 100));
    })`);
    assert.deepEqual(r, { fetched: false, violation: true });
  } finally { await page.close(); }
});

check('no request leaves the site except the news feed', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    const outside = page.requests.filter((u) => !u.startsWith(BASE) && u !== FEED_URL);
    assert.deepEqual(outside, []);
    assert.ok(page.requests.includes(FEED_URL));
  } finally { await page.close(); }
});

check('opened from a file: the page works with no errors', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), url: pathToFileURL(join(DIR, 'index.html')).href });
  try {
    assert.ok((await rows(page)).length > 10);
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

check('the clock check corrects a device clock that is three minutes slow', async () => {
  const realNow = Date.now();
  const page = await open({ at: realNow - 180000, url: `http://127.0.0.1:${datedPort}/` });
  try {
    await page.waitFor("!document.getElementById('clock-notice').hidden", 15000);
    assert.match(await text(page, '#clock-notice'), /Your device clock is (2m 5\d|3m 0\d)s slow/);
    const shown = await page.eval("document.getElementById('utc-time').textContent");
    const want = new Date(Date.now()).toISOString().slice(11, 16);
    assert.ok(shown.startsWith(want) || shown.startsWith(new Date(Date.now() - 2000).toISOString().slice(11, 16)), `${shown} vs ${want}`);
  } finally { await page.close(); }
});

check('the clock check corrects a device clock that is three minutes fast, and countdowns then match real time', async () => {
  const page = await open({ at: Date.now() + 180000, url: `http://127.0.0.1:${datedPort}/` });
  try {
    await page.waitFor("!document.getElementById('clock-notice').hidden", 15000);
    assert.match(await text(page, '#clock-notice'), /Your device clock is (2m 5\d|3m 0\d)s fast/);
    await sleep(1100); // one tick repaints every countdown
    const r = await page.eval("(() => { const el = document.querySelector('#next-list .row'); return { start: Number(el.dataset.start), text: el.querySelector('.in').textContent }; })()");
    const left = r.start - Date.now();
    const ok = [-1500, -1000, -500, 0, 500, 1000].map((d) => `in ${S.duration(left + d)}`);
    assert.ok(ok.includes(r.text), `${r.text} vs ${ok.join(' | ')}`);
  } finally { await page.close(); }
});

check('the weekly reset rolls over at Monday 07:30 UTC, and the next one shows in the new local time after DST ends', async () => {
  const page = await open({ at: utc('2026-10-26T07:29:56Z') });
  try {
    assert.match(await text(page, '#strip'), /Weekly resetMon 2:30 AMin \ds/);
    // The next Monday is November 2, after US daylight saving ends: 07:30 UTC is then 1:30 AM CST.
    await page.waitFor("/Weekly resetMon 1:30 AMin 6d 23h/.test(document.getElementById('strip').textContent)", 10000);
  } finally { await page.close(); }
});

// ---- v0.2.0 layout: news near the top, Schedule notes, highlights ----

check('page order: clocks and resets, news, filters, Scheduled now, Coming up, Schedule notes, events covered, footer', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const tops = await page.eval("['.topbar', '.strip', '#news', '.controls', '#now-title', '#coming-title', '#schedule-notes', '#event-index', '.site-footer'].map((s) => document.querySelector(s).getBoundingClientRect().top + scrollY)");
    assert.ok(tops.every((t, i) => i === 0 || t > tops[i - 1]), JSON.stringify(tops));
  } finally { await page.close(); }
});

// All three headlines are on the first screen at these sizes. At 360 x 640, the smallest phone screen checked, the
// news heading and the first headline must be on it; with wide fonts (Linux's DejaVu and Liberation, as on CI) the
// other two may end below it, and must then be reached by scrolling the page, whole and uncovered (Dos, v0.4.0
// release hardening). "Uncovered": the point in the middle of each line's text belongs to that line.
check('the news headlines are on screen without scrolling, on a desktop and on a phone', async () => {
  const seen = `((sel) => { const el = document.querySelector(sel), r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + Math.min(24, r.width / 2), r.top + r.height / 2);
    return { top: r.top, bottom: r.bottom, height: innerHeight, hit: !!hit && (el === hit || el.contains(hit)), whole: el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1 }; })`;
  const onScreen = (v) => v.top >= 0 && v.bottom <= v.height && v.hit && v.whole;
  for (const [width, height, mobile, all] of [[1280, 900, false, true], [1366, 768, false, true], [390, 844, true, true], [360, 640, true, false]]) {
    const page = await open({ at: utc('2026-10-25T23:50:00Z'), width, height, mobile });
    try {
      await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
      const first = await page.eval(`[scrollY, ${seen}('#news-title'), ${seen}('#news-list li:first-child a'), ${seen}('#news-list li:last-child a')]`);
      assert.equal(first[0], 0, `${width}x${height}: the page opened scrolled`);
      const must = all ? [['the news heading', first[1]], ['the first headline', first[2]], ['the last headline', first[3]]] : [['the news heading', first[1]], ['the first headline', first[2]]];
      for (const [what, v] of must) assert.ok(onScreen(v), `${width}x${height}: ${what} is not whole and uncovered on the first screen: ${JSON.stringify(v)}`);
      if (!all) {
        // The other headlines: scroll the page (not an element) until the last one's bottom is on screen.
        const after = await page.eval(`(() => { const r = document.querySelector('#news-list li:last-child a').getBoundingClientRect(); if (r.bottom > innerHeight) scrollBy(0, Math.ceil(r.bottom - innerHeight) + 8); return [${seen}('#news-list li:nth-child(2) a'), ${seen}('#news-list li:last-child a')]; })()`);
        for (const [what, v] of [['the second headline', after[0]], ['the last headline', after[1]]]) assert.ok(onScreen(v), `${width}x${height}: ${what} is not whole and uncovered after scrolling: ${JSON.stringify(v)}`);
        console.log(`     ${width}x${height}: first screen ends at ${height}; the last headline ends at ${first[3].bottom.toFixed(1)} (${first[3].bottom <= height ? 'on it' : 'reached by scrolling'})`);
      }
    } finally { await page.close(); }
  }
});

check('Schedule notes: closed at first; then the revision, review dates, counts per status, what they mean, and the uncertain events', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const m = DATA.meta, count = (s) => DATA.events.filter((e) => e.status === s).length;
    const uncertain = DATA.events.filter((e) => e.status !== 'documented' && e.status !== 'confirmed');
    assert.equal(await page.eval("document.getElementById('schedule-notes').open"), false);
    assert.equal(await text(page, '#notes-hint'), `r${m.datasetRevision} · reviewed ${fmtDay(m.reviewedOn)} · ${uncertain.length} uncertain times`);
    await click(page, '#schedule-notes summary'); await settle();
    assert.equal(await page.eval("document.getElementById('schedule-notes').open"), true);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#notes-facts dt')].map((dt) => [dt.textContent, dt.nextElementSibling.textContent])"), [
      ['Schedule revision', `r${m.datasetRevision}`],
      ['Last reviewed', `${fmtDay(m.reviewedOn)}, against ArenaNet's game update notes through ${fmtDay(m.reviewedThroughPatch)}`],
      ['Last checked against sources', fmtDay(m.verifiedOn)]]);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#notes-counts li')].map((li) => [li.dataset.status, Number(li.querySelector('.count').textContent), li.textContent.replace(/^\\d+ /, '')])"), [
      ['documented', count('documented'), 'Documented'], ['confirmed', count('confirmed'), 'Confirmed in game'],
      ['disputed', count('disputed'), 'Disputed'], ['unverified', count('unverified'), 'Unverified']]);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#notes-uncertain li')].map((li) => li.dataset.id)").then((a) => a.slice().sort()), uncertain.map((e) => e.id).sort());
    assert.equal(await text(page, '#notes-uncertain li[data-id="shackles-of-the-ancients"] .rule'), "Eternity's Garden: every 2 h from 01:15 UTC, runs about 25 min.");
    assert.equal(await text(page, '#notes-uncertain li[data-id="shackles-of-the-ancients"] .badge'), 'Disputed');
    assert.match(await text(page, '.notes-key'), /documentation check, not an in-game check/);
    // An adjusted time shows beside the default.
    await click(page, '#next-list .row[data-id="shackles-of-the-ancients"] [data-adjust]'); await settle();
    await click(page, '[data-adj-nudge="shackles-of-the-ancients:-5"]'); await settle();
    assert.equal(await text(page, '#notes-uncertain li[data-id="shackles-of-the-ancients"] .mine'), 'Yours (Adjust): every 2 h from 01:10 UTC.');
    assert.equal(await page.eval("document.getElementById('schedule-notes').open"), true, 'stays open across a rebuild');
  } finally { await page.close(); }
});

check('starts less than 10 minutes away are highlighted, and starred events are tinted and list first in both lists', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const marks = await page.eval("[...document.querySelectorAll('#next-list .row')].map((r) => [Number(r.dataset.start), r.querySelector('.in').classList.contains('soon')])");
    for (const [start, on] of marks) assert.equal(on, start <= utc('2026-10-26T00:00:00Z'), new Date(start).toISOString());
    assert.ok(marks.some((x) => x[1]) && marks.some((x) => !x[1]));
    assert.equal(await page.eval("getComputedStyle(document.querySelector('.in.soon')).color !== getComputedStyle(document.querySelector('.in:not(.soon)')).color"), true);
    await click(page, '#now-list .event[data-id="dragons-stand"] [data-star]'); await settle();
    await click(page, '#next-list .row[data-id="kaineng-blackout"] [data-star]'); await settle();
    assert.deepEqual(await cards(page).then((c) => c[0]), 'dragons-stand', 'a starred event leads Scheduled now');
    assert.equal(await page.eval("document.querySelector('#next-list .row').dataset.id"), 'kaineng-blackout');
    const bg = await page.eval("[...['#next-list .row.is-starred', '#next-list .row:not(.is-starred)', '#now-list .event.is-starred', '#now-list .event:not(.is-starred)']].map((s) => getComputedStyle(document.querySelector(s)).backgroundImage)");
    assert.ok(bg[0] !== bg[1] && bg[2] !== bg[3], JSON.stringify(bg));
    assert.equal(await page.eval("document.querySelector('#now-list .event[data-id=\"dragons-stand\"] [data-star]').getAttribute('aria-pressed')"), 'true');
  } finally { await page.close(); }
});

check('settings saved by v0.1.0 come back unchanged after the update, and only gain the news choice', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const v010 = { filter: 'meta', regions: ['core', 'hot', 'pof', 'eod', 'soto', 'jw', 'voe'], starred: ['octovine'], hidden: ['kaineng-blackout'], aheadMin: 240, compact: true, showUtc: false, theme: 'light', news: true };
    await page.eval(`localStorage.setItem('gw2-timer:v1:prefs', ${JSON.stringify(JSON.stringify(v010))}); localStorage.setItem('gw2-timer:v1:overrides', ${JSON.stringify(JSON.stringify({ 'secrets-of-the-weald': { offsetMin: 105, setAt: 1761400000000 } }))})`);
    await page.reload();
    await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    assert.deepEqual(await page.eval("[document.querySelector('[data-filter=\"meta\"]').getAttribute('aria-pressed'), document.querySelector('[data-region=\"ibs\"]').getAttribute('aria-pressed'), document.body.classList.contains('compact'), document.documentElement.dataset.theme, document.getElementById('ahead').value, document.getElementById('hidden-btn').textContent, document.querySelectorAll('#next-list .utc').length]"),
      ['true', 'false', true, 'light', '240', 'Hidden (1)', 0]);
    const r = await rows(page);
    assert.equal(r[0].id, 'octovine', 'the starred event lists first');
    assert.ok(r.every((x) => EV.get(x.id).kind === 'meta' && x.id !== 'kaineng-blackout'));
    assert.ok(r.some((x) => x.id === 'secrets-of-the-weald' && new Date(x.start).getUTCMinutes() === 45), 'the saved Adjust time is kept');
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    await click(page, '#news-more'); await settle();
    assert.deepEqual(JSON.parse(await page.eval("localStorage.getItem('gw2-timer:v1:prefs')")), { ...v010, newsExpanded: true });
  } finally { await page.close(); }
});

// ---- Layout, keyboard, motion ----

const sideways = (page, w) => page.eval(`[document.documentElement.scrollWidth, ${w}]`);
check('Share and Buy me a coffee, as on FFXI Timer: in the header, footer and About; Share passes https://radmagelabs.com/gw2-timer/ to the share sheet, or copies it where there is none or the sheet fails; a closed sheet does nothing; About\'s Share closes About so the toast is seen; nothing is requested; 36 px on a phone', async () => {
  const CANONICAL = 'https://radmagelabs.com/gw2-timer/';
  const STUB = `(() => { window.__shared = []; window.__copied = []; window.__mode = 'ok';
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { window.__shared.push(d); if (window.__mode !== 'ok') throw new DOMException('sheet', window.__mode); } });
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } }); })()`;
  let page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.eval(STUB);
    const asked = page.requests.length;
    assert.deepEqual(await page.eval("[...document.querySelectorAll('[data-share]')].map((b) => b.closest('.topbar') ? 'header' : b.closest('.site-footer') ? 'footer' : b.closest('#about') ? 'about' : '?')"), ['header', 'footer', 'about']);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('a[href=\"https://buymeacoffee.com/radmageirl\"]')].map((a) => [a.closest('.topbar') ? 'header' : a.closest('.site-footer') ? 'footer' : a.closest('#about') ? 'about' : '?', a.target, a.rel, a.textContent])"), [
      ['header', '_blank', 'noopener noreferrer', 'buy me a coffee (opens a new tab)'], ['footer', '_blank', 'noopener noreferrer', 'Buy me a coffee (opens a new tab)'], ['about', '_blank', 'noopener noreferrer', 'Buy me a coffee (opens a new tab)']]);
    const state = () => page.eval("({ shared: window.__shared.map((d) => [d.url, d.title]), copied: window.__copied, toast: document.getElementById('toast').textContent, about: document.getElementById('about').open })");
    // With a share sheet: the canonical address and the page's own title, never the address it was opened at.
    await click(page, '.topbar [data-share]'); await settle();
    await click(page, '.site-footer [data-share]'); await settle();
    let s = await state();
    const sheet = [CANONICAL, 'GW2 Timer | Unofficial Guild Wars 2 Fansite'];
    assert.deepEqual([s.shared, s.copied], [[sheet, sheet], []], 'the share sheet, twice; nothing copied');
    // The reader closes the sheet: nothing happens. The sheet fails: the address is copied instead.
    await page.eval("window.__mode = 'AbortError'"); await click(page, '.topbar [data-share]'); await settle();
    assert.deepEqual([(await state()).copied, (await state()).shared.length], [[], 3], 'a closed sheet does nothing');
    await page.eval("window.__mode = 'NotAllowedError'"); await click(page, '.topbar [data-share]'); await settle();
    s = await state();
    assert.deepEqual([s.copied, s.toast], [[CANONICAL], `Copied the link to GW2 Timer: ${CANONICAL}`], 'a failed sheet: copied');
    // No share sheet (most desktop browsers): copied. About's Share closes About first, so the toast shows.
    await page.eval("Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }); window.__copied = []");
    await click(page, '#about-btn'); await settle();
    await click(page, '#about [data-share]'); await settle();
    s = await state();
    assert.deepEqual([s.copied, s.about, s.toast], [[CANONICAL], false, `Copied the link to GW2 Timer: ${CANONICAL}`], 'About closed; copied');
    // Copying not allowed either: the toast gives the address to copy by hand.
    await page.eval("Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new DOMException('no', 'NotAllowedError'); } } }); document.execCommand = () => false");
    await click(page, '.site-footer [data-share]'); await settle();
    assert.equal((await state()).toast, `Copy did not work here. The link is ${CANONICAL}`);
    assert.deepEqual(page.requests.slice(asked), [], 'Share and the coffee link request nothing');
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
  // On a phone: both header links 36 px tall to tap, on a line of their own under the tagline.
  page = await open({ at: utc('2026-10-25T23:50:00Z'), width: 390, height: 844, mobile: true });
  try {
    const r = await page.eval("[...document.querySelectorAll('.topbar .share-links button, .topbar .share-links a')].map((x) => Math.round(x.getBoundingClientRect().height))");
    assert.deepEqual(r, [36, 36]);
    assert.equal(await page.eval("document.querySelector('.topbar .share-links').getBoundingClientRect().top >= document.querySelector('.brand .tag').getBoundingClientRect().bottom"), true, 'under the tagline');
  } finally { await page.close(); }
});

check('on a 390 px phone nothing scrolls sideways and every control is at least 36 px tall', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), width: 390, height: 844, mobile: true });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    await click(page, '#next-list .row [data-adjust], #now-list [data-adjust]'); await settle();
    await click(page, '#schedule-notes summary'); await settle();
    await click(page, '#filters-toggle'); await settle(); // since v0.3.0 the filters fold on phones: open them so every control is measured
    // Mobile emulation widens the layout to fit overflowing content, so compare with the device width itself.
    const [sw] = await sideways(page, 390);
    assert.equal(sw, 390, 'no sideways scroll');
    const small = await page.eval("[...document.querySelectorAll('button, a.btn, select, input, summary')].filter((b) => b.offsetParent && (b.getBoundingClientRect().height < 36 || b.getBoundingClientRect().width < 24)).map((b) => b.className + ':' + b.textContent)");
    assert.deepEqual(small, []);
    const news = await page.eval("[...document.querySelectorAll('#news-list a')].map((a) => a.getBoundingClientRect().height)");
    assert.ok(news.every((h) => h >= 32), JSON.stringify(news));
    if (SHOTS) await page.screenshot(join(SHOTS, 'mobile.png'), { height: 2200 });
  } finally { await page.close(); }
});

check('on a 320 px phone, in normal and compact mode, nothing scrolls sideways', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), width: 320, height: 640, mobile: true });
  try {
    await click(page, '#next-list .row [data-adjust], #now-list [data-adjust]'); await settle();
    await click(page, '#news-more'); await click(page, '#schedule-notes summary'); await click(page, '#event-index summary'); await settle();
    assert.equal((await sideways(page, 320))[0], 320, 'normal, filters folded');
    await click(page, '#filters-toggle'); await settle();
    assert.equal((await sideways(page, 320))[0], 320, 'normal');
    await click(page, '#compact-btn'); await settle();
    assert.equal((await sideways(page, 320))[0], 320, 'compact');
  } finally { await page.close(); }
});

check('compact mode puts each Coming up start on one line', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const before = await page.eval("Math.max(...[...document.querySelectorAll('#next-list .row')].map((r) => r.getBoundingClientRect().height))");
    await click(page, '#compact-btn'); await settle();
    const after = await page.eval("[...document.querySelectorAll('#next-list .row')].map((r) => r.getBoundingClientRect().height)");
    assert.ok(Math.max(...after) < before, `${before} -> ${Math.max(...after)}`);
    // One line, whatever the fonts: the time, countdown, name and Copy button share a horizontal band.
    // (A pixel limit failed on Ubuntu's fonts in CI, where the rows were one line but 50 px tall.)
    assert.equal(await page.eval("[...document.querySelectorAll('#next-list .row')].every((r) => { const b = ['.t', '.in', '.name', '[data-copy]'].map((s) => r.querySelector(s).getBoundingClientRect()); return Math.max(...b.map((x) => x.top)) < Math.min(...b.map((x) => x.bottom)); })"), true, 'each row on one line');
    assert.equal(await page.eval("[...document.querySelectorAll('#next-list .row .when')].every((w) => { const t = w.querySelector('.t').getBoundingClientRect(), i = w.querySelector('.in').getBoundingClientRect(); return i.left > t.right && i.top < t.bottom && i.bottom > t.top; })"), true, 'time and countdown side by side');
    if (SHOTS) await page.screenshot(join(SHOTS, 'desktop-compact.png'), { height: 1100 });
  } finally { await page.close(); }
});

const key = (page, k, code, vk) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k === 'Enter' ? '\r' : k === ' ' ? ' ' : undefined })
  .then(() => page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk }));
check('keyboard: skip links, news, filters and event buttons in order; Enter opens Schedule notes, Space stars, Escape closes About', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    const seen = [];
    for (let i = 0; i < 60; i++) {
      await key(page, 'Tab', 'Tab', 9);
      seen.push(await page.eval("(document.activeElement.closest('#news-list') ? 'news-link' : '') || document.activeElement.id || document.activeElement.className || document.activeElement.tagName"));
    }
    assert.deepEqual(seen.slice(0, 2), ['skip', 'skip']);
    const at = (x) => seen.findIndex((c) => (typeof x === 'string' ? c === x : x.test(c)));
    const order = [at('news-toggle'), at('news-link'), at('news-more'), at('find'), at('seg-btn'), at('chip'), at('ahead'), at(/star-btn/), at(/copy/)];
    assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), seen.join(','));
    // The first skip link moves focus to Scheduled now.
    await page.eval("document.querySelector('.skip').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.equal(await page.eval('document.activeElement.id'), 'now-title');
    await page.eval("document.querySelector('#schedule-notes summary').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.equal(await page.eval("document.getElementById('schedule-notes').open"), true);
    await page.eval("document.querySelector('#next-list .row [data-star]').focus()");
    await key(page, ' ', 'Space', 32); await settle();
    assert.equal(await page.eval("document.activeElement.getAttribute('aria-pressed')"), 'true', 'focus follows the starred event to its new place');
    await click(page, '#about-btn'); await settle();
    assert.equal(await page.eval("document.getElementById('about').open"), true);
    await key(page, 'Escape', 'Escape', 27); await settle();
    assert.equal(await page.eval("document.getElementById('about').open"), false);
  } finally { await page.close(); }
});

check('every button and link has a name, and every event button names its event', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const unnamed = await page.eval("[...document.querySelectorAll('button, a[href], select, input, summary')].filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || (el.labels && el.labels.length))).map((el) => el.outerHTML.slice(0, 80))");
    assert.deepEqual(unnamed, []);
    const generic = await page.eval("[...document.querySelectorAll('[data-copy], [data-hide], [data-adjust], [data-star]')].filter((b) => !b.getAttribute('aria-label') || !b.getAttribute('aria-label').includes(document.querySelector('#next-list [data-id=\"' + b.closest('[data-id]').dataset.id + '\"] .name, #now-list [data-id=\"' + b.closest('[data-id]').dataset.id + '\"] h3').textContent)).length");
    assert.equal(generic, 0);
    assert.equal(await page.eval("document.querySelector('[data-adjust]').getAttribute('aria-controls')"), `adjust-${await page.eval("document.querySelector('[data-adjust]').dataset.adjust")}`);
    assert.match(await text(page, '#news-list a'), /\(opens a new tab\)$/);
    // Decorative CSS markers (the disclosure triangle, check marks, the star) stay out of accessible names.
    await page.send('Accessibility.enable');
    const { nodes } = await page.send('Accessibility.getFullAXTree', {});
    const names = nodes.filter((n) => !n.ignored).map((n) => (n.name && n.name.value) || '');
    const chips = await page.eval("[...document.querySelectorAll('#region-chips .chip')].map((c) => [c.textContent, c.getAttribute('aria-label')])");
    assert.ok(chips.length === DATA.regions.length && chips.every(([t, l], i) => l === `${t} (${DATA.regions[i].name})`), JSON.stringify(chips));
    assert.match(await page.eval("getComputedStyle(document.querySelector('.brand .tag a')).textDecorationLine"), /underline/, 'the tagline link is underlined');
    const kinds = (k) => DATA.events.filter((e) => e.kind === k).length;
    assert.ok(names.includes(`Events this timer covers ${kinds('world-boss')} world bosses and ${kinds('meta')} meta events`), 'the event index summary is named by its text alone');
    assert.ok(names.includes(`Schedule notes r${DATA.meta.datasetRevision} · reviewed ${fmtDay(DATA.meta.reviewedOn)} · ${DATA.events.filter((e) => e.status !== 'documented' && e.status !== 'confirmed').length} uncertain times`), 'the summary is named by its text alone');
    assert.ok(!names.some((n) => /[\u25B8\u25BE\u2713\u2605]/.test(n)), names.filter((n) => /[\u25B8\u25BE\u2713\u2605]/.test(n)).join(' | '));
  } finally { await page.close(); }
});

check('with reduced motion the active cards do not animate', async () => {
  const page = await chrome.newPage();
  try {
    await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.startClockAt(utc('2026-10-25T23:50:00Z'));
    await page.goto(BASE);
    await page.waitFor("document.querySelectorAll('#now-list .event').length > 0");
    assert.equal(await page.eval("getComputedStyle(document.querySelector('#now-list .event')).animationName"), 'none');
  } finally { await page.close(); }
});

// ---- Events this timer covers, and a page that does not move as it loads ----

check('Events this timer covers: closed at first, opens with Enter, lists every event by kind and region, and reads the same with JavaScript off', async () => {
  const names = DATA.events.map((e) => e.name).sort();
  const expectHeads = [];
  for (const [kind, title] of [['world-boss', 'World bosses'], ['meta', 'Meta events']]) {
    expectHeads.push(`H3 ${title} (${DATA.events.filter((e) => e.kind === kind).length})`);
    for (const r of DATA.regions) if (DATA.events.some((e) => e.kind === kind && e.region === r.id)) expectHeads.push(`H4 ${r.name}`);
  }
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    assert.equal(await page.eval("document.getElementById('event-index').open"), false, 'closed at first');
    await page.eval("document.querySelector('#event-index summary').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.equal(await page.eval("document.getElementById('event-index').open"), true, 'Enter opens it');
    const shown = await page.eval("[...document.querySelectorAll('#event-index .index-name')].filter((n) => n.getClientRects().length).map((n) => n.textContent)");
    assert.deepEqual(shown.slice().sort(), names);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#event-index h3, #event-index h4')].map((h) => h.tagName + ' ' + h.textContent)"), expectHeads);
    // With the lists rendered (event cards are h3 under Scheduled now), the page still has one h1 and skips no level.
    const levels = await page.eval("[...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => Number(h.tagName[1]))");
    assert.equal(levels[0], 1);
    assert.ok(levels.every((l, i) => i === 0 || (l > 1 && l <= levels[i - 1] + 1)), levels.join(','));
  } finally { await page.close(); }
  const off = await chrome.newPage();
  try {
    await off.send('Emulation.setScriptExecutionDisabled', { value: true });
    await off.goto(BASE);
    await off.eval("document.querySelector('#event-index summary').click()");
    const visible = await off.eval("document.getElementById('event-index').innerText");
    for (const n of names) assert.ok(visible.includes(n), `without JavaScript: ${n}`);
    assert.ok(visible.includes('Every Guild Wars 2 world boss and meta event the timer follows'));
  } finally { await off.close(); }
});

check('while the first headlines load, the news panel keeps their room and Show all keeps its place; a failed feed gives the room back', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), news: { mode: 'hold' } });
  try {
    await page.waitFor('Boolean(document.getElementById("news-note").textContent)');
    const before = await page.eval("[document.getElementById('news').dataset.status, document.getElementById('news-list').getBoundingClientRect().height, getComputedStyle(document.getElementById('news-more')).visibility, document.querySelector('.controls').getBoundingClientRect().top]");
    assert.equal(before[0], 'loading');
    assert.ok(before[1] >= 80, `the empty list keeps ${before[1]} px`);
    assert.equal(before[2], 'hidden', 'Show all holds its place, unseen');
    assert.ok(page.held, 'the news request is waiting');
    await page.send('Fetch.fulfillRequest', { requestId: page.held, responseCode: 200, body: Buffer.from(LONG_FEED).toString('base64'),
      responseHeaders: [{ name: 'Content-Type', value: 'text/xml; charset=utf-8' }, { name: 'Access-Control-Allow-Origin', value: '*' }] });
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    const after = await page.eval("[document.getElementById('news').dataset.status, document.querySelector('.controls').getBoundingClientRect().top, document.getElementById('news-more').hidden]");
    assert.equal(after[0], 'ok');
    assert.equal(after[2], false, 'Show all 5 shows');
    assert.ok(Math.abs(after[1] - before[3]) <= 4, `the filters moved from ${before[3]} to ${after[1]} px`);
  } finally { await page.close(); }
  const failed = await open({ at: utc('2026-10-25T23:50:00Z'), news: { mode: 'http500' } });
  try {
    await failed.waitFor("document.getElementById('news').dataset.status === 'failed'");
    assert.equal(await failed.eval("document.getElementById('news-list').getBoundingClientRect().height"), 0, 'no empty room after a failure');
  } finally { await failed.close(); }
});

check('the page does not move as it loads: on a slow network with headlines arriving late, no layout shift on a desktop or a phone', async () => {
  // Before v0.2.1 the first paint came before the scripts ran, and the filled-in page shifted by 0.87 to 0.9.
  for (const [width, height, mobile, limit] of [[1280, 900, false, 0.02], [390, 844, true, 0.1]]) {
    const page = await chrome.newPage();
    try {
      await page.send('Storage.clearDataForOrigin', { origin: BASE.slice(0, -1), storageTypes: 'all' });
      await page.emulate({ timezone: 'America/Chicago', locale: 'en-US' });
      await page.viewport(width, height, mobile);
      await page.startClockAt(utc('2026-10-25T23:50:00Z'));
      await page.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 90000 });
      await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.guildwars2.com/*' }] });
      page.on('Fetch.requestPaused', async (p) => {
        await sleep(400);
        await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, body: Buffer.from(LONG_FEED).toString('base64'),
          responseHeaders: [{ name: 'Content-Type', value: 'text/xml; charset=utf-8' }, { name: 'Access-Control-Allow-Origin', value: '*' }] });
      });
      await page.goto(BASE);
      await page.waitFor("document.querySelectorAll('#news-list li').length === 3", 15000);
      await sleep(300);
      const shifts = await page.eval("new Promise((ok) => { const out = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) out.push(e.value); }).observe({ type: 'layout-shift', buffered: true }); setTimeout(() => ok(out), 50); })");
      const total = shifts.reduce((a, b) => a + b, 0);
      assert.ok(total < limit, `${width} px: layout shift ${total.toFixed(4)} (${shifts.map((x) => x.toFixed(4)).join(', ') || 'none'})`);
    } finally { await page.close(); }
  }
});

// ---- v0.3.0 Phase C: Find, the phone filter fold, the Starred empty text, the reset countdown ----

// Times as the page shows them in Chicago (en-US), whatever this machine's own zone and ICU spacing.
const chicago = (ms) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }).format(ms).replace(/\s/g, ' ');
const utcHm = (ms) => new Date(ms).toISOString().slice(11, 16);
const PREFS = 'gw2-timer:v1:prefs';
const listedIds = (page) => page.eval("[...new Set([...document.querySelectorAll('#now-list .event, #next-list .row')].map((x) => x.dataset.id))]");
const findText = (page) => page.eval("document.getElementById('find-status').innerText.replace(/\\s+/g, ' ').trim()");
const findItems = (page) => page.eval("[...document.querySelectorAll('#find-status li')].map((li) => li.textContent.replace(/\\s+/g, ' '))");
/** Types into Find one letter at a time, as a person does, then waits for the typing pause to end. */
async function typeFind(page, text, { gap = 40, settleMs = 800 } = {}) {
  await page.eval("document.getElementById('find').focus()");
  for (const ch of text) { await page.send('Input.insertText', { text: ch }); await sleep(gap); }
  await sleep(settleMs);
}
const setPrefs = async (page, p) => {
  await page.eval(`localStorage.setItem('${PREFS}', ${JSON.stringify(JSON.stringify(p))})`);
  await page.reload();
  await page.waitFor("document.querySelectorAll('#next-list .row, #next-empty:not([hidden])').length > 0");
};
// The settings a v0.2.1 reader may have saved, every key set away from its default.
const SAVED = { filter: 'meta', regions: ['hot', 'pof', 'ibs', 'eod', 'soto', 'jw', 'voe'], starred: ['octovine', 'drakkar'], hidden: ['claw-of-jormag'], aheadMin: 120, compact: false, showUtc: true, theme: 'dark', news: true, newsExpanded: false };

check('Find: typing narrows both lists to the matches and says how many; clearing brings every row back', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const before = await listedIds(page);
    assert.equal(await page.eval("document.getElementById('find-clear').hidden"), true, 'no Clear while the field is empty');
    await typeFind(page, 'wurm');
    assert.deepEqual(await listedIds(page), ['great-jungle-wurm']);
    assert.equal(await findText(page), '1 event matches.');
    assert.equal(await page.eval("document.getElementById('find-clear').hidden"), false);
    await typeFind(page, ' core'); // every word has to match, and the region counts
    assert.deepEqual(await listedIds(page), ['great-jungle-wurm']);
    await page.eval("document.getElementById('find').value = ''; document.getElementById('find').dispatchEvent(new Event('input', { bubbles: true }))");
    await sleep(800);
    assert.deepEqual(await listedIds(page), before, 'every row is back');
    assert.equal(await findText(page), '');
    assert.equal(await page.eval("document.getElementById('find-clear').hidden"), true, 'no Clear once the text is deleted');
    await typeFind(page, 'boss');
    const bosses = DATA.events.filter((e) => e.kind === 'world-boss').map((e) => e.id);
    const got = await listedIds(page);
    assert.ok(got.length > 3 && got.every((id) => bosses.includes(id)), JSON.stringify(got));
    assert.match(await findText(page), /^15 events match; \d+ are not in your lists:/);
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

check('Find: a match left out by Show, Regions, Starred or the Hidden list is named with every reason and when it next starts; saved settings stay byte-identical', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await setPrefs(page, SAVED);
    const saved = await page.eval(`localStorage.getItem('${PREFS}')`);
    const overrides = await page.eval("localStorage.getItem('gw2-timer:v1:overrides')");
    await typeFind(page, 'claw');
    assert.deepEqual(await listedIds(page), []);
    assert.equal(await findText(page), `1 event matches, but it is not in your lists: Claw of Jormag: on your Hidden list; Core Tyria is off in Regions; Show is set to Meta events. Next at ${chicago(utc('2026-10-26T02:30:00Z'))} (02:30 UTC).`);
    // In its window now: the window's end, not a next start.
    await page.eval("document.getElementById('find-clear').click()"); await settle();
    await typeFind(page, 'behemoth');
    assert.equal(await findText(page), `1 event matches, but it is not in your lists: Shadow Behemoth: Core Tyria is off in Regions; Show is set to Meta events. In its scheduled window now, until ${chicago(utc('2026-10-26T00:00:00Z'))} (00:00 UTC).`);
    // Fifteen world bosses: the first five named in the order they come, the rest counted.
    await page.eval("document.getElementById('find-clear').click()"); await settle();
    await typeFind(page, 'world boss');
    const items = await findItems(page);
    assert.equal(items.length, 5);
    assert.match(await findText(page), /^15 events match, but none is in your lists: .* And 10 more not in your lists\.$/);
    const S2 = (id) => { const e = EV.get(id); const w = S.currentWindow(e.schedule, utc('2026-10-25T23:50:00Z')); return w ? w.end : S.nextStart(e.schedule, utc('2026-10-25T23:50:00Z')); };
    const order = DATA.events.filter((e) => e.kind === 'world-boss').sort((a, b) => S2(a.id) - S2(b.id) || a.name.localeCompare(b.name)).slice(0, 5).map((e) => e.name);
    assert.deepEqual(items.map((t) => t.split(':')[0]), order, 'soonest first');
    assert.ok(items.every((t) => t.includes('Show is set to Meta events')), JSON.stringify(items));
    // Starred: the reason says so.
    await page.eval("document.getElementById('find-clear').click()"); await settle();
    await click(page, '[data-filter="starred"]'); await settle();
    await typeFind(page, 'tequatl');
    assert.match(await findText(page), /^1 event matches, but it is not in your lists: Tequatl the Sunless: Core Tyria is off in Regions; not starred, and Show is set to Starred\. Next at /);
    await click(page, '[data-filter="meta"]'); await settle();
    // Exactly five left out: no "more" line.
    await page.eval(`localStorage.setItem('${PREFS}', ${JSON.stringify(JSON.stringify({ ...SAVED, regions: SAVED.regions.filter((r) => r !== 'voe') }))})`);
    await page.reload(); await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    const saved2 = await page.eval(`localStorage.getItem('${PREFS}')`);
    await typeFind(page, 'voe');
    assert.equal((await findItems(page)).length, 5);
    assert.ok(!/more not in your lists/.test(await findText(page)));
    assert.equal(await page.eval(`localStorage.getItem('${PREFS}')`), saved2, 'searching saved nothing');
    await page.eval(`localStorage.setItem('${PREFS}', ${JSON.stringify(saved)})`);
    // Typing, Enter, Escape and Clear never write the settings, and never change the filters shown.
    await page.reload(); await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    const pressed = () => page.eval("[...document.querySelectorAll('[aria-pressed]')].map((b) => b.getAttribute('aria-pressed')).join()");
    const p0 = await pressed();
    await typeFind(page, 'claw');
    await key(page, 'Enter', 'Enter', 13); await settle();
    await key(page, 'Escape', 'Escape', 27); await settle();
    await typeFind(page, 'tequatl'); await page.eval("document.getElementById('find-clear').click()"); await settle();
    assert.equal(await page.eval(`localStorage.getItem('${PREFS}')`), saved, 'prefs byte-identical');
    assert.equal(await page.eval("localStorage.getItem('gw2-timer:v1:overrides')"), overrides);
    assert.equal(await pressed(), p0, 'no filter changed to show a match');
    assert.equal(await page.eval('localStorage.length'), await page.eval("Object.keys(localStorage).filter((k) => k.startsWith('gw2-timer:v1:')).length"), 'nothing stored outside the app keys');
    assert.ok(!(await page.eval('Object.keys(localStorage).join()')).includes('find'));
    assert.equal(await page.eval('location.hash + location.search'), '', 'not in the address');
    // A reload starts with an empty field and the reader's own lists.
    await typeFind(page, 'claw');
    await page.reload(); await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    assert.equal(await page.eval("document.getElementById('find').value"), '');
    assert.equal(await findText(page), '');
    assert.ok((await listedIds(page)).length > 3);
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

check('Find: a match outside the Coming up span is named with its next start, in the span chosen, with the day and UTC as set', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await typeFind(page, 'karka');
    assert.equal(await findText(page), `1 event matches, but it is not in your lists: Karka Queen: starts after the 2 hours shown in Coming up. Next at ${chicago(utc('2026-10-26T02:00:00Z'))} (02:00 UTC).`);
    await page.eval("(() => { const s = document.getElementById('ahead'); s.value = '60'; s.dispatchEvent(new Event('change')); })()"); await settle();
    assert.match(await findText(page), /starts after the 1 hour shown in Coming up\./);
    await click(page, '#utc-btn'); await settle();
    assert.ok(!/UTC/.test(await findText(page)), 'no UTC time when UTC is off');
    await page.eval("(() => { const s = document.getElementById('ahead'); s.value = '480'; s.dispatchEvent(new Event('change')); })()"); await settle();
    assert.deepEqual(await listedIds(page), ['karka-queen']);
    assert.equal(await findText(page), '1 event matches.');
    await page.eval(`localStorage.removeItem('${PREFS}')`);
  } finally { await page.close(); }
  const late = await open({ at: utc('2026-10-26T04:30:00Z') }); // 11:30 PM in Chicago
  try {
    await typeFind(late, 'tequatl');
    assert.equal(await findText(late), `1 event matches, but it is not in your lists: Tequatl the Sunless: starts after the 2 hours shown in Coming up. Next tomorrow at ${chicago(utc('2026-10-26T07:00:00Z'))} (07:00 UTC).`);
  } finally { await late.close(); }
});

check('Find: no match says so; look-alikes are not found; punctuation alone searches nothing', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await typeFind(page, 'zzzz');
    assert.equal(await findText(page), 'No event matches. Try part of a name, a map or a region.');
    assert.deepEqual(await page.eval("[document.getElementById('now-empty').hidden, document.getElementById('now-empty').textContent, document.getElementById('next-empty').hidden, document.getElementById('next-empty').textContent]"),
      [false, 'Nothing that matches your search is in its scheduled window right now.', false, 'Nothing that matches your search starts in this time span.']);
    await page.eval("document.getElementById('find-clear').click()"); await settle();
    // "mega" is the start of a real name, so it finds Megadestroyer and not every meta event (one letter from "meta").
    await page.eval("(() => { const s = document.getElementById('ahead'); s.value = '480'; s.dispatchEvent(new Event('change')); })()"); await settle();
    await typeFind(page, 'mega');
    assert.deepEqual(await listedIds(page), ['megadestroyer']);
    assert.equal(await findText(page), '1 event matches.');
    await page.eval("document.getElementById('find-clear').click()"); await settle();
    await typeFind(page, 'tequatel'); // one typo in a whole word
    assert.deepEqual(await listedIds(page), ['tequatl-the-sunless']);
    await page.eval("document.getElementById('find-clear').click()"); await settle();
    await typeFind(page, 'worm'); // close to "wurm", not to every world boss
    assert.deepEqual(await listedIds(page), ['great-jungle-wurm']);
    await page.eval("document.getElementById('find-clear').click()"); await settle();
    const all = await listedIds(page);
    await typeFind(page, '!!!');
    assert.deepEqual(await listedIds(page), all, 'punctuation alone narrows nothing');
    assert.equal(await findText(page), '');
  } finally { await page.close(); }
});

check('Find: keyboard: the field comes before the filters, Enter applies at once, Escape and Clear empty it and keep focus in the field', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.eval("document.getElementById('news-toggle').focus()");
    const seen = [];
    for (let i = 0; i < 12; i++) { await key(page, 'Tab', 'Tab', 9); seen.push(await page.eval("document.activeElement.id || document.activeElement.className")); }
    assert.ok(seen.indexOf('find') >= 0 && seen.indexOf('find') < seen.findIndex((c) => /seg-btn/.test(c)), seen.join(','));
    assert.ok(!seen.includes('find-clear') && !seen.includes('filters-toggle'), 'no Clear while empty, and no Filters button on a desktop');
    await page.eval("document.getElementById('find').focus()");
    await page.send('Input.insertText', { text: 'karka' });
    await key(page, 'Enter', 'Enter', 13);
    await sleep(60); // well inside the typing pause: Enter does not wait for it
    assert.match(await findText(page), /^1 event matches, but it is not in your lists: Karka Queen/);
    await key(page, 'Tab', 'Tab', 9);
    assert.equal(await page.eval('document.activeElement.id'), 'find-clear', 'Clear comes right after the field');
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.deepEqual([await page.eval('document.activeElement.id'), await page.eval("document.getElementById('find').value"), await findText(page)], ['find', '', '']);
    await page.send('Input.insertText', { text: 'wurm' }); await sleep(800);
    assert.deepEqual(await listedIds(page), ['great-jungle-wurm']);
    await key(page, 'Escape', 'Escape', 27); await settle();
    assert.deepEqual([await page.eval('document.activeElement.id'), await page.eval("document.getElementById('find').value"), await findText(page)], ['find', '', '']);
    assert.ok((await listedIds(page)).length > 3);
    assert.equal(await page.eval("document.getElementById('find-clear').hidden"), true, 'Clear goes with the text');
    // Escape in an empty field does nothing at all.
    await key(page, 'Escape', 'Escape', 27); await settle();
    assert.equal(await page.eval('document.activeElement.id'), 'find');
  } finally { await page.close(); }
});

check('Find: screen readers: the field is named and described by the status, which is a polite region that speaks once per pause, not per letter', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    assert.equal(await page.eval("document.getElementById('find-status').getAttribute('role')"), 'status');
    assert.notEqual(await page.eval("getComputedStyle(document.getElementById('find-status')).display"), 'none', 'the region exists before it first speaks');
    assert.equal(await page.eval("document.getElementById('find').getAttribute('aria-describedby')"), 'find-status');
    assert.deepEqual(await page.eval("[document.getElementById('find').type, document.getElementById('find').maxLength, document.getElementById('find').autocomplete, document.querySelector('[role=search]').contains(document.getElementById('find'))]"), ['search', 60, 'off', true]);
    // Every change the region goes through while a slow typist types a name (a letter every 250 ms: the
    // lists narrow after each letter, 150 ms in, and the status waits for a 500 ms pause), and for two
    // seconds after.
    await page.eval("window.__said = []; window.__rows = []; new MutationObserver(() => window.__said.push(document.getElementById('find-status').textContent)).observe(document.getElementById('find-status'), { childList: true, subtree: true, characterData: true }); new MutationObserver(() => window.__rows.push(document.querySelectorAll('#next-list .row').length)).observe(document.getElementById('next-list'), { childList: true })");
    await typeFind(page, 'tequatl', { gap: 250, settleMs: 2200 });
    const said = await page.eval('window.__said');
    assert.equal(said.length, 1, JSON.stringify(said));
    assert.equal(said[0], '1 event matches.');
    assert.ok((await page.eval('window.__rows')).length >= 3, 'the lists narrowed while typing, letter by letter');
    await page.send('Accessibility.enable');
    const ax = async (sel) => {
      const { root } = await page.send('DOM.getDocument', {});
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const n = nodes[0];
      return { role: n.role && n.role.value, name: n.name && n.name.value, description: n.description && n.description.value };
    };
    assert.deepEqual(await ax('#find'), { role: 'searchbox', name: 'Find', description: '1 event matches.' });
    assert.deepEqual(await ax('#find-clear'), { role: 'button', name: 'Clear the search', description: undefined });
    // Countdowns elsewhere keep ticking; the region stays quiet.
    await sleep(2100);
    assert.equal((await page.eval('window.__said')).length, 1, 'no repeat while nothing changes');
  } finally { await page.close(); }
});

check('Find: on a phone the filters fold under one button beside Find, the events start on the first screen, and the fold is never saved', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), width: 390, height: 844, mobile: true });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    const state = () => page.eval("[document.getElementById('filters-toggle').getAttribute('aria-expanded'), getComputedStyle(document.getElementById('filters-body')).display, document.querySelector('[data-filter=\"all\"]').getBoundingClientRect().height > 0]");
    assert.deepEqual(await state(), ['false', 'none', false], 'folded at first');
    assert.equal(await page.eval("document.getElementById('filters-toggle').getAttribute('aria-controls')"), 'filters-body');
    const head = await page.eval("document.getElementById('now-title').getBoundingClientRect().bottom");
    assert.ok(head < 844, `Scheduled now ends at ${head} px, inside the 844 px screen`);
    const row = await page.eval("[document.getElementById('find').getBoundingClientRect(), document.getElementById('filters-toggle').getBoundingClientRect()].map((r) => [Math.round(r.top), Math.round(r.height)])");
    assert.ok(Math.abs(row[0][0] - row[1][0]) <= 2 && row[0][1] >= 36 && row[1][1] >= 36, `Find and Filters share one line, 36 px tall: ${JSON.stringify(row)}`);
    assert.ok(Number.parseFloat(await page.eval("getComputedStyle(document.getElementById('find')).fontSize")) >= 16, 'no zoom into the field on phones');
    const saved = await page.eval(`localStorage.getItem('${PREFS}')`);
    await click(page, '#filters-toggle'); await settle();
    assert.deepEqual(await state(), ['true', 'grid', true], 'a tap opens them');
    await page.eval("document.getElementById('filters-toggle').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.deepEqual(await state(), ['false', 'none', false], 'Enter folds them again');
    await key(page, ' ', 'Space', 32); await settle();
    assert.equal((await state())[0], 'true', 'Space opens them');
    assert.equal(await page.eval(`localStorage.getItem('${PREFS}')`), saved, 'opening and folding wrote nothing');
    await click(page, '[data-filter="meta"]'); await settle();
    await click(page, '#filters-toggle'); await settle();
    assert.equal(await text(page, '#filters-summary'), 'Meta events only', 'what narrows the lists shows under the folded filters');
    assert.equal(await page.eval("getComputedStyle(document.getElementById('filters-summary')).display"), 'block');
    assert.equal(await page.eval(`JSON.parse(localStorage.getItem('${PREFS}')).filter`), 'meta');
    assert.ok(!/open|fold/i.test(await page.eval(`localStorage.getItem('${PREFS}')`)), 'the fold is not saved');
    assert.equal(saved, null, 'a fresh profile');
    await click(page, '#filters-toggle'); await settle();
    await page.reload(); await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    assert.deepEqual(await state(), ['false', 'none', false], 'folded again after a reload');
    assert.deepEqual(Object.keys(JSON.parse(await page.eval(`localStorage.getItem('${PREFS}')`))).sort(), Object.keys(SAVED).sort(), 'the saved settings gain no key');
  } finally { await page.close(); }
  const wide = await open({ at: utc('2026-10-25T23:50:00Z'), width: 1280, height: 900 });
  try {
    assert.deepEqual(await wide.eval("[getComputedStyle(document.getElementById('filters-toggle')).display, getComputedStyle(document.getElementById('filters-body')).display, getComputedStyle(document.getElementById('filters-summary')).display]"), ['none', 'grid', 'none'], 'a desktop shows every filter and no button');
  } finally { await wide.close(); }
});

check('Find: at 320, 360 and 390 px nothing scrolls sideways with the filters folded or open and a long status, and every control is 36 px tall', async () => {
  for (const [width, height] of [[320, 568], [360, 740], [390, 844]]) {
    const page = await open({ at: utc('2026-10-25T23:50:00Z'), width, height, mobile: true });
    try {
      await setPrefs(page, SAVED);
      await typeFind(page, 'world boss');
      assert.match(await findText(page), /And 10 more/);
      assert.equal((await sideways(page, width))[0], width, `${width} folded`);
      // Typed text stops before the Clear button inside the field.
      const [textEnd, clearStart] = await page.eval("(() => { const i = document.getElementById('find'), r = i.getBoundingClientRect(); return [r.right - parseFloat(getComputedStyle(i).paddingRight), document.getElementById('find-clear').getBoundingClientRect().left]; })()");
      assert.ok(textEnd <= clearStart + 0.5, `${width}: text runs to ${textEnd}, Clear starts at ${clearStart}`);
      await click(page, '#filters-toggle'); await settle();
      assert.equal((await sideways(page, width))[0], width, `${width} open`);
      const small = await page.eval("[...document.querySelectorAll('.controls button, .controls input, .controls select')].filter((b) => b.offsetParent && (b.getBoundingClientRect().height < 36 || b.getBoundingClientRect().width < 24)).map((b) => b.id || b.className)");
      assert.deepEqual(small, [], `${width}`);
    } finally { await page.close(); }
  }
});

check('Starred with nothing starred: both lists say how to star; with stars, the usual text', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const how = 'No events are starred yet. To star one, set Show to All, then select the star (☆) by its name.';
    const empties = () => page.eval("['now-empty', 'next-empty'].map((id) => document.getElementById(id).textContent)");
    await click(page, '[data-filter="meta"]'); await settle();
    assert.ok(!(await empties()).includes(how), 'only under Starred');
    await click(page, '[data-filter="starred"]'); await settle();
    assert.deepEqual(await page.eval("['now-empty', 'next-empty'].map((id) => [document.getElementById(id).hidden, document.getElementById(id).textContent])"), [[false, how], [false, how]]);
    await click(page, '[data-filter="all"]'); await settle();
    await click(page, '#next-list .row[data-id="karka-queen"] [data-star], #next-list .row [data-star]'); await settle();
    await click(page, '[data-filter="starred"]'); await settle();
    const t = await page.eval("['now-empty', 'next-empty'].map((id) => document.getElementById(id).textContent)");
    assert.ok(!t.includes(how), JSON.stringify(t));
  } finally { await page.close(); }
});

check('the weekly reset countdown stays on one line at 390 and 768 px, moving under the time whole when it does not fit beside it', async () => {
  for (const [width, height, mobile] of [[390, 844, true], [768, 1024, false], [320, 568, true]]) {
    for (const at of ['2026-10-25T17:00:00Z', '2026-10-25T20:22:00Z', '2026-10-26T08:00:00Z']) {
      const page = await open({ at: utc(at), width, height, mobile, news: { mode: 'fail' } });
      try {
        const subs = await page.eval("[...document.querySelectorAll('#strip li')].map((li) => { const s = li.querySelector('.sub'), b = s.getBoundingClientRect(), l = li.getBoundingClientRect(); return { t: s.textContent, h: b.height, line: parseFloat(getComputedStyle(s).lineHeight) || 18, inside: b.right <= l.right + 0.5 }; })");
        for (const s of subs) assert.ok(s.h < 1.5 * s.line && s.inside, `${width} px at ${at}: "${s.t}" is ${s.h} px tall${s.inside ? '' : ', past its box'}`);
      } finally { await page.close(); }
    }
  }
});

// ---- v0.3.0 Phase D: links to one event (#event/<id>) and the details dialog ----

const CANON = 'https://radmagelabs.com/gw2-timer/#event/';
const dlg = (page) => page.eval(`(() => { const d = document.getElementById('event-dialog'); const t = (s) => (d.querySelector(s) || {}).innerText || ''; return {
  open: d.open, title: t('#event-dialog-title'), when: t('#event-dialog-when').replace(/\\s+/g, ' ').trim(), why: t('.ed-why').replace(/\\s+/g, ' ').trim(),
  facts: t('.ed-facts').replace(/\\s+/g, ' ').trim(), status: t('#event-dialog-status'), active: document.activeElement.id || document.activeElement.getAttribute('data-fkey') || document.activeElement.tagName,
  hash: location.hash, notice: document.getElementById('link-notice').hidden ? '' : document.getElementById('link-notice-text').textContent }; })()`);
/** A tab whose address carries `hash` when the page loads, with the given settings already saved. */
async function openLink(hash, { prefs = null, overrides = null, beforeLoad = null, ...opts } = {}) {
  const page = await open(opts);
  if (prefs) await page.eval(`localStorage.setItem('${PREFS}', ${JSON.stringify(JSON.stringify(prefs))})`);
  if (overrides) await page.eval(`localStorage.setItem('gw2-timer:v1:overrides', ${JSON.stringify(JSON.stringify(overrides))})`);
  if (beforeLoad) await page.beforeLoad(beforeLoad);
  await page.eval(`history.replaceState(null, '', ${JSON.stringify(hash)})`);
  await page.reload();
  await page.waitFor("document.querySelectorAll('#next-list .row, #next-empty:not([hidden])').length > 0");
  await sleep(100);
  return page;
}
// Copy link and Copy waypoint, recorded instead of reaching the system clipboard (or refused, with refuse: true).
const CLIP = (refuse) => `(() => { const w = (t) => { window.__copied = t; return ${refuse ? "Promise.reject(new Error('refused'))" : 'Promise.resolve()'}; };
  try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: w, readText: () => Promise.resolve(window.__copied || '') }, configurable: true }); } catch (e) {}
  ${refuse ? 'document.execCommand = () => false;' : ''} })();`;

check('Link: #event/<id> opened directly shows the event over the reader\'s own page, in Chicago and London: where, next start in local time and UTC with a countdown, focus on its name', async () => {
  for (const [tz, start] of [['America/Chicago', '7:00 PM'], ['Europe/London', 'Tomorrow 12:00 AM']]) {
    const page = await openLink('#event/tequatl-the-sunless', { at: utc('2026-10-25T23:50:00Z'), tz });
    try {
      const d = await dlg(page);
      assert.equal(d.open, true, tz);
      assert.equal(d.title, 'Tequatl the Sunless');
      assert.match(d.when, new RegExp(`^Next scheduled start: ${start} \\(00:00 UTC\\), in (10m 00|9m 5\\d)s\\.$`), `${tz}: ${d.when}`);
      assert.match(d.facts, /^Where Sparkfly Fen, Core Tyria How often Daily at 00:00, 03:00, 07:00, 11:30, 16:00, 19:00 UTC, runs about 30 min\. How sure Documented: at least two independent written sources agree on this time\. It has not been checked in game\.$/);
      assert.match(await text(page, '#event-dialog .ed-live'), /^Scheduled, not live: the game has no public live-event feed/, 'scheduled, never presented as live');
      assert.equal(d.why, '', 'it is in the lists, so no note');
      assert.equal(d.active, 'event-dialog-title', 'focus on the name');
      assert.ok((await rows(page)).length > 10, 'the reader\'s own page is behind it');
      assert.equal(await page.eval(`localStorage.getItem('${PREFS}')`), null, 'opening a link saved nothing');
      assert.deepEqual(page.requests.filter((u) => !u.startsWith(BASE) && u !== FEED_URL), [], 'no request leaves the site');
      assert.deepEqual(unexpected(page), []);
    } finally { await page.close(); }
  }
  // Upper case, an escaped dash and one trailing slash are the same link.
  for (const hash of ['#event/TEQUATL-THE-SUNLESS', '#event/tequatl%2Dthe%2Dsunless', '#event/tequatl-the-sunless/']) {
    const page = await openLink(hash, { at: utc('2026-10-25T23:50:00Z') });
    try { assert.deepEqual([(await dlg(page)).open, (await dlg(page)).title], [true, 'Tequatl the Sunless'], hash); } finally { await page.close(); }
  }
});

check('Link: an event in its window says until when, and only its countdown changes while it is open', async () => {
  const page = await openLink('#event/shadow-behemoth', { at: utc('2026-10-25T23:50:00Z') });
  try {
    const a = await dlg(page);
    assert.match(a.when, /^Scheduled now, until 7:00 PM \(00:00 UTC\)\. Window closes in (10m 00|9m 5\d)s\.$/, a.when);
    await page.eval("window.__rebuilt = 0; new MutationObserver(() => window.__rebuilt++).observe(document.getElementById('event-dialog-body'), { childList: true })");
    await sleep(2300);
    assert.notEqual((await dlg(page)).when, a.when, 'the countdown ticks');
    assert.equal(await page.eval('window.__rebuilt'), 0, 'the rest of the dialog is not rebuilt every second');
  } finally { await page.close(); }
});

check('Link: a hidden or filtered event still opens with every reason it has no row, and nothing saved changes; Star in the details saves like any star', async () => {
  const page = await openLink('#event/claw-of-jormag', { at: utc('2026-10-25T23:50:00Z'), prefs: SAVED });
  try {
    const saved = await page.eval(`localStorage.getItem('${PREFS}')`);
    const d = await dlg(page);
    assert.equal(d.open, true);
    assert.equal(d.why, 'Not in your lists right now: on your Hidden list; Core Tyria is off in Regions; Show is set to Meta events. Opening it here changed none of your settings.');
    assert.match(d.when, /^Next scheduled start: 9:30 PM \(02:30 UTC\), in 2h 3\dm\.$/);
    assert.equal(await page.eval(`localStorage.getItem('${PREFS}')`), saved, 'byte-identical');
    assert.equal(await page.eval("document.getElementById('hidden-btn').textContent"), 'Hidden (1)');
    // Star: the same setting as everywhere else, saved, and the dialog follows.
    await page.eval("document.querySelector('#event-dialog [data-star]').focus()");
    await key(page, ' ', 'Space', 32); await settle();
    assert.equal(await page.eval("document.querySelector('#event-dialog [data-star]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await page.eval("document.activeElement.getAttribute('data-fkey')"), 'dlg:star', 'focus stays on Star');
    assert.ok(JSON.parse(await page.eval(`localStorage.getItem('${PREFS}')`)).starred.includes('claw-of-jormag'));
    await click(page, '#event-dialog [data-close]'); await settle();
    // A search that leaves it out is a reason too.
    await typeFind(page, 'wurm');
    await page.eval("location.hash = '#event/drakkar'");
    await page.waitFor("document.getElementById('event-dialog').open");
    assert.equal((await dlg(page)).why, 'Not in your lists right now: it does not match your search; Show is set to Meta events. Opening it here changed none of your settings.');
  } finally { await page.close(); }
});

check('Link: an adjusted event shows the reader\'s own time and the default; Copy link gives the canonical address with the event id and nothing else, and says so in the dialog', async () => {
  const page = await openLink('#event/shackles-of-the-ancients', { at: utc('2026-10-25T23:50:00Z'), overrides: { 'shackles-of-the-ancients': { offsetMin: 70, setAt: 1 } } });
  try {
    const d = await dlg(page);
    assert.match(d.when, /^Next scheduled start: 8:10 PM \(01:10 UTC\), in 1h 1\dm\.$/, d.when);
    assert.match(d.facts, /How often Yours, set with Adjust in this browser: every 2 h from 01:10 UTC, runs about 25 min\. Default: every 2 h from 01:15 UTC\./);
    assert.ok(await page.eval("Boolean(document.querySelector('#event-dialog .badge.adjusted'))"));
    await click(page, '#event-dialog [data-copy-link]');
    await page.waitFor("document.getElementById('event-dialog-status').textContent !== ''");
    const copied = await page.eval('navigator.clipboard.readText()');
    assert.equal(copied, `${CANON}shackles-of-the-ancients`);
    assert.match(copied, /^https:\/\/radmagelabs\.com\/gw2-timer\/#event\/[a-z0-9-]+$/, 'nothing but the id: no offset, star, filter or time');
    assert.equal((await dlg(page)).status, 'Copied the link to Shackles of the Ancients.');
    assert.equal(await page.eval("document.getElementById('event-dialog-status').getAttribute('role')"), 'status');
    // Copy waypoint inside the dialog speaks there too, not behind the backdrop.
    await click(page, '#event-dialog [data-copy]');
    await page.waitFor("/^Copied \\[/.test(document.getElementById('event-dialog-status').textContent)");
    assert.equal(await page.eval("document.getElementById('toast').classList.contains('show')"), false);
  } finally { await page.close(); }
});

const HOSTILE_HASHES = [
  ['#event/zqx-unknown-boss', 'unknown'],
  ['#event/tequatl-the-sunless-zqx', 'unknown'],
  ['#event/__proto__', 'malformed'],
  ['#event/zqx%3Cimg%20src%3Dx%20onerror%3Dwindow.__pwned%3D1%3E', 'malformed'],
  ['#event/' + 'zqx'.repeat(30), 'malformed'],
  ['#event/zqx%E0%A4%A', 'malformed'],
  ['#event/tequatl-the-sunless/zqx', 'malformed'],
  ['#event/zqx..%2F..%2Fetc', 'malformed'],
];
check('Link: unusable links open nothing, say so in fixed words, never write the link into the page, and change nothing saved', async () => {
  const words = { unknown: 'That link names an event this timer does not cover. It may have been renamed or removed. Nothing of yours was changed.', malformed: 'That link to an event could not be read. Nothing of yours was changed.' };
  for (const [hash, reason] of HOSTILE_HASHES) {
    const page = await openLink(hash, { at: utc('2026-10-25T23:50:00Z'), prefs: SAVED, overrides: { 'secrets-of-the-weald': { offsetMin: 105, setAt: 1 } } });
    try {
      const store = await page.eval("JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))");
      const d = await dlg(page);
      assert.equal(d.open, false, hash);
      assert.equal(d.notice, words[reason], hash);
      const html = await page.eval('document.documentElement.outerHTML + document.title');
      assert.ok(!/zqx|__proto__|onerror/.test(html), `${hash}: the link's text reached the page`);
      assert.equal(await page.eval('typeof window.__pwned'), 'undefined');
      assert.equal(await page.eval("JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))"), store);
      assert.deepEqual(JSON.parse(await page.eval(`localStorage.getItem('${PREFS}')`)), SAVED, 'the saved settings are as they were');
      assert.deepEqual(unexpected(page), [], hash);
    } finally { await page.close(); }
  }
  // Dismiss takes the bad link out of the address; a later good link hides the notice; a bad link typed
  // over an open dialog closes it and stays in the address while the notice says why.
  const page = await openLink('#event/zqx-unknown-boss', { at: utc('2026-10-25T23:50:00Z') });
  try {
    await click(page, '#link-notice-dismiss'); await settle();
    assert.deepEqual([(await dlg(page)).notice, (await dlg(page)).hash], ['', '']);
    await page.eval("location.hash = '#event/zqx-again'"); await settle();
    assert.notEqual((await dlg(page)).notice, '');
    await page.eval("document.querySelector('#next-list .row a.event-link').click()");
    await page.waitFor("document.getElementById('event-dialog').open");
    assert.equal((await dlg(page)).notice, '', 'a link that works hides the notice');
    await page.eval("location.hash = '#event/zqx-typed'"); await settle();
    const d = await dlg(page);
    assert.deepEqual([d.open, d.hash, d.notice === words.unknown], [false, '#event/zqx-typed', true]);
  } finally { await page.close(); }
});

check('Link: the page\'s own anchors are untouched: #event-index and #now-title open nothing, and the skip links still move focus', async () => {
  for (const hash of ['#event-index', '#now-title', '#coming-title', '#event', '#events/drakkar']) {
    const page = await openLink(hash, { at: utc('2026-10-25T23:50:00Z') });
    try {
      const d = await dlg(page);
      assert.deepEqual([d.open, d.notice, d.hash], [false, '', hash], hash);
    } finally { await page.close(); }
  }
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.eval("document.querySelectorAll('.skip')[1].focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.deepEqual([await page.eval('document.activeElement.id'), (await dlg(page)).open], ['coming-title', false]);
  } finally { await page.close(); }
});

check('Link: a name opens the details in the open tab with one history entry; Back closes them, Forward opens them again; Escape closes them, takes the event out of the address and returns focus to the name', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const h0 = await page.eval('history.length');
    const sel = '#next-list .row[data-id="tequatl-the-sunless"] a.event-link';
    assert.equal(await page.eval(`document.querySelector('${sel}').getAttribute('href')`), '#event/tequatl-the-sunless');
    await page.eval(`document.querySelector('${sel}').focus()`);
    await key(page, 'Enter', 'Enter', 13);
    await page.waitFor("document.getElementById('event-dialog').open");
    assert.deepEqual([(await dlg(page)).hash, await page.eval('history.length')], ['#event/tequatl-the-sunless', h0 + 1]);
    const nameKey = await page.eval(`document.querySelector('${sel}').getAttribute('data-fkey')`);
    await page.eval('history.back()');
    await page.waitFor("!document.getElementById('event-dialog').open");
    assert.equal((await dlg(page)).hash, '');
    assert.equal(await page.eval('document.activeElement.getAttribute("data-fkey")'), nameKey, 'Back returns focus to the name');
    await page.eval('history.forward()');
    await page.waitFor("document.getElementById('event-dialog').open");
    assert.equal((await dlg(page)).title, 'Tequatl the Sunless');
    // Starring rebuilds the lists behind the dialog; Escape still finds the name again.
    await click(page, '#event-dialog [data-star]'); await settle();
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('event-dialog').open && location.hash === ''");
    assert.equal(await page.eval('history.length'), h0 + 1, 'closing added no entry');
    assert.equal(await page.eval('document.activeElement.getAttribute("data-fkey")'), nameKey, 'focus back on the name');
    // Closing stepped back to the page's entry (it did not rewrite the event's), so Forward opens the details again.
    await page.eval('history.forward()');
    await page.waitFor("document.getElementById('event-dialog').open");
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('event-dialog').open && location.hash === ''");
    await page.reload(); await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    assert.equal((await dlg(page)).open, false, 'a reload shows the reader\'s own page');
    // The event index and the Find status open the same details.
    await click(page, '#event-index summary'); await settle();
    await click(page, '#event-index a[href="#event/drakkar"]');
    await page.waitFor("document.getElementById('event-dialog').open");
    assert.equal((await dlg(page)).title, 'Drakkar');
    await click(page, '#event-dialog [data-close]');
    await page.waitFor("!document.getElementById('event-dialog').open && location.hash === ''");
    await typeFind(page, 'karka');
    await click(page, '#find-status a.event-link');
    await page.waitFor("document.getElementById('event-dialog').open");
    assert.equal((await dlg(page)).why, 'Not in your lists right now: starts after the 2 hours shown in Coming up. Opening it here changed none of your settings.');
  } finally { await page.close(); }
});

check('Link: opened directly, closing drops the event from the address in place: no new history entry, nothing to reopen on reload; modified clicks stay the browser\'s', async () => {
  const page = await openLink('#event/drakkar', { at: utc('2026-10-25T23:50:00Z') });
  try {
    const h0 = await page.eval('history.length');
    await click(page, '#event-dialog [data-close]'); await settle();
    assert.deepEqual([(await dlg(page)).open, (await dlg(page)).hash, await page.eval('history.length')], [false, '', h0]);
    assert.equal(await page.eval('document.activeElement === document.body'), true, 'opened from a link, the details had no opener: focus stays where the browser leaves it');
    await page.reload(); await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    assert.equal((await dlg(page)).open, false);
    // A click with Ctrl, or not with the main button, is left to the browser (a new tab); a plain one opens the details.
    // Whether the page took the click is read on window, after the page's own handler, which then stops the browser following it here.
    const taken = await page.eval("[{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }, {}].map((o) => { let took = null; window.addEventListener('click', (e) => { took = e.defaultPrevented; e.preventDefault(); }, { once: true }); document.querySelector('#next-list a.event-link').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...o })); return took && document.getElementById('event-dialog').open; })");
    assert.deepEqual(taken, [false, false, false, false, true]);
  } finally { await page.close(); }
});

check('Link: Copy link from a file and from another address gives the canonical address; with the clipboard refused, the link is shown selected', async () => {
  for (const url of [pathToFileURL(join(DIR, 'index.html')).href + '#event/karka-queen', `${BASE}#event/karka-queen`]) {
    const page = await chrome.newPage();
    try {
      await page.emulate({ timezone: 'America/Chicago', locale: 'en-US' });
      await page.startClockAt(utc('2026-10-25T23:50:00Z'));
      await page.beforeLoad(CLIP(false));
      await page.goto(url);
      await page.waitFor("document.getElementById('event-dialog').open");
      await click(page, '#event-dialog [data-copy-link]');
      await page.waitFor('window.__copied');
      assert.equal(await page.eval('window.__copied'), `${CANON}karka-queen`, url);
      assert.deepEqual(unexpected(page), [], url);
    } finally { await page.close(); }
  }
  const page = await openLink('#event/karka-queen', { at: utc('2026-10-25T23:50:00Z'), beforeLoad: CLIP(true) });
  try {
    await click(page, '#event-dialog [data-copy-link]');
    await page.waitFor("!document.getElementById('event-dialog-linkbox').hidden");
    assert.deepEqual(await page.eval("(() => { const i = document.getElementById('event-dialog-link'); return [i.value, document.activeElement === i, i.selectionStart, i.selectionEnd === i.value.length]; })()"), [`${CANON}karka-queen`, true, 0, true]);
    assert.match((await dlg(page)).status, /^Copy did not work here\. The link is selected in the box/);
  } finally { await page.close(); }
});

check('Link: screen readers and keyboard: a modal named by the event and described by its start; names say they open a dialog; Tab stays inside; Escape returns to the page', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.send('Accessibility.enable');
    const ax = async (sel) => {
      const { root } = await page.send('DOM.getDocument', {});
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const n = nodes[0], prop = (k) => ((n.properties || []).find((p) => p.name === k) || {}).value;
      return { role: n.role && n.role.value, name: n.name && n.name.value, description: n.description && n.description.value, haspopup: prop('hasPopup') && prop('hasPopup').value, modal: prop('modal') && prop('modal').value };
    };
    const link = await ax('#next-list .row[data-id="tequatl-the-sunless"] a.event-link');
    assert.deepEqual([link.role, link.name, link.haspopup], ['link', 'Tequatl the Sunless', 'dialog']);
    await page.eval("document.querySelector('#next-list .row[data-id=\"tequatl-the-sunless\"] a.event-link').focus()");
    await key(page, 'Enter', 'Enter', 13);
    await page.waitFor("document.getElementById('event-dialog').open");
    const d = await ax('#event-dialog');
    assert.deepEqual([d.role, d.name, d.modal], ['dialog', 'Tequatl the Sunless', true]);
    assert.match(d.description, /^Next scheduled start: 7:00 PM \(00:00 UTC\), in/);
    // Tab goes round the dialog and may step out to the browser's own controls, never to the page behind.
    const where = [];
    for (let i = 0; i < 14; i++) { await key(page, 'Tab', 'Tab', 9); where.push(await page.eval("(() => { const a = document.activeElement; return !a || a === document.body ? 'browser' : document.getElementById('event-dialog').contains(a) ? 'dialog' : 'page:' + (a.id || a.className); })()")); }
    assert.ok(!where.some((w) => w.startsWith('page:')) && where.filter((w) => w === 'dialog').length >= 10, where.join(','));
    const names = await page.eval("[...document.querySelectorAll('#event-dialog button, #event-dialog a')].map((b) => b.getAttribute('aria-label') || b.textContent.trim())");
    assert.deepEqual(names, ['Close', 'Star Tequatl the Sunless', 'Copy waypoint for Tequatl the Sunless: [&BNABAAA=]', 'Tequatl the Sunless on the Guild Wars 2 Wiki (opens a new tab)', 'Copy a link to Tequatl the Sunless', 'Add to calendar: Tequatl the Sunless']);
    assert.ok(!(await page.eval("[...document.querySelectorAll('#event-dialog *')].filter((n) => n.childElementCount === 0).map((n) => n.textContent).join(' ')")).includes('★'), 'the star glyph stays out of the names');
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('event-dialog').open");
    assert.equal(await page.eval('document.activeElement.classList.contains("event-link")'), true);
  } finally { await page.close(); }
});

check('Link: a close event that comes after the details were opened again (Back then Forward at once; Chrome on Linux sends it late) leaves them open with their event, and Escape still clears the address and returns focus to the name', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const h0 = await page.eval('history.length');
    const sel = '#next-list .row[data-id="tequatl-the-sunless"] a.event-link';
    await page.eval(`document.querySelector('${sel}').focus()`);
    await key(page, 'Enter', 'Enter', 13);
    await page.waitFor("document.getElementById('event-dialog').open");
    const nameKey = await page.eval(`document.querySelector('${sel}').getAttribute('data-fkey')`);
    // What Back and then Forward do (each runs the page's hashchange handler), in one task, so the close event
    // of the first can only come after the second has opened the details again.
    const between = await page.eval(`(() => { const st = history.state;
      history.replaceState(null, '', location.pathname + location.search); dispatchEvent(new HashChangeEvent('hashchange'));
      const closed = !document.getElementById('event-dialog').open;
      history.replaceState(st, '', '#event/tequatl-the-sunless'); dispatchEvent(new HashChangeEvent('hashchange'));
      return closed; })()`);
    assert.equal(between, true, 'Back closed the details in between');
    await sleep(400);
    const d = await dlg(page);
    assert.deepEqual([d.open, d.hash, d.title], [true, '#event/tequatl-the-sunless', 'Tequatl the Sunless'], 'still open, with its event and address');
    // Starring rebuilds the lists behind the dialog, so the name is found again, not just refocused.
    await click(page, '#event-dialog [data-star]'); await settle();
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('event-dialog').open && location.hash === ''", 3000);
    assert.equal(await page.eval('history.length'), h0 + 1, 'closing added no entry');
    assert.equal(await page.eval('document.activeElement.getAttribute("data-fkey")'), nameKey, 'focus back on the name');
  } finally { await page.close(); }
});

check('Link: when its event leaves the lists while the details are open (unstarred under Show: Starred), closing them puts focus on the Coming up heading, never nowhere', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), seed: { [PREFS]: { filter: 'starred', starred: ['tequatl-the-sunless'] } } });
  try {
    const sel = '#next-list .row[data-id="tequatl-the-sunless"] a.event-link';
    await page.eval(`document.querySelector('${sel}').focus()`);
    await key(page, 'Enter', 'Enter', 13);
    await page.waitFor("document.getElementById('event-dialog').open");
    await click(page, '#event-dialog [data-star]'); await settle();
    assert.equal(await page.eval(`document.querySelectorAll('#next-list [data-id="tequatl-the-sunless"], #now-list [data-id="tequatl-the-sunless"]').length`), 0, 'it left the lists');
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('event-dialog').open && location.hash === ''", 3000);
    assert.equal(await page.eval('document.activeElement.id'), 'coming-title');
  } finally { await page.close(); }
});

check('Link: when its start comes while the details are open, closing them puts focus on its name in Scheduled now', async () => {
  const page = await open({ at: utc('2026-10-25T23:59:57Z') });
  try {
    const sel = '#next-list .row[data-id="tequatl-the-sunless"] a.event-link';
    await page.eval(`document.querySelector('${sel}').focus()`);
    await key(page, 'Enter', 'Enter', 13);
    await page.waitFor("document.getElementById('event-dialog').open");
    await page.waitFor(`Boolean(document.querySelector('#now-list [data-fkey="now:tequatl-the-sunless:name"]')) && !document.querySelector('#next-list .row[data-id="tequatl-the-sunless"]')`, 8000);
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('event-dialog').open && location.hash === ''", 3000);
    assert.equal(await page.eval('document.activeElement.getAttribute("data-fkey")'), 'now:tequatl-the-sunless:name');
  } finally { await page.close(); }
});

check('Link: the details fit a 320, 360 and 390 px phone and a desktop: no sideways scroll, 36 px controls, name links big enough to tap', async () => {
  for (const [width, height, mobile] of [[320, 568, true], [360, 740, true], [390, 844, true], [1280, 900, false]]) {
    const page = await openLink('#event/claw-of-jormag', { at: utc('2026-10-25T23:50:00Z'), width, height, mobile, prefs: SAVED });
    try {
      const r = await page.eval("(() => { const d = document.getElementById('event-dialog'), b = d.getBoundingClientRect(); return { left: b.left, right: b.right, inner: d.scrollWidth <= d.clientWidth, page: document.documentElement.scrollWidth }; })()");
      assert.ok(r.left >= 0 && r.right <= width && r.inner && r.page <= width, `${width}: ${JSON.stringify(r)}`);
      if (mobile) {
        const small = await page.eval("[...document.querySelectorAll('#event-dialog button, #event-dialog a.btn')].filter((b) => b.getBoundingClientRect().height < 36).map((b) => b.textContent)");
        assert.deepEqual(small, [], `${width}`);
        await click(page, '#event-dialog [data-close]'); await settle();
        const names = await page.eval("[...document.querySelectorAll('#next-list a.event-link, #now-list a.event-link')].map((a) => a.getBoundingClientRect().height)");
        assert.ok(names.length > 3 && names.every((x) => x >= 36), `${width}: name links ${JSON.stringify(names.slice(0, 4))} px tall to tap`);
        // Whatever the font: a link's height is its font's glyph box plus its padding. Times New Roman and Arial (on
        // Ubuntu, their twins Liberation Serif and Sans) have about the shortest boxes of the common fonts; CI's
        // Ubuntu gave 35 px with a fixed 8 px of padding.
        const tight = await page.eval(`(() => { const links = [...document.querySelectorAll('#next-list a.event-link, #now-list a.event-link')], out = {};
          for (const f of ['"Times New Roman", "Liberation Serif"', 'Arial, "Liberation Sans"']) { for (const a of links) a.style.fontFamily = f; out[f] = Math.min(...links.map((a) => a.getBoundingClientRect().height)); }
          for (const a of links) a.style.fontFamily = ''; return out; })()`);
        assert.ok(Object.values(tight).every((x) => x >= 36), `${width}: name links in a font with short glyph boxes: ${JSON.stringify(tight)}`);
        // In a Coming up row the name is a flex item, as tall as its line and its padding: it makes the row no
        // taller than the star beside it.
        const rows = await page.eval(`[...document.querySelectorAll('#next-list .line1')].map((l) => { const a = l.querySelector('a.event-link'), s = l.querySelector('[data-star]'), rg = document.createRange(); rg.selectNodeContents(a);
          return [new Set([...rg.getClientRects()].map((x) => Math.round(x.bottom))).size, Math.round(a.getBoundingClientRect().height - s.getBoundingClientRect().height)]; }).filter(([n]) => n === 1).map(([, d]) => d)`);
        assert.ok(rows.length > 3 && rows.every((d) => d <= 2), `${width}: one-line names in Coming up taller than their star by ${JSON.stringify(rows.slice(0, 4))} px`);
      }
    } finally { await page.close(); }
  }
});

// ---- v0.3.0 Phase E: reminders on the page ----

const MIN = 60000, DAY = 86400000;
const TITLE = 'GW2 Timer | Unofficial Guild Wars 2 Fansite';
const RSET = 'gw2-timer:v1:reminders', RDONE = 'gw2-timer:v1:reminded';
const ON = { on: true, lead: 10, notify: false };
// Tequatl, Admiral Taidha Covington, Kaineng Blackout and Defense of Amnytas all start then (7:00 PM in Chicago).
const T0 = utc('2026-10-26T00:00:00Z');
const FOUR = ['tequatl-the-sunless', 'admiral-taidha-covington', 'kaineng-blackout', 'defense-of-amnytas'];
const ALLOW = [/ERR_FAILED/]; // the clock check failed on purpose (clock: 'fail')
// Every reminder announcement the page makes: when (performance.now and the page's own Date.now), where,
// and whether the clock had been corrected by then. One entry per write of text: two writes in one task,
// or the same sentence written twice, are two entries.
const LISTEN = `(() => { window.__said = [];
  new MutationObserver((ms) => {
    for (const m of ms) {
      const n = m.target.nodeType === 1 ? m.target : m.target.parentElement, a = n && n.closest && n.closest('[data-announce]');
      const text = !a ? '' : m.type === 'characterData' ? m.target.data : [...m.addedNodes].map((x) => x.textContent).join('');
      if (text) window.__said.push({ t: performance.now(), wall: Date.now(), text, where: a.id || (a.closest('dialog') || {}).id || '', corrected: !document.getElementById('clock-notice').hidden });
    }
  }).observe(document, { subtree: true, childList: true, characterData: true }); })();`;
// Phase E must never touch browser notifications: a stand-in counts any use.
const NOTIFY = `(() => { window.__notify = { made: 0, asked: 0 }; const N = function () { window.__notify.made++; }; N.permission = 'default';
  N.requestPermission = () => { window.__notify.asked++; return Promise.resolve('default'); }; window.Notification = N; })();`;
const COUNT_WRITES = `(() => { window.__writes = {}; const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) { window.__writes[k] = (window.__writes[k] || 0) + 1; return set.call(this, k, v); }; })();`;
const COUNT_READS = `(() => { window.__reads = {}; const get = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) { window.__reads[k] = (window.__reads[k] || 0) + 1; return get.call(this, k); }; })();`;
const CLOCK_SPY = `(() => { const f = window.fetch; window.fetch = (...a) => f(...a).catch((e) => { if (/clock=/.test(String(a[0]))) window.__clockFailed = performance.now(); throw e; }); })();`;
const LOCK_SPY = `(() => { window.__locks = []; const l = navigator.locks; if (!l) return; const req = l.request.bind(l);
  l.request = (name, ...rest) => { window.__locks.push(name); return req(name, ...rest); }; })();`;
const NO_LOCKS = `(() => { try { Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true }); } catch (e) {} })();`;
const SLOW_LOCK = `(() => { window.__lockCalls = 0; const l = navigator.locks; const req = l.request.bind(l);
  l.request = (name, fn) => { window.__lockCalls++; return new Promise((ok) => setTimeout(ok, 2500)).then(() => req(name, fn)); }; })();`;
const BLOCK_STORAGE = `(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('The operation is insecure.', 'SecurityError'); }, configurable: true }); })();`;
const FAIL_WRITES = `(() => { Storage.prototype.setItem = function () { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); }; })();`;

/** A tab with reminder settings, stars, Adjust times and records saved before the page first loads. */
const openR = ({ prefs, overrides, reminders = ON, records, init = [], ...opts } = {}) => open({ ...opts, init: [LISTEN, ...init],
  seed: { ...(prefs ? { [PREFS]: prefs } : {}), ...(overrides ? { 'gw2-timer:v1:overrides': overrides } : {}), ...(reminders ? { [RSET]: reminders } : {}), ...(records ? { [RDONE]: records } : {}) } });
const trayState = (page) => page.eval(`(() => { const t = document.getElementById('reminders-tray'), ns = [...t.querySelectorAll('.rm-notice')], more = document.getElementById('reminders-more');
  return { shown: !t.hidden, ids: ns.map((n) => n.dataset.id), starts: ns.map((n) => Number(n.dataset.start)), texts: ns.map((n) => n.innerText.replace(/\\s+/g, ' ').trim()),
    more: more.hidden || document.getElementById('reminders-foot').hidden ? '' : more.textContent, title: document.title, said: window.__said || [] }; })()`);
const saved = async (page, k) => JSON.parse(await page.eval(`localStorage.getItem('${k}')`));
const jump = (page, ms) => page.eval(`(() => { const prev = Date.now; Date.now = () => prev() + ${ms}; })()`);
const pageNow = (page) => page.eval('Date.now()');
/** Text whose contrast with its background is below 4.5:1, among the elements `sel` finds. */
const lowContrast = (page, sel) => page.eval(`(() => {
  const lum = (c) => { const v = c.match(/[\\d.]+/g).slice(0, 3).map(Number).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const bg = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c !== 'transparent' && !/^rgba\\(.*,\\s*0\\)$/.test(c)) return c; } return 'rgb(255, 255, 255)'; };
  return [...document.querySelectorAll(${JSON.stringify(sel)})].filter((el) => el.getClientRects().length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    .map((el) => { const a = lum(getComputedStyle(el).color), b = lum(bg(el)); return [el.className || el.tagName, (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)]; })
    .filter(([, r]) => r < 4.5).map(([c, r]) => c + ' ' + r.toFixed(2)); })()`);

check('Reminders: off by default: nothing reminded, saved or asked for; the dialog lists the starred events and says what reminders can and cannot do', async () => {
  const page = await openR({ at: utc('2026-10-25T23:52:00Z'), prefs: { starred: ['tequatl-the-sunless', 'claw-of-jormag'], hidden: ['claw-of-jormag'] }, reminders: null, clock: 'fail', init: [NOTIFY] });
  try {
    await sleep(2500);
    const t = await trayState(page);
    assert.deepEqual([t.shown, t.title, t.said.length], [false, TITLE, 0]);
    assert.equal(await text(page, '#reminders-btn'), 'Reminders: off');
    assert.deepEqual(await page.eval(`[localStorage.getItem('${RSET}'), localStorage.getItem('${RDONE}')]`), [null, null], 'nothing saved');
    await page.eval("document.getElementById('reminders-btn').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    const d = await page.eval(`(() => { const d = document.getElementById('reminders-dialog'); return { open: d.open, on: document.getElementById('reminders-on').checked,
      lead: document.querySelector('[name="reminders-lead"]:checked').value, leads: [...document.querySelectorAll('[name="reminders-lead"]')].map((r) => r.value),
      list: [...d.querySelectorAll('#reminders-list li')].map((li) => li.textContent), text: d.innerText.replace(/\\s+/g, ' ') }; })()`);
    assert.deepEqual([d.open, d.on, d.lead, d.leads], [true, false, '10', ['5', '10', '15']]);
    assert.deepEqual(d.list, ['Tequatl the Sunless: starts 7:00 PM (00:00 UTC); no reminder while reminders are off.', 'Claw of Jormag: starts 9:30 PM (02:30 UTC); hidden, so no reminder.']);
    for (const promise of [/only while this page is open in a tab\. Nothing can remind you when the page or the browser is closed/, /It is not a notification from your browser or your computer\./,
      /up to about a minute late/, /"always keep these sites active"/, /A reminder that would arrive after its event has started is not shown\./, /For an event marked Unverified, or one you have adjusted, the reminder says so\./]) assert.match(d.text, promise);
    assert.ok(!/we will notify|you will be notified|even when (the page|it) is closed/i.test(d.text), 'nothing promises a notification');
    await key(page, 'Escape', 'Escape', 27); await settle();
    assert.deepEqual(await page.eval("[document.getElementById('reminders-dialog').open, document.activeElement.id]"), [false, 'reminders-btn'], 'Escape closes and returns focus');
    assert.deepEqual(await page.eval('window.__notify'), { made: 0, asked: 0 }, 'no browser notification, and no permission asked');
    assert.deepEqual(await page.eval(`localStorage.getItem('${RSET}')`), null, 'opening and closing saves nothing');
    assert.deepEqual(unexpected(page, ALLOW), []);
  } finally { await page.close(); }
});

check('Reminders: turned on with a starred event inside its lead time, it is reminded at once: notice, title count, one announcement, the saved record; it ticks with no word, no rebuild, no write and no layout shift; Dismiss keeps it given', async () => {
  const page = await openR({ at: utc('2026-10-25T23:52:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, reminders: null, clock: 'fail', init: [NOTIFY, COUNT_WRITES] });
  try {
    await sleep(600);
    await click(page, '#reminders-btn'); await settle();
    await page.eval("window.__shiftFrom = performance.now()");
    await click(page, '#reminders-on');
    await page.waitFor("!document.getElementById('reminders-tray').hidden", 3000);
    assert.deepEqual(await saved(page, RSET), ON);
    assert.equal(await text(page, '#reminders-btn'), 'Reminders: 10 min');
    let t = await trayState(page);
    assert.deepEqual(t.said.map((s) => [s.text, s.where]), [['Reminder: Tequatl the Sunless starts at 7:00 PM, in 8 minutes.', 'reminders-dialog']], 'said once, in the open dialog');
    assert.match(await text(page, '#reminders-list li'), /^Tequatl the Sunless: starts 7:00 PM \(00:00 UTC\); reminder given\.$/);
    await key(page, 'Escape', 'Escape', 27); await settle();
    t = await trayState(page);
    assert.deepEqual([t.ids, t.title, t.more], [['tequatl-the-sunless'], `(1) ${TITLE}`, '']);
    assert.deepEqual(await page.eval("[document.getElementById('reminders-foot').hidden, document.getElementById('reminders-unsaved').hidden]"), [true, true], 'one notice: no Show more or Dismiss all; and settings are being saved');
    assert.match(t.texts[0], /^Reminder Tequatl the Sunless Starts 7:00 PM \(00:00 UTC\) · in 7m 5\ds Copy waypoint Dismiss$/i);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#reminders-tray button')].filter((b) => b.closest('.rm-notice')).map((b) => b.getAttribute('aria-label'))"),
      ['Copy waypoint for Tequatl the Sunless: [&BNABAAA=]', 'Dismiss the reminder for Tequatl the Sunless']);
    const rec = await saved(page, RDONE);
    assert.deepEqual([Object.keys(rec), rec['tequatl-the-sunless'].start, typeof rec['tequatl-the-sunless'].by], [['tequatl-the-sunless'], T0, 'string']);
    // Ticking: the countdown moves; the notice is not rebuilt, nothing more is said and nothing is written.
    await page.eval("window.__card = document.querySelector('.rm-notice'); window.__w = JSON.stringify(window.__writes)");
    const c1 = await text(page, '.rm-left'); await sleep(2300); const c2 = await text(page, '.rm-left');
    assert.notEqual(c1, c2);
    assert.equal(await page.eval("window.__card === document.querySelector('.rm-notice')"), true, 'the notice is not rebuilt as it counts down');
    assert.equal(await page.eval('JSON.stringify(window.__writes) === window.__w'), true, 'nothing is written while it ticks');
    assert.equal((await trayState(page)).said.length, 1, 'nothing more is said');
    // The reminder's arrival moves nothing on the page or in the tray. What is inside the Reminders dialog may
    // reflow as the reader turns reminders on: its list's line for the event changes, and in a wider font (CI's
    // DejaVu Sans) "...; no reminder while reminders are off." takes two lines where "...; reminder given."
    // takes one. That is the reader's own action, and the dialog itself stays put (its own check, below).
    const shift = await page.eval("new Promise((ok) => { const d = document.getElementById('reminders-dialog'); let s = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.startTime > window.__shiftFrom && !e.sources.every((x) => x.node && d.contains(x.node))) s += e.value; }).observe({ type: 'layout-shift', buffered: true }); setTimeout(() => ok(s), 50); })");
    assert.ok(shift < 0.001, `layout shift ${shift} outside the dialog when the reminder came`);
    // Copy waypoint works from the notice.
    await page.eval(CLIP(false)); await click(page, '#reminders-tray [data-copy]'); await settle();
    assert.equal(await page.eval('window.__copied'), '[&BNABAAA=]');
    // Dismiss: the notice goes, focus moves to Coming up, and the start stays given.
    await page.eval("document.querySelector('[data-rm-dismiss]').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    t = await trayState(page);
    assert.deepEqual([t.shown, t.title, await page.eval('document.activeElement.id')], [false, TITLE, 'coming-title']);
    await sleep(1500);
    t = await trayState(page);
    assert.deepEqual([t.shown, t.said.length], [false, 1], 'dismissed, and not given again');
    // The next reminder is said on the page, and the line in the closed dialog is emptied.
    await click(page, '#next-list .row[data-id="kaineng-blackout"] [data-star]');
    await page.waitFor('window.__said.length === 2', 3000);
    t = await trayState(page);
    assert.deepEqual([t.said[1].text, t.said[1].where], ['Reminder: Kaineng Blackout starts at 7:00 PM, in 8 minutes.', 'reminders-announce']);
    assert.equal(await page.eval("document.querySelector('#reminders-dialog [data-announce]').textContent"), '', 'no stale sentence left in the dialog');
    assert.deepEqual(await page.eval('window.__notify'), { made: 0, asked: 0 }, 'no browser notification in Phase E');
    assert.deepEqual(page.requests.filter((u) => !u.startsWith(BASE) && u !== FEED_URL), [], 'no request leaves the site');
    assert.deepEqual(unexpected(page, ALLOW), []);
  } finally { await page.close(); }
});

check('Reminders: the dialog keeps its place when its list changes as reminders are turned on, so the switch stays under the pointer (in a wide font, Verdana here or DejaVu Sans on Ubuntu, the line for an event takes two lines when off and one when on)', async () => {
  const page = await openR({ at: utc('2026-10-25T23:52:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, reminders: null, clock: 'fail' });
  try {
    await sleep(600);
    await click(page, '#reminders-btn'); await settle();
    await page.eval(`document.getElementById('reminders-dialog').style.fontFamily = 'Verdana, "DejaVu Sans"'`); await settle();
    const where = () => page.eval("[document.getElementById('reminders-dialog').getBoundingClientRect().top, document.getElementById('reminders-on').getBoundingClientRect().top, document.querySelector('#reminders-list li').getBoundingClientRect().height]");
    const before = await where();
    await click(page, '#reminders-on');
    await page.waitFor("!document.getElementById('reminders-tray').hidden", 3000); await settle();
    const after = await where();
    assert.ok(after[2] < before[2], `the line for the event got shorter (${before[2]} -> ${after[2]}), so the dialog's height changed`);
    assert.deepEqual(after.slice(0, 2), before.slice(0, 2), 'the dialog and its switch did not move');
  } finally { await page.close(); }
});

check('Reminders: on a settled clock the notice comes at the reminder time, never before and within a second and a half, for leads of 5, 10 and 15 minutes', async () => {
  for (const lead of [10, 5, 15]) {
    const due = T0 - lead * MIN;
    const page = await openR({ at: due - 3000, prefs: { starred: ['tequatl-the-sunless'] }, reminders: { ...ON, lead }, clock: 'fail' });
    try {
      await page.waitFor('(window.__said || []).length > 0', 8000);
      await sleep(300);
      const t = await trayState(page);
      const late = t.said[0].wall - due;
      assert.ok(late >= 0 && late < 1500, `lead ${lead}: given ${late} ms after the reminder time`);
      assert.deepEqual([t.said.length, t.said[0].text], [1, `Reminder: Tequatl the Sunless starts at 7:00 PM, in ${lead} minutes.`]);
      assert.equal(await text(page, '#reminders-btn'), `Reminders: ${lead} min`);
    } finally { await page.close(); }
  }
});

check('Reminders: while the clock check has not answered, delivery waits, at most 8 seconds after load, then the reminder comes once', async () => {
  const page = await openR({ at: utc('2026-10-25T23:51:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, clock: 'hold' });
  try {
    await page.waitFor('performance.now() > 6500', 10000);
    assert.equal((await trayState(page)).shown, false, 'nothing while the check may still correct the clock');
    await click(page, '#reminders-btn'); await settle();
    assert.equal(await text(page, '#reminders-list li'), 'Tequatl the Sunless: starts 7:00 PM (00:00 UTC); reminder due now.');
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor('(window.__said || []).length > 0', 8000);
    await sleep(1200);
    const t = await trayState(page);
    assert.equal(t.said.length, 1);
    assert.ok(t.said[0].t >= 7900 && t.said[0].t <= 10000, `given ${Math.round(t.said[0].t)} ms after load`);
    assert.ok(page.clockRequests >= 1, 'the check was asked and never answered');
  } finally { await page.close(); }
});

check('Reminders: a device clock 5 minutes fast waits for the clock check: nothing early, then one reminder at the true time', async () => {
  skewMs = utc('2026-10-25T23:49:51Z') - Date.now(); // the true time at load; the device reads 23:54:51, inside Tequatl's lead
  const page = await openR({ offset: skewMs + 5 * MIN, url: SKEWED, prefs: { starred: ['tequatl-the-sunless'] } });
  try {
    await page.waitFor('(window.__said || []).length > 0', 20000);
    await sleep(300);
    const t = await trayState(page);
    assert.equal(t.said.length, 1);
    assert.equal(t.said[0].corrected, true, 'given only after the correction');
    assert.match(await text(page, '#clock-notice'), /Your device clock is (4m 5\d|5m 0\d)s fast/);
    const at = t.said[0].wall - 5 * MIN - (T0 - 10 * MIN); // the true moment it was given, against 23:50:00
    assert.ok(at > -1500 && at < 2500, `given ${at} ms from the true reminder time (the check is good to about a second)`);
    assert.match(t.said[0].text, /^Reminder: Tequatl the Sunless starts at 7:00 PM, in 10 minutes\.$/);
  } finally { await page.close(); }
});

check('Reminders: after a clock change the new clock check is waited for, so a clock jumped 6 minutes ahead gives nothing early', async () => {
  skewMs = utc('2026-10-25T23:44:00Z') - Date.now();
  const page = await openR({ offset: skewMs, url: SKEWED, prefs: { starred: ['tequatl-the-sunless'] } });
  try {
    await page.waitFor('performance.now() > 6500', 10000); // the first check has settled
    assert.equal(await page.eval("document.getElementById('clock-notice').hidden"), true, 'the device clock was right');
    await jump(page, 6 * MIN); // 23:50:06 by the device clock: Tequatl would be due
    await page.waitFor("!document.getElementById('clock-notice').hidden", 12000);
    await sleep(1500);
    const t = await trayState(page);
    assert.deepEqual([t.shown, t.said.length], [false, 0], 'nothing given by the jumped clock');
    assert.match(await text(page, '#clock-notice'), /Your device clock is (5m 5\d|6m 0\d)s fast/);
  } finally { await page.close(); }
});

check('Reminders: a clock moved back, a reload and a second tab never repeat a reminder; after a reload the tray starts empty', async () => {
  const page = await openR({ at: utc('2026-10-25T23:52:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail', init: [COUNT_READS] });
  let other = null;
  try {
    await page.waitFor('(window.__said || []).length === 1', 4000);
    await jump(page, -2 * MIN); // 23:50:0x: inside the lead time again
    await sleep(2500);
    let t = await trayState(page);
    assert.deepEqual([t.said.length, t.ids, t.starts], [1, ['tequatl-the-sunless'], [T0]], 'the clock moved back: not given again');
    await page.reload(); await sleep(2500);
    t = await trayState(page);
    assert.deepEqual([t.shown, t.title, t.said.length], [false, TITLE, 0], 'after a reload: covered, and the tray is empty');
    const reads = await page.eval(`window.__reads['${RDONE}'] || 0`);
    assert.ok(reads >= 1 && reads <= 2, `the saved record was read ${reads} times in 2.5 s: once is enough, never once a tick`);
    other = await openR({ at: utc('2026-10-25T23:52:30Z'), keepStorage: true, reminders: null, clock: 'fail' });
    await sleep(2500);
    t = await trayState(other);
    assert.deepEqual([t.shown, t.said.length], [false, 0], 'a second tab: covered');
    assert.equal((await saved(page, RDONE))['tequatl-the-sunless'].start, T0);
  } finally { await page.close(); if (other) await other.close(); }
});

/** Two tabs on one clock, both due at the same moment, 9 s from now. Returns what each showed and said. */
async function twoTabs(init) {
  const due = T0 - 10 * MIN, offset = due - 9000 - Date.now();
  const a = await openR({ offset, prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail', init });
  const b = await openR({ offset, keepStorage: true, reminders: null, clock: 'fail', init });
  try {
    assert.ok(Date.now() + offset < due - 1500, 'both tabs were ready before the reminder time');
    await sleep(due - (Date.now() + offset) + 2500);
    const ta = await trayState(a), tb = await trayState(b);
    return { tabs: [ta, tb], locks: [await a.eval('window.__locks || null'), await b.eval('window.__locks || null')], record: await saved(a, RDONE), due };
  } finally { await a.close(); await b.close(); }
}
check('Reminders: two tabs due at the same moment give one notice in all, claimed under the gw2-timer:reminders Web Lock', async () => {
  const r = await twoTabs([LOCK_SPY]);
  assert.equal(r.tabs.reduce((n, t) => n + t.ids.length, 0), 1, 'one notice in all');
  assert.equal(r.tabs.reduce((n, t) => n + t.said.length, 0), 1, 'one announcement in all');
  const w = r.tabs.findIndex((t) => t.ids.length);
  assert.deepEqual([r.tabs[w].title, r.tabs[1 - w].title], [`(1) ${TITLE}`, TITLE]);
  assert.ok(r.locks[w].includes('gw2-timer:reminders'), JSON.stringify(r.locks));
  assert.ok(r.locks.flat().every((n) => n === 'gw2-timer:reminders'), 'no other lock name');
  assert.ok(r.tabs[w].said[0].wall >= r.due, 'not before the reminder time');
  assert.equal(r.record['tequatl-the-sunless'].start, T0);
});
check('Reminders: without Web Locks, two tabs due at the same moment still give one notice (the best-effort claim: write, wait, read back)', async () => {
  const r = await twoTabs([NO_LOCKS]);
  assert.equal(r.tabs.reduce((n, t) => n + t.ids.length, 0), 1, 'one notice in all');
  assert.equal(r.tabs.reduce((n, t) => n + t.said.length, 0), 1, 'one announcement in all');
  const w = r.tabs.findIndex((t) => t.ids.length);
  assert.ok(r.tabs[w].said[0].wall - r.due >= 250, `the winner waited for the read back (${r.tabs[w].said[0].wall - r.due} ms)`);
  assert.equal(r.record['tequatl-the-sunless'].start, T0);
});

check('Reminders: a tab still waiting for its clock check shows a reminder another tab gave as given, and never gives it again', async () => {
  const offset = utc('2026-10-25T23:52:00Z') - Date.now(); // Tequatl is already inside its lead time
  const waiting = await openR({ offset, prefs: { starred: ['tequatl-the-sunless'] }, clock: 'hold' }); // held for 8 s
  let ready = null;
  try {
    await click(waiting, '#reminders-btn'); await settle();
    assert.equal(await text(waiting, '#reminders-list li'), 'Tequatl the Sunless: starts 7:00 PM (00:00 UTC); reminder due now.');
    ready = await openR({ offset, keepStorage: true, reminders: null, clock: 'fail' });
    await ready.waitFor('(window.__said || []).length === 1', 4000);
    // The list is redrawn on the page's next tick after the storage event, so wait for it (a fixed 1.5 s was
    // once too short on a busy Linux machine), but only while the waiting tab is still held.
    await waiting.waitFor("document.querySelector('#reminders-list li').textContent.endsWith('; reminder given.')", 4000).catch(() => {});
    assert.ok(await waiting.eval('performance.now()') < 7500, 'the waiting tab is still held');
    assert.equal(await text(waiting, '#reminders-list li'), 'Tequatl the Sunless: starts 7:00 PM (00:00 UTC); reminder given.', 'it learns of the reminder the other tab gave while still held');
    await waiting.waitFor('performance.now() > 9500', 12000); // past the end of its hold
    const a = await trayState(ready), b = await trayState(waiting);
    assert.deepEqual([a.ids, a.said.length], [['tequatl-the-sunless'], 1], 'the tab with a settled clock gave it');
    assert.deepEqual([b.shown, b.said.length, b.title], [false, 0, TITLE], 'the waiting tab did not');
  } finally { await waiting.close(); if (ready) await ready.close(); }
});

check('Reminders: a claim still in flight is never started again: with a lock that answers after 2.5 s, one lock request, one notice, one announcement', async () => {
  const page = await openR({ at: utc('2026-10-25T23:59:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail', init: [SLOW_LOCK] });
  try {
    await page.waitFor('(window.__said || []).length > 0', 7000);
    await sleep(1500);
    const t = await trayState(page);
    assert.deepEqual([await page.eval('window.__lockCalls'), t.said.length, t.ids], [1, 1, ['tequatl-the-sunless']]);
    assert.equal(t.said[0].text, 'Reminder: Tequatl the Sunless starts at 7:00 PM, in 1 minute.');
    assert.ok(t.said[0].t > 2500, 'it waited for the lock');
  } finally { await page.close(); }
});

check('Reminders: four starred events due on one tick are one batch: one announcement, "(4)" in the title, three notices on a desktop with Show 1 more, and Dismiss all', async () => {
  const page = await openR({ at: T0 - 10 * MIN - 2500, prefs: { starred: FOUR }, clock: 'fail', init: [NOTIFY] });
  try {
    await page.waitFor('(window.__said || []).length > 0', 6000); await sleep(1200);
    let t = await trayState(page);
    assert.deepEqual(t.said.map((s) => s.text), ['Reminders: Admiral Taidha Covington and 3 more starred events start within 10 minutes.']);
    assert.deepEqual([t.title, t.ids, t.more], [`(4) ${TITLE}`, ['admiral-taidha-covington', 'defense-of-amnytas', 'kaineng-blackout'], 'Show 1 more']);
    const room = () => page.eval("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tray-space')) || 0");
    assert.ok(await room() > 100, 'the page keeps room for the tray');
    await click(page, '#reminders-more'); await settle();
    t = await trayState(page);
    assert.deepEqual([t.ids.length, t.more, await page.eval("document.getElementById('reminders-more').getAttribute('aria-expanded')")], [4, 'Show fewer', 'true']);
    await click(page, '#reminders-more'); await settle();
    t = await trayState(page);
    assert.deepEqual([t.ids.length, t.more, await page.eval("document.getElementById('reminders-more').getAttribute('aria-expanded')")], [3, 'Show 1 more', 'false'], 'Show fewer folds it again');
    await click(page, '[data-rm-dismiss="admiral-taidha-covington"]'); await settle();
    t = await trayState(page);
    assert.deepEqual([t.ids, t.more, t.title], [['defense-of-amnytas', 'kaineng-blackout', 'tequatl-the-sunless'], '', `(3) ${TITLE}`], 'three left: all shown, nothing more');
    assert.deepEqual(Object.keys(await saved(page, RDONE)).sort(), [...FOUR].sort(), 'each start recorded');
    await page.eval("document.getElementById('reminders-dismiss-all').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    t = await trayState(page);
    assert.deepEqual([t.shown, t.title, t.said.length, await page.eval('document.activeElement.id')], [false, TITLE, 1, 'coming-title']);
    assert.equal(await room(), 0, 'and gives it back');
    assert.deepEqual(await page.eval('window.__notify'), { made: 0, asked: 0 });
  } finally { await page.close(); }
});

check('Reminders: hidden events are never reminded; unstarring, hiding or turning reminders off takes a notice away silently and undoing it brings it back silently; starring an event inside its lead reminds at once', async () => {
  const page = await openR({ at: utc('2026-10-25T23:52:00.300Z'), prefs: { starred: ['tequatl-the-sunless', 'kaineng-blackout'], hidden: ['kaineng-blackout'] }, clock: 'fail', init: [CLOCK_SPY] });
  const back = async (why) => { const t = await trayState(page); assert.deepEqual([t.ids, t.said.length, t.title], [['tequatl-the-sunless'], 1, `(1) ${TITLE}`], why); };
  const gone = async (why) => { const t = await trayState(page); assert.deepEqual([t.shown, t.title, t.said.length], [false, TITLE, 1], why); };
  try {
    await page.waitFor('(window.__said || []).length > 0', 4000); await sleep(1200);
    await back('the hidden starred event is not reminded');
    assert.deepEqual(Object.keys(await saved(page, RDONE)), ['tequatl-the-sunless'], 'and not claimed');
    const waited = (await trayState(page)).said[0].t - await page.eval('window.__clockFailed');
    assert.ok(waited >= 0 && waited < 250, `given ${Math.round(waited)} ms after the clock check ended, not a tick later`);
    const star = () => click(page, '#next-list .row[data-id="tequatl-the-sunless"] [data-star]');
    await star(); await settle(); await gone('unstarred');
    await star(); await settle(); await back('starred again');
    await click(page, '#next-list .row[data-id="tequatl-the-sunless"] [data-hide]'); await settle(); await gone('hidden');
    await click(page, '#hidden-btn'); await settle();
    await click(page, '#hidden-list [data-unhide="tequatl-the-sunless"]'); await settle();
    await key(page, 'Escape', 'Escape', 27); await settle(); await back('shown again');
    await click(page, '#reminders-btn'); await settle();
    await click(page, '#reminders-on'); await settle();
    await key(page, 'Escape', 'Escape', 27); await settle(); await gone('reminders off');
    assert.equal((await saved(page, RSET)).on, false);
    await click(page, '#reminders-btn'); await settle();
    await click(page, '#reminders-on'); await settle();
    await key(page, 'Escape', 'Escape', 27); await settle(); await back('reminders on again');
    await click(page, '#next-list .row[data-id="defense-of-amnytas"] [data-star]');
    await page.waitFor('window.__said.length === 2', 3000);
    const t = await trayState(page);
    assert.deepEqual([t.said[1].text, t.ids, t.title], ['Reminder: Defense of Amnytas starts at 7:00 PM, in 8 minutes.', ['defense-of-amnytas', 'tequatl-the-sunless'], `(2) ${TITLE}`]);
    assert.equal(await page.eval("document.getElementById('reminders-dismiss-all').getClientRects().length > 0 && document.getElementById('reminders-more').hidden"), true, 'two notices: Dismiss all, and nothing more to show');
    assert.deepEqual((await saved(page, PREFS)).hidden, ['kaineng-blackout'], 'Hidden is the reader\'s, untouched');
  } finally { await page.close(); }
});

check('Reminders: Adjust: a correction (here Reset) updates the notice silently; a move of the lead or more keeps it and reminds again at its own time in the same notice; moved into the past it goes', async () => {
  const id = 'shackles-of-the-ancients', T1 = utc('2026-10-26T01:10:00Z'); // its default start is 01:15 UTC, 8:15 PM in Chicago
  const page = await openR({ at: T1 - 12000, prefs: { starred: [id] }, overrides: { [id]: { offsetMin: 70, setAt: 1 } }, clock: 'fail' });
  const nudge = async (d) => { await click(page, `[data-adj-nudge="${id}:${d}"]`); await settle(); };
  try {
    await page.waitFor('(window.__said || []).length > 0', 4000);
    let t = await trayState(page);
    assert.equal(t.said[0].text, 'Reminder: Shackles of the Ancients (your adjusted time) starts at 8:10 PM, in less than a minute.');
    assert.match(t.texts[0], /^Reminder Shackles of the Ancients \(your adjusted time\) Starts 8:10 PM/i);
    await click(page, `[data-adjust="${id}"]`); await settle();
    await click(page, `[data-adj-reset="${id}"]`); await settle(); // back to 8:15: five minutes later, a correction
    t = await trayState(page);
    assert.deepEqual([t.ids, t.starts, t.said.length], [[id], [T1 + 5 * MIN], 1], 'a correction: the notice moves, nothing is said');
    assert.match(t.texts[0], /^Reminder Shackles of the Ancients \(time unverified\) Starts 8:15 PM/i, 'no longer the reader\'s own time');
    await nudge(5); // 8:20: the lead later than the 8:10 announced, a new occurrence; its reminder time is 8:10
    t = await trayState(page);
    assert.deepEqual([t.ids, t.starts, t.said.length], [[id], [T1 + 10 * MIN], 1], 'rescheduled: the notice stays with the new start');
    assert.match(t.texts[0], /\(your adjusted time\) Starts 8:20 PM/);
    await page.waitFor('window.__said.length === 2', 15000);
    await sleep(300);
    t = await trayState(page);
    assert.ok(t.said[1].wall >= T1, 'reminded again at its own reminder time, not before');
    assert.deepEqual([t.said[1].text, t.ids, t.title], ['Reminder: Shackles of the Ancients (your adjusted time) starts at 8:20 PM, in 10 minutes.', [id], `(1) ${TITLE}`], 'the same notice');
    assert.equal((await saved(page, RDONE))[id].start, T1 + 10 * MIN);
    await nudge(-5); // 8:15: earlier and still ahead
    t = await trayState(page);
    assert.deepEqual([t.ids, t.starts, t.said.length], [[id], [T1 + 5 * MIN], 2], 'moved earlier: the notice follows, nothing is said');
    await nudge(-5); // 8:10, which has passed: the next start is 10:10, a different occurrence
    t = await trayState(page);
    assert.deepEqual([t.shown, t.title, t.said.length], [false, TITLE, 2], 'moved into the past: the notice goes, silently');
    assert.equal((await saved(page, 'gw2-timer:v1:overrides'))[id].offsetMin, 70, 'Adjust holds what the reader set, nothing else');
  } finally { await page.close(); }
});

check('Reminders: a sleep past the start gives nothing; a sleep into the lead time gives one reminder at once with the true countdown; six hours asleep gives one batch for what is due now only', async () => {
  let page = await openR({ at: utc('2026-10-25T23:40:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail' });
  try {
    await sleep(1500);
    await jump(page, 21 * MIN); // 00:01: Tequatl has started
    await sleep(2500);
    const t = await trayState(page);
    assert.deepEqual([t.shown, t.said.length], [false, 0], 'never late');
    assert.equal(await page.eval(`localStorage.getItem('${RDONE}')`), null, 'and nothing claimed');
    assert.ok((await cards(page)).includes('tequatl-the-sunless'), 'it is in Scheduled now');
  } finally { await page.close(); }
  page = await openR({ at: utc('2026-10-25T23:30:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail' });
  try {
    await sleep(1500);
    await jump(page, 27 * MIN); // 23:57:01
    await page.waitFor('(window.__said || []).length > 0', 3000); await sleep(200);
    const t = await trayState(page);
    assert.deepEqual([t.said.length, t.said[0].text], [1, 'Reminder: Tequatl the Sunless starts at 7:00 PM, in 3 minutes.']);
    assert.match(t.texts[0], /· in (2m 5\d|3m 00)s /);
  } finally { await page.close(); }
  page = await openR({ at: utc('2026-10-25T17:30:00Z'), prefs: { starred: [...FOUR, 'claw-of-jormag', 'shadow-behemoth', 'fire-elemental'] }, clock: 'fail' });
  try {
    await sleep(1500);
    await jump(page, 6 * 60 * MIN + 20 * MIN - 1500); // 23:50:00: the starts during the sleep have passed
    await page.waitFor('(window.__said || []).length > 0', 3000); await sleep(1200);
    const t = await trayState(page);
    assert.deepEqual(t.said.map((s) => s.text), ['Reminders: Admiral Taidha Covington and 3 more starred events start within 10 minutes.'], 'one batch');
    assert.deepEqual(Object.keys(await saved(page, RDONE)).sort(), [...FOUR].sort(), 'only what is due now');
  } finally { await page.close(); }
});

check('Reminders: with storage blocked, or failing to save, a reminder still comes once in the tab and never repeats, and the dialog says settings are not being saved', async () => {
  let page = await open({ at: utc('2026-10-25T23:52:00Z'), clock: 'fail', init: [BLOCK_STORAGE, LISTEN] });
  try {
    await click(page, '#next-list .row[data-id="tequatl-the-sunless"] [data-star]'); await settle();
    await click(page, '#reminders-btn'); await settle();
    await click(page, '#reminders-on');
    await page.waitFor('(window.__said || []).length > 0', 3000);
    assert.equal(await page.eval("document.getElementById('reminders-unsaved').hidden"), false);
    assert.equal(await text(page, '#reminders-unsaved'), 'Your browser is not saving settings, so reminders last until you close this tab.');
    await key(page, 'Escape', 'Escape', 27); await sleep(2500);
    const t = await trayState(page);
    assert.deepEqual([t.said.length, t.ids], [1, ['tequatl-the-sunless']], 'storage blocked: given once, not repeated');
    assert.deepEqual(unexpected(page, ALLOW), []);
  } finally { await page.close(); }
  page = await openR({ at: utc('2026-10-25T23:52:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail', init: [FAIL_WRITES] });
  try {
    await page.waitFor('(window.__said || []).length > 0', 3000); await sleep(2500);
    const t = await trayState(page);
    assert.deepEqual([t.said.length, t.ids], [1, ['tequatl-the-sunless']], 'writes failing: given once, not repeated');
    assert.equal(await page.eval(`localStorage.getItem('${RDONE}')`), null);
    await click(page, '#reminders-btn'); await settle();
    assert.equal(await page.eval("document.getElementById('reminders-unsaved').hidden"), false);
    assert.deepEqual(unexpected(page, ALLOW), []);
  } finally { await page.close(); }
  page = await openR({ at: utc('2026-10-25T23:52:00Z'), reminders: null, clock: 'fail', init: [FAIL_WRITES] });
  try {
    await click(page, '#reminders-btn'); await settle();
    assert.equal(await page.eval("document.getElementById('reminders-unsaved').hidden"), true, 'nothing to say before a setting is changed');
    await click(page, '#reminders-on'); await settle();
    assert.deepEqual(await page.eval("[document.getElementById('reminders-unsaved').hidden, document.getElementById('reminders-btn').textContent]"), [false, 'Reminders: 10 min'], 'the setting works in this tab, and the dialog says it is not saved');
  } finally { await page.close(); }
});

check('Reminders: damaged saved reminder data is ignored: junk settings mean off, junk records are dropped, and what is saved afterwards is clean', async () => {
  let page = await openR({ at: utc('2026-10-25T23:52:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, reminders: { on: 'yes', lead: 7, notify: 1 }, clock: 'fail' });
  try {
    await sleep(2000);
    assert.deepEqual([(await trayState(page)).shown, await text(page, '#reminders-btn')], [false, 'Reminders: off']);
  } finally { await page.close(); }
  // A start two days ahead would silence Tequatl for two days; with an unknown id, __proto__ and text for a number.
  const junk = `{"tequatl-the-sunless":{"start":${T0 + 2 * DAY},"at":1,"by":"x"},"no-such-event":{"start":${T0},"at":1},"__proto__":{"start":${T0},"at":1},"kaineng-blackout":{"start":"soon","at":1}}`;
  page = await openR({ at: utc('2026-10-25T23:52:00Z'), prefs: { starred: ['tequatl-the-sunless', 'kaineng-blackout'] }, records: junk, clock: 'fail' });
  try {
    await page.waitFor('(window.__said || []).length > 0', 4000); await sleep(800);
    assert.deepEqual((await trayState(page)).ids, ['kaineng-blackout', 'tequatl-the-sunless']);
    assert.deepEqual((await trayState(page)).said.map((x) => x.text), ['Reminders: Kaineng Blackout and 1 more starred event start within 10 minutes.']);
    const rec = await saved(page, RDONE);
    assert.deepEqual(Object.keys(rec).sort(), ['kaineng-blackout', 'tequatl-the-sunless']);
    assert.ok(Object.values(rec).every((r) => r.start === T0 && Number.isFinite(r.at) && typeof r.by === 'string' && Object.keys(r).length === 3), JSON.stringify(rec));
    assert.deepEqual(unexpected(page, ALLOW), []);
  } finally { await page.close(); }
});

check('Reminders: the tray and dialog at 320, 360, 390, 768 and 1440 px in both themes: inside the window, no sideways scroll, one notice on phones and three wider, 36 px controls on phones, contrast of 4.5:1, and the page scrolls clear of the tray', async () => {
  for (const theme of ['dark', 'light']) {
    for (const [width, height, mobile] of [[320, 568, true], [360, 740, true], [390, 844, true], [768, 1024, false], [1440, 900, false]]) {
      const page = await openR({ at: T0 - 10 * MIN - 1500, width, height, mobile, prefs: { starred: FOUR, theme }, clock: 'fail' });
      const at = `${width} ${theme}`;
      try {
        await page.waitFor("!document.getElementById('reminders-tray').hidden", 5000); await settle();
        const box = () => page.eval("(() => { const t = document.getElementById('reminders-tray').getBoundingClientRect(); return { left: t.left, right: t.right, top: t.top, bottom: t.bottom, height: t.height, page: document.documentElement.scrollWidth, innerH: innerHeight }; })()");
        let r = await box();
        assert.ok(r.left >= 0 && r.right <= width && r.bottom <= r.innerH && r.page <= width, `${at}: ${JSON.stringify(r)}`);
        const t = await trayState(page);
        assert.deepEqual([t.ids.length, t.more], width <= 640 ? [1, '+3 more'] : [3, 'Show 1 more'], at);
        if (width <= 640) assert.ok(r.height <= 170, `${at}: the tray takes ${r.height} px of ${height}`);
        // A name on two lines (a long name, or a wide font: Verdana here, DejaVu Sans on Ubuntu) still fits 170 px at 320.
        if (width === 320) {
          const two = await page.eval(`(() => { const n = document.querySelector('.rm-notice .rm-name'); n.style.fontFamily = 'Verdana, "DejaVu Sans"';
            const out = { lines: n.querySelector('.event-link').getClientRects().length, height: document.getElementById('reminders-tray').getBoundingClientRect().height }; n.style.fontFamily = ''; return out; })()`);
          assert.ok(two.lines === 2 && two.height <= 170, `${at}: with the name on two lines: ${JSON.stringify(two)}`);
        }
        // Where "+3 more" and Dismiss all sit, whatever the fonts. On a phone: inside the notice, on its row of
        // buttons when all four fit there, else on a line of their own below them, never past its edge.
        // Wider: under the list, as in v0.2.1's layout of the tray. (Pixel limits fail on Ubuntu's fonts in CI.)
        const g = await page.eval(`(() => { const foot = document.getElementById('reminders-foot'), li = document.querySelector('.rm-notice'), row = li.querySelector('.rm-actions');
          const b = (el) => el.getBoundingClientRect(), copy = b(row.querySelector('[data-copy]')), dis = b(row.querySelector('[data-rm-dismiss]')), f = b(foot), n = b(li);
          return { inNotice: li.contains(foot), underList: foot.parentElement.id === 'reminders-tray', need: copy.width + dis.width + f.width + 2 * (parseFloat(getComputedStyle(row).columnGap) || 0),
            room: b(row).width, sameRow: f.top < copy.bottom && f.bottom > copy.top, below: f.top >= copy.bottom, inside: f.left >= n.left && f.right <= n.right && f.bottom <= n.bottom,
            extra: b(document.getElementById('reminders-tray')).height - n.height, label: document.getElementById('reminders-more').getAttribute('aria-label') }; })()`);
        if (width <= 640) {
          assert.ok(g.inNotice && g.inside && g.extra <= 13, `${at}: inside the notice, nothing under it: ${JSON.stringify(g)}`);
          assert.equal(g.label, '+3 more reminders', at);
          if (Math.abs(g.need - g.room) >= 1) assert.ok(g.need < g.room ? g.sameRow : g.below, `${at}: ${JSON.stringify(g)}`);
          // With Windows' fonts, where the layout was measured: one row from 360 px (a 105 px tray), two lines at 320.
          if (process.platform === 'win32') assert.equal(g.sameRow, width >= 360, `${at} on Windows: ${JSON.stringify(g)}`);
        } else assert.ok(g.underList && !g.inNotice && g.label === null, `${at}: ${JSON.stringify(g)}`);
        if (mobile) assert.deepEqual(await page.eval("[...document.querySelectorAll('#reminders-tray button, #reminders-tray a')].filter((b) => b.getClientRects().length && b.getBoundingClientRect().height < 36).map((b) => b.textContent)"), [], at);
        assert.deepEqual(await lowContrast(page, '#reminders-tray *'), [], at);
        // The page can be scrolled clear of the tray: at the bottom, the footer ends above it.
        await page.eval('scrollTo(0, document.documentElement.scrollHeight)'); await settle();
        assert.equal(await page.eval("document.querySelector('.site-footer').getBoundingClientRect().bottom <= document.getElementById('reminders-tray').getBoundingClientRect().top + 0.5"), true, `${at}: footer clear of the tray`);
        // All four shown: still inside the window (it scrolls inside itself when it must).
        await click(page, '#reminders-more'); await settle();
        r = await box();
        assert.ok(r.top >= 0 && r.bottom <= r.innerH && r.page <= width, `${at} expanded: ${JSON.stringify(r)}`);
        // The dialog: inside the window, no sideways scroll, readable, and its options big enough to tap.
        await click(page, '#reminders-btn'); await settle();
        const d = await page.eval("(() => { const d = document.getElementById('reminders-dialog'), b = d.getBoundingClientRect(); return { left: b.left, right: b.right, inner: d.scrollWidth <= d.clientWidth, options: [...d.querySelectorAll('.rm-option')].map((o) => o.getBoundingClientRect().height) }; })()");
        assert.ok(d.left >= 0 && d.right <= width && d.inner, `${at} dialog: ${JSON.stringify(d)}`);
        if (mobile) assert.ok(d.options.every((x) => x >= 36), `${at}: ${d.options}`);
        assert.deepEqual(await lowContrast(page, '#reminders-dialog *'), [], `${at} dialog`);
        assert.ok((await sideways(page, width))[0] <= width, `${at}: no sideways scroll`);
        if (SHOTS) await page.screenshot(join(SHOTS, `reminders-${width}-${theme}.png`));
      } finally { await page.close(); }
    }
  }
});

check('Reminders: keyboard and screen readers: the tray is a named region and not live; Dismiss moves focus to the next notice, the last one to Coming up; the dialog works from the keyboard', async () => {
  const page = await openR({ at: T0 - 10 * MIN - 1500, prefs: { starred: ['tequatl-the-sunless', 'kaineng-blackout'] }, reminders: { on: true, lead: 10, notify: false }, clock: 'fail' });
  try {
    await page.waitFor("!document.getElementById('reminders-tray').hidden", 5000); await settle();
    assert.equal(await page.eval("document.querySelectorAll('#reminders-tray[aria-live], #reminders-tray [aria-live], #reminders-tray [role=\"status\"], #reminders-tray [role=\"alert\"]').length"), 0, 'the tray is not a live region');
    assert.deepEqual(await page.eval("[document.getElementById('reminders-announce').getAttribute('role'), getComputedStyle(document.getElementById('reminders-announce')).position]"), ['status', 'absolute'], 'announcements in a polite, visually hidden status');
    await page.send('Accessibility.enable');
    const { nodes } = await page.send('Accessibility.getFullAXTree', {});
    assert.ok(nodes.some((n) => !n.ignored && n.role && n.role.value === 'region' && n.name && n.name.value === 'Reminders'), 'a region named Reminders');
    assert.equal(await page.eval("document.querySelector('#reminders-tray a.event-link').getAttribute('aria-haspopup')"), 'dialog', 'the name opens its details');
    await page.eval("document.querySelector('[data-rm-dismiss=\"kaineng-blackout\"]').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.equal(await page.eval("document.activeElement.getAttribute('aria-label')"), 'Dismiss the reminder for Tequatl the Sunless', 'focus moves to the next notice');
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.equal(await page.eval('document.activeElement.id'), 'coming-title', 'the last one: focus to Coming up');
    // The dialog from the keyboard: Space turns reminders off, an arrow key picks 15 minutes, Escape returns.
    await page.eval("document.getElementById('reminders-btn').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.equal(await page.eval("document.getElementById('reminders-dialog').open"), true);
    await page.eval("document.getElementById('reminders-on').focus()");
    await key(page, ' ', 'Space', 32); await settle();
    assert.equal((await saved(page, RSET)).on, false);
    await key(page, 'Tab', 'Tab', 9);
    assert.equal(await page.eval("document.activeElement.name + ':' + document.activeElement.value"), 'reminders-lead:10', 'Tab reaches the chosen lead');
    await key(page, 'ArrowRight', 'ArrowRight', 39); await settle();
    assert.deepEqual(await saved(page, RSET), { on: false, lead: 15, notify: false });
    await key(page, 'Escape', 'Escape', 27); await settle();
    assert.deepEqual(await page.eval("[document.activeElement.id, document.getElementById('reminders-btn').textContent]"), ['reminders-btn', 'Reminders: off']);
    const ax = (await page.send('Accessibility.getFullAXTree', {})).nodes;
    assert.ok(ax.some((n) => n.role && n.role.value === 'button' && n.name && n.name.value === 'Reminders: off'), 'the button says the state');
  } finally { await page.close(); }
});

check('Reminders: on a phone no control is hidden behind the tray when it takes focus, and a reminder never takes focus itself', async () => {
  const page = await openR({ at: T0 - 10 * MIN - 1500, width: 390, height: 844, mobile: true, prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail' });
  try {
    await page.waitFor("!document.getElementById('reminders-tray').hidden", 5000); await settle();
    assert.equal(await page.eval("document.getElementById('reminders-tray').contains(document.activeElement)"), false, 'a reminder does not take focus');
    assert.deepEqual([(await trayState(page)).more, await page.eval("document.getElementById('reminders-foot').hidden")], ['', true], 'one notice: nothing more to show');
    await click(page, '#filters-toggle'); await settle();
    await page.eval("document.activeElement.blur(); scrollTo(0, 0)");
    const hidden = [];
    for (let i = 0; i < 140; i++) {
      await key(page, 'Tab', 'Tab', 9);
      const r = await page.eval(`(() => { const a = document.activeElement, t = document.getElementById('reminders-tray'); if (!a || a === document.body) return null;
        if (t.contains(a)) return 'tray'; const b = a.getBoundingClientRect(), tr = t.getBoundingClientRect();
        return b.bottom > tr.top + 1 && b.top < tr.bottom ? (a.getAttribute('aria-label') || a.textContent || a.id).slice(0, 40) + ' ' + Math.round(b.bottom) + ' > ' + Math.round(tr.top) : null; })()`);
      if (r && r !== 'tray') hidden.push(r);
    }
    assert.deepEqual(hidden, [], 'focused controls behind the tray');
  } finally { await page.close(); }
});

check('Reminders: the room kept past the edge of the scroll padding, before the tray, is at least the tallest name link or button of one line in the lists less a line of the root font, so one Firefox leaves in place (it scrolls a control that takes focus only when less than a line shows) is still clear of the tray, on phones and a desktop', async () => {
  for (const [width, height, mobile] of [[390, 844, true], [320, 568, true], [1440, 900, false]]) {
    const page = await openR({ at: T0 - 10 * MIN - 1500, width, height, mobile, prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail' });
    try {
      await page.waitFor("!document.getElementById('reminders-tray').hidden", 5000); await settle();
      const r = await page.eval(`(() => { const tr = document.getElementById('reminders-tray').getBoundingClientRect();
        const edge = innerHeight - parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom);
        const probe = document.createElement('span'); probe.textContent = 'Hg'; probe.style.font = getComputedStyle(document.documentElement).font; document.body.append(probe);
        const line = probe.getBoundingClientRect().height; probe.remove();
        const lines = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return new Set([...rg.getClientRects()].map((x) => Math.round(x.bottom))).size; };
        const els = [...document.querySelectorAll('#now-list a.event-link, #next-list a.event-link, #now-list button, #next-list button')].filter((el) => el.getClientRects().length === 1 && lines(el) <= 1);
        const top = els.reduce((m, el) => (el.getBoundingClientRect().height > m.getBoundingClientRect().height ? el : m), els[0]);
        return { room: Math.round((tr.top - edge) * 10) / 10, line: Math.round(line * 10) / 10, tall: Math.round(top.getBoundingClientRect().height * 10) / 10, n: els.length,
          what: (top.getAttribute('aria-label') || top.textContent).trim().slice(0, 50) + ' (' + top.tagName.toLowerCase() + '.' + top.className + ', ' + Math.round(top.getBoundingClientRect().width) + ' px wide)' }; })()`);
      assert.ok(r.n > 10 && r.room >= r.tall - r.line, `${width}: the room past the edge (${r.room} px) against the tallest of ${r.n} one-line name links and buttons (${r.tall} px: ${r.what}) less a line (${r.line} px)`);
    } finally { await page.close(); }
  }
});

check('Reminders: a control that takes focus partly behind the tray is scrolled clear of it by the page, as Firefox leaves one where it is while a line of it shows (here, focus without the browser\'s own scroll): the stars in the list and a summary that wraps on a phone; one already clear, or in a dialog, moves nothing', async () => {
  const page = await openR({ at: T0 - 10 * MIN - 1500, width: 320, height: 568, mobile: true, prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail' });
  try {
    await page.waitFor("!document.getElementById('reminders-tray').hidden", 5000); await settle();
    // Each placed with its top 12 px above the tray, so most of it is behind, then focused.
    const r = await page.eval(`(() => { const t = document.getElementById('reminders-tray'), out = [];
      const els = [...[...document.querySelectorAll('#next-list .row [data-star]')].slice(2, 5), ...document.querySelectorAll('summary')];
      for (const el of els) {
        document.activeElement.blur();
        scrollBy(0, el.getBoundingClientRect().top - (t.getBoundingClientRect().top - 12));
        const before = el.getBoundingClientRect().bottom - t.getBoundingClientRect().top;
        el.focus({ preventScroll: true });
        out.push([Math.round(el.getBoundingClientRect().height), Math.round(before), Math.round(t.getBoundingClientRect().top - el.getBoundingClientRect().bottom)]); }
      return out; })()`);
    assert.ok(r.length >= 5 && r.some(([h]) => h > 60) && r.every(([, before, after]) => before > 0 && after >= 8), `[height, behind the tray by, then clear of it by] px: ${JSON.stringify(r)}`);
    const still = await page.eval(`(() => { document.activeElement.blur(); scrollTo(0, 0); document.getElementById('filters-toggle').focus({ preventScroll: true }); return scrollY; })()`);
    assert.equal(still, 0, 'a control already clear of the tray: the page did not move');
    // The dialog moved down so its switch is level with the tray, as one in a dialog could be on a short window.
    const inDialog = await page.eval(`(() => { document.activeElement.blur(); const d = document.getElementById('reminders-dialog'), t = document.getElementById('reminders-tray').getBoundingClientRect();
      d.showModal(); d.style.margin = Math.round(t.top - 60) + 'px auto 0'; const c = d.querySelector('#reminders-on'), cb = c.getBoundingClientRect(), y = scrollY;
      c.focus({ preventScroll: true }); const out = [cb.bottom > t.top && cb.top < t.bottom, scrollY !== y]; d.close(); d.style.margin = ''; return out; })()`);
    assert.deepEqual(inDialog, [true, false], 'a control in a dialog, level with the tray: the page did not move');
  } finally { await page.close(); }
});

check('Reminders: on a phone "+3 more" and Dismiss all end the first notice\'s row of buttons: named for what they do, in reading order, focus kept when the tray is redrawn or the window widens; wider, they go back under the list', async () => {
  const page = await openR({ at: T0 - 10 * MIN - 1500, width: 390, height: 844, mobile: true, prefs: { starred: FOUR }, clock: 'fail' });
  const order = () => page.eval("[...document.querySelectorAll('#reminders-tray a, #reminders-tray button')].filter((b) => b.getClientRects().length).map((b) => b.getAttribute('aria-label') || b.textContent)");
  const where = () => page.eval("(() => { const p = document.getElementById('reminders-foot').parentElement, n = p.closest('.rm-notice'); return n ? 'notice ' + n.dataset.id : p.id; })()");
  const focused = () => page.eval("document.activeElement.id || document.activeElement.getAttribute('aria-label') || document.activeElement.textContent");
  const state = async () => { const t = await trayState(page); return [t.ids.length, t.more, await where(), await focused()]; };
  const more = (attr) => page.eval(`document.getElementById('reminders-more').getAttribute('${attr}')`);
  try {
    await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.waitFor("!document.getElementById('reminders-tray').hidden", 5000); await settle();
    assert.equal(await page.eval("getComputedStyle(document.querySelector('.rm-notice')).animationName"), 'none', 'reduced motion: no fade');
    assert.deepEqual(await order(), ['Admiral Taidha Covington', 'Copy waypoint for Admiral Taidha Covington: [&BKgBAAA=]', 'Dismiss the reminder for Admiral Taidha Covington', '+3 more reminders', 'Dismiss all'], 'reading and Tab order');
    await page.send('Accessibility.enable');
    const ax = (await page.send('Accessibility.getFullAXTree', {})).nodes.find((n) => !n.ignored && n.role && n.role.value === 'button' && n.name && n.name.value === '+3 more reminders');
    assert.ok(ax && ax.properties.some((p) => p.name === 'expanded' && p.value.value === false), 'a button named "+3 more reminders", collapsed');
    // From the keyboard: the tray is redrawn around the button, which keeps focus.
    await page.eval("document.getElementById('reminders-more').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.deepEqual([...await state(), await more('aria-expanded'), await more('aria-label')], [4, 'Show fewer', 'notice admiral-taidha-covington', 'reminders-more', 'true', null], 'all four; "Show fewer" is named by its text');
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.deepEqual(await state(), [1, '+3 more', 'notice admiral-taidha-covington', 'reminders-more'], 'folded again');
    // The window widens past 640 px with focus on the button: it goes back under the list and keeps focus; and back.
    await page.viewport(1024, 844, false); await settle();
    assert.deepEqual([...await state(), await more('aria-label')], [3, 'Show 1 more', 'reminders-tray', 'reminders-more', null], 'wider: three notices, the buttons under the list');
    await page.viewport(390, 844, true); await settle();
    assert.deepEqual(await state(), [1, '+3 more', 'notice admiral-taidha-covington', 'reminders-more'], 'a phone again');
    // Dismiss: focus to the next notice's Dismiss; the tray's buttons move to that notice's row.
    await page.eval("document.querySelector('[data-rm-dismiss=\"admiral-taidha-covington\"]').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.deepEqual(await state(), [1, '+2 more', 'notice defense-of-amnytas', 'Dismiss the reminder for Defense of Amnytas']);
    await key(page, 'Enter', 'Enter', 13); await settle();
    assert.deepEqual([...await state(), await more('aria-label')], [1, '+1 more', 'notice kaineng-blackout', 'Dismiss the reminder for Kaineng Blackout', '+1 more reminder'], 'two left: still on the row');
    await page.eval("document.getElementById('reminders-dismiss-all').focus()");
    await key(page, 'Enter', 'Enter', 13); await settle();
    const t = await trayState(page);
    assert.deepEqual([t.shown, t.title, await where(), await focused()], [false, TITLE, 'reminders-tray', 'coming-title'], 'Dismiss all: the tray goes, focus to Coming up');
    assert.deepEqual(unexpected(page, ALLOW), []);
  } finally { await page.close(); }
});

check('Reminders: a new notice fades in, but not with reduced motion', async () => {
  for (const [reduce, want] of [[false, 'rm-in'], [true, 'none']]) {
    const page = await openR({ at: utc('2026-10-25T23:52:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail' });
    try {
      if (reduce) await page.emulateMedia([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.waitFor("!document.getElementById('reminders-tray').hidden", 4000);
      assert.equal(await page.eval("getComputedStyle(document.querySelector('.rm-notice')).animationName"), want, `reduced motion ${reduce}`);
    } finally { await page.close(); }
  }
});

check('Reminders: the dialog lists the starred events soonest reminder first, with the state of each; a notice and its announcement say when a time is unverified', async () => {
  const page = await openR({ at: utc('2026-10-26T01:51:00Z'), prefs: { starred: ['tequatl-the-sunless', 'depths-of-cruelty', 'claw-of-jormag'], hidden: ['claw-of-jormag'] }, clock: 'fail' });
  try {
    await page.waitFor('(window.__said || []).length > 0', 4000); await settle();
    const t = await trayState(page);
    assert.equal(t.said[0].text, 'Reminder: Depths of Cruelty (time unverified) starts at 9:00 PM, in 9 minutes.');
    assert.match(t.texts[0], /^Reminder Depths of Cruelty \(time unverified\) Starts 9:00 PM \(02:00 UTC\) · in 8m 5\ds/i);
    await click(page, '#reminders-btn'); await settle();
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#reminders-list li')].map((li) => li.textContent)"), [
      'Depths of Cruelty (time unverified): starts 9:00 PM (02:00 UTC); reminder given.',
      'Claw of Jormag: starts 9:30 PM (02:30 UTC); hidden, so no reminder.',
      'Tequatl the Sunless: starts 10:00 PM (03:00 UTC); reminder at 9:50 PM.']);
    await click(page, '#reminders-dialog [data-close]'); await settle();
    await click(page, '#utc-btn'); await settle(); // UTC off: the tray follows
    assert.match((await trayState(page)).texts[0], /Starts 9:00 PM · in 8m/);
  } finally { await page.close(); }
  // The list is rebuilt when a time in it passes: at 7:00 PM Tequatl's next start becomes 10:00 PM.
  const passing = await openR({ at: T0 - 6000, prefs: { starred: ['tequatl-the-sunless'] }, reminders: null, clock: 'fail' });
  try {
    await click(passing, '#reminders-btn'); await settle();
    assert.equal(await text(passing, '#reminders-list li'), 'Tequatl the Sunless: starts 7:00 PM (00:00 UTC); no reminder while reminders are off.');
    await passing.eval("window.__li = document.querySelector('#reminders-list li')");
    await sleep(1500);
    assert.equal(await passing.eval("window.__li === document.querySelector('#reminders-list li')"), true, 'not rebuilt every second');
    await passing.waitFor("document.querySelector('#reminders-list li').textContent === 'Tequatl the Sunless: starts 10:00 PM (03:00 UTC); no reminder while reminders are off.'", 9000);
  } finally { await passing.close(); }
  // In London 00:00 UTC is the next local day: the notice and the list say tomorrow.
  const london = await openR({ at: utc('2026-10-25T23:52:00Z'), tz: 'Europe/London', prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail' });
  try {
    await london.waitFor('(window.__said || []).length > 0', 4000); await settle();
    const t = await trayState(london);
    assert.equal(t.said[0].text, 'Reminder: Tequatl the Sunless starts at 12:00 AM, in 8 minutes.');
    assert.match(t.texts[0], /^Reminder Tequatl the Sunless Starts tomorrow 12:00 AM \(00:00 UTC\) · in 7m 5\ds/i);
    await click(london, '#reminders-btn'); await settle();
    assert.equal(await text(london, '#reminders-list li'), 'Tequatl the Sunless: starts tomorrow 12:00 AM (00:00 UTC); reminder given.');
  } finally { await london.close(); }
  const none = await openR({ at: utc('2026-10-26T01:51:00Z'), clock: 'fail' });
  try {
    await click(none, '#reminders-btn'); await settle();
    assert.deepEqual(await none.eval("[...document.querySelectorAll('#reminders-list li')].map((li) => li.textContent)"), ["No starred events yet. Use the star (☆) by an event's name."]);
  } finally { await none.close(); }
});

check('Reminders: a longer lead that reaches an event reminds it once, at once; a shorter one repeats nothing; another open tab follows the change', async () => {
  const page = await openR({ at: utc('2026-10-25T23:48:00Z'), prefs: { starred: ['tequatl-the-sunless'] }, clock: 'fail' });
  const other = await openR({ at: utc('2026-10-25T23:48:01Z'), keepStorage: true, reminders: null, clock: 'fail' });
  try {
    await sleep(1500);
    assert.deepEqual([(await trayState(page)).shown, (await trayState(other)).shown], [false, false], '12 minutes away with a 10 minute lead');
    await click(page, '#reminders-btn'); await settle();
    await click(page, '[name="reminders-lead"][value="15"]');
    await other.waitFor("document.getElementById('reminders-btn').textContent === 'Reminders: 15 min'", 3000);
    await sleep(1500);
    // Either tab may give it (the other one followed the setting at once): one notice and one announcement in all.
    let a = await trayState(page), b = await trayState(other);
    assert.deepEqual(a.said.concat(b.said).map((x) => x.text), ['Reminder: Tequatl the Sunless starts at 7:00 PM, in 12 minutes.']);
    assert.equal(a.ids.length + b.ids.length, 1, 'one notice in all');
    await click(page, '[name="reminders-lead"][value="5"]'); await sleep(1500);
    await key(page, 'Escape', 'Escape', 27); await settle();
    a = await trayState(page); b = await trayState(other);
    assert.deepEqual([a.said.length + b.said.length, a.ids.concat(b.ids)], [1, ['tequatl-the-sunless']], 'a shorter lead repeats nothing, and the notice stays');
    assert.deepEqual(await saved(page, RSET), { on: true, lead: 5, notify: false });
    assert.equal(await text(other, '#reminders-btn'), 'Reminders: 5 min');
  } finally { await page.close(); await other.close(); }
});

// ---- v0.4.0 Phase B: Add to calendar ----

const CAL = 'Calendar: ';
// Files go to a folder of their own per check; Chrome writes "<name>.crdownload" first, then renames it.
const DL_ROOT = mkdtempSync(join(tmpdir(), 'gw2-timer-downloads-'));
async function downloadsTo(page) {
  const dir = mkdtempSync(join(DL_ROOT, 'p-'));
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true });
  return dir;
}
async function downloaded(dir, timeout = 6000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const done = readdirSync(dir).filter((f) => !f.endsWith('.crdownload'));
    if (done.length && !readdirSync(dir).some((f) => f.endsWith('.crdownload'))) return done.map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));
    await sleep(100);
  }
  return [];
}
// Every Blob the page turns into a URL, with its type and text: what was handed to the download.
const BLOBS = `(() => { window.__blobs = []; const make = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (b) => { const rec = { type: b.type, size: b.size, text: null }; window.__blobs.push(rec); b.text().then((t) => { rec.text = t; }); return make(b); }; })();`;
/** The entries of a calendar file: start, end, title, id and alarm triggers (a reader of its own, as in tests/ics.mjs). */
function entries(text) {
  assert.ok(text.endsWith('\r\n') && !/\r(?!\n)|(?<!\r)\n/.test(text), 'CRLF lines');
  assert.ok(text.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'folded at 75 octets');
  const lines = text.replace(/\r\n[ \t]/g, '').split('\r\n'), out = [];
  const t = (v) => Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15));
  let cur = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') cur = { alarms: [] };
    else if (l === 'END:VEVENT') { out.push(cur); cur = null; }
    else if (cur) {
      const [k, ...v] = l.split(':'), val = v.join(':');
      if (k === 'DTSTART') { assert.match(val, /^\d{8}T\d{6}Z$/); cur.start = t(val); }
      else if (k === 'DTEND') cur.end = t(val);
      else if (k === 'SUMMARY') cur.title = val.replace(/\\([\\;,])/g, '$1');
      else if (k === 'UID') cur.uid = val;
      else if (k === 'TRIGGER') cur.alarms.push(val);
      else if (k === 'RRULE' || k === 'TZID') throw new Error(`${k} in the file`);
    }
  }
  return out;
}
/** What the engine itself gives for the same choice: the starts the file must hold. */
function engineStarts(events, now, span) {
  if (span === 'next') return events.map((e) => S.nextStart(e.schedule, now)).sort((a, b) => a - b);
  return S.upcoming(events, now, ICS.SPANS[span]).map((i) => i.start).sort((a, b) => a - b);
}
const ICS = createRequire(import.meta.url)(join(DIR, 'js', 'ics.js'));
const calState = (page) => page.eval(`(() => { const d = document.getElementById('calendar-dialog'), q = (s) => d.querySelector(s);
  return { open: d.open, scope: (q('[name="calendar-scope"]:checked') || {}).value || '', one: !q('#calendar-one-option').hidden ? q('#calendar-one-name').textContent : '',
    starred: q('#calendar-starred-label').textContent, pick: !q('#calendar-pick').hidden, span: q('#calendar-span').value, alarm: q('#calendar-alarm').value,
    summary: q('#calendar-summary').textContent, marked: q('#calendar-uncertain').hidden ? '' : q('#calendar-uncertain').textContent,
    disabled: q('#calendar-download').disabled, done: q('#calendar-done').textContent }; })()`);
const choose = (page, sel, value) => page.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return el.value; })()`);
const storageNow = (page) => page.eval('JSON.stringify(Object.keys(localStorage).sort().map((k) => [k, localStorage.getItem(k)]))');
// Opens with the keyboard (focus, then Enter), as a person does. A click from a script gives the page no user
// activation, and Chrome then groups a dialog opened by it with the one below it, so one Escape closes both.
const activate = async (page, sel) => { await page.eval(`document.querySelector(${JSON.stringify(sel)}).focus()`); await key(page, 'Enter', 'Enter', 13); };
const offSite = (page) => page.requests.filter((u) => !/^(http:\/\/127\.0\.0\.1:\d+\/|blob:http:\/\/127\.0\.0\.1:\d+\/|data:)/.test(u) && u !== FEED_URL);

check(`${CAL}Add to calendar in an event's details downloads its next start: the start the details show, in UTC, with its window, as a text/calendar file; Escape goes back to the details`, async () => {
  const at = utc('2026-10-25T23:50:00Z');
  const page = await openLink('#event/tequatl-the-sunless', { at, beforeLoad: BLOBS });
  try {
    const dir = await downloadsTo(page), before = await storageNow(page), url = await page.eval('location.href');
    assert.match(await text(page, '#event-dialog-when'), /^Next scheduled start: 7:00 PM \(00:00 UTC\)/);
    await activate(page, '#event-dialog [data-calendar]');
    await page.waitFor("document.getElementById('calendar-dialog').open");
    const s = await calState(page);
    assert.deepEqual([s.scope, s.one, s.span, s.alarm, s.pick, s.disabled], ['one', 'This event: Tequatl the Sunless', 'next', '0', false, false]);
    assert.equal(s.summary, '1 entry: Tequatl the Sunless, today at 7:00 PM (00:00 UTC).');
    assert.equal(s.marked, '');
    await click(page, '#calendar-download');
    const files = await downloaded(dir);
    assert.deepEqual(files.map((f) => f.name), ['gw2-timer-tequatl-the-sunless.ics']);
    const es = entries(files[0].text), now = await pageNow(page);
    assert.deepEqual(es.map((x) => x.start), engineStarts([EV.get('tequatl-the-sunless')], now, 'next'));
    assert.deepEqual([es[0].start, es[0].end - es[0].start, es[0].title, es[0].alarms], [utc('2026-10-26T00:00:00Z'), 30 * MIN, 'GW2: Tequatl the Sunless', []]);
    assert.equal(es[0].uid, 'tequatl-the-sunless-20261026T000000Z@gw2-timer.radmagelabs.com');
    const blobs = await page.eval('window.__blobs');
    assert.deepEqual(blobs.map((b) => [b.type, b.text]), [['text/calendar;charset=utf-8', files[0].text]], 'the file is the Blob the page made');
    assert.match((await calState(page)).done, /^Downloading gw2-timer-tequatl-the-sunless\.ics \(1 entry\)\. /);
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('calendar-dialog').open");
    assert.equal(await page.eval("document.getElementById('event-dialog').open"), true, 'the details stay open');
    assert.equal(await page.eval("document.activeElement.getAttribute('data-fkey')"), 'dlg:calendar', 'focus is back on Add to calendar');
    assert.deepEqual([await storageNow(page), await page.eval('location.href')], [before, url], 'nothing saved, the address unchanged');
    assert.deepEqual(offSite(page), [], 'no request left the site');
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

check(`${CAL}the Calendar button exports the starred events for a chosen span with an alarm: every start the engine gives, an adjusted one at the reader's time and marked`, async () => {
  const at = utc('2026-10-25T23:50:00Z');
  const prefs = { ...SAVED, filter: 'all', regions: DATA.regions.map((r) => r.id), hidden: [], starred: ['tequatl-the-sunless', 'claw-of-jormag', 'secrets-of-the-weald'] };
  const page = await open({ at, seed: { [PREFS]: prefs, 'gw2-timer:v1:overrides': { 'secrets-of-the-weald': { offsetMin: 105, setAt: 0 } } }, init: [BLOBS] });
  try {
    const dir = await downloadsTo(page);
    await click(page, '#calendar-btn');
    await page.waitFor("document.getElementById('calendar-dialog').open");
    let s = await calState(page);
    assert.deepEqual([s.scope, s.one, s.starred, s.span, s.pick], ['starred', '', 'Starred events (3)', 'next', false]);
    await choose(page, '#calendar-span', '24h'); await choose(page, '#calendar-alarm', '10');
    s = await calState(page);
    const now = await pageNow(page);
    const evs = ['tequatl-the-sunless', 'claw-of-jormag', 'secrets-of-the-weald'].map((id) => (id === 'secrets-of-the-weald' ? S.applyOverride(EV.get(id), 105) : EV.get(id)));
    const want = engineStarts(evs, now, '24h');
    assert.match(s.summary, new RegExp(`^${want.length} entries for 3 events, from today at 7:00 PM \\(00:00 UTC\\) to tomorrow at .+, your time \\(America/Chicago\\)\\.$`));
    assert.equal(s.marked, 'Marked in the entry titles: Secrets of the Weald (your adjusted time).');
    await click(page, '#calendar-download');
    const files = await downloaded(dir);
    assert.deepEqual(files.map((f) => f.name), ['gw2-timer-starred-next-24-hours.ics']);
    const es = entries(files[0].text);
    assert.deepEqual(es.map((x) => x.start), want);
    assert.ok(es.every((x) => x.alarms.length === 1 && x.alarms[0] === '-PT10M'), '10 minutes before each');
    const weald = es.filter((x) => x.uid.startsWith('secrets-of-the-weald-'));
    assert.ok(weald.length === 12 && weald.every((x) => x.title === 'GW2: Secrets of the Weald (your adjusted time)' && new Date(x.start).getUTCMinutes() === 45), 'at the Adjust time, marked');
    assert.ok(es.filter((x) => !x.uid.startsWith('secrets-')).every((x) => !/\(/.test(x.title)), 'documented events carry no mark');
    assert.equal(new Set(es.map((x) => x.uid)).size, es.length, 'each start once');
    assert.deepEqual(offSite(page), []);
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

check(`${CAL}empty and oversized choices make no file: no stars, nothing chosen, all 35 events for 30 days; the reason is said and Download is off until the choice works`, async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), init: [BLOBS] });
  try {
    await click(page, '#calendar-btn');
    await page.waitFor("document.getElementById('calendar-dialog').open");
    let s = await calState(page);
    assert.deepEqual([s.scope, s.starred, s.pick, s.summary, s.disabled], ['choose', 'Starred events (0)', true, 'Choose at least one event.', true], 'with nothing starred, choosing comes first');
    assert.equal(await page.eval("document.querySelectorAll('#calendar-pick-list [data-cal-pick]').length"), 35);
    await click(page, '[name="calendar-scope"][value="starred"]'); await settle();
    s = await calState(page);
    assert.deepEqual([s.scope, s.pick, s.disabled], ['starred', false, true]);
    assert.match(s.summary, /^No events are starred yet\./);
    await click(page, '[name="calendar-scope"][value="choose"]'); await click(page, '#calendar-pick-all'); await choose(page, '#calendar-span', '30d');
    s = await calState(page);
    const now = await pageNow(page), all = engineStarts(DATA.events, now, '30d').length;
    assert.ok(all > 500);
    assert.deepEqual([s.summary, s.disabled], [`That would be ${all} entries, more than the 500 one file holds. Choose fewer events or a shorter time.`, true]);
    await click(page, '#calendar-download'); await settle();
    assert.deepEqual(await page.eval('window.__blobs.length'), 0, 'a refused choice makes no file');
    await choose(page, '#calendar-span', '24h');
    s = await calState(page);
    assert.equal(s.disabled, false);
    assert.match(s.summary, new RegExp(`^${engineStarts(DATA.events, await pageNow(page), '24h').length} entries for 35 events, `));
    assert.ok(s.marked.startsWith('Marked in the entry titles: '), s.marked);
    for (const id of ['secrets-of-the-weald', 'shackles-of-the-ancients', 'depths-of-cruelty', 'nexus-of-eternity']) assert.ok(s.marked.includes(`${EV.get(id).name} (time unverified)`), id);
    await click(page, '#calendar-pick-none');
    assert.deepEqual([(await calState(page)).summary, (await calState(page)).disabled], ['Choose at least one event.', true]);
    await click(page, `[data-cal-pick="drakkar"]`);
    s = await calState(page);
    assert.match(s.summary, /^12 entries for Drakkar, /);
    assert.equal(s.disabled, false);
    await click(page, `[data-cal-pick="drakkar"]`);
    s = await calState(page);
    assert.deepEqual([s.summary, s.disabled], ['Choose at least one event.', true], 'unticking the one event chosen leaves nothing chosen');
    assert.deepEqual(unexpected(page), []);
  } finally { await page.close(); }
});

check(`${CAL}the same choices give the same file in Chicago, London and Sydney, across the US and EU clock changes of March 2027: UTC starts from the engine, local times in the dialog`, async () => {
  const files = [];
  // 2027-03-27 20:00 UTC: 3:00 PM in Chicago (daylight time since March 14), 8:00 PM in London (summer time from
  // 01:00 UTC on March 28), 7:00 AM on the 28th in Sydney (daylight time until April 4).
  for (const [tz, first] of [['America/Chicago', 'today at 7:00 PM (00:00 UTC)'], ['Europe/London', 'tomorrow at 12:00 AM (00:00 UTC)'], ['Australia/Sydney', 'today at 11:00 AM (00:00 UTC)']]) {
    const page = await openLink('#event/tequatl-the-sunless', { at: utc('2027-03-27T20:00:00Z'), tz });
    try {
      const dir = await downloadsTo(page);
      await click(page, '#event-dialog [data-calendar]');
      await page.waitFor("document.getElementById('calendar-dialog').open");
      await choose(page, '#calendar-span', '7d');
      const s = await calState(page);
      assert.ok(s.summary.startsWith(`42 entries for Tequatl the Sunless, from ${first} to `), `${tz}: ${s.summary}`);
      assert.ok(s.summary.endsWith(`, your time (${tz}).`), s.summary);
      await click(page, '#calendar-download');
      const [f] = await downloaded(dir);
      assert.equal(f.name, 'gw2-timer-tequatl-the-sunless-next-7-days.ics');
      assert.deepEqual(entries(f.text).map((x) => x.start), engineStarts([EV.get('tequatl-the-sunless')], await pageNow(page), '7d'));
      files.push(f.text.replace(/DTSTAMP:\d{8}T\d{6}Z\r\n/g, ''));
    } finally { await page.close(); }
  }
  assert.equal(files[1], files[0], 'London');
  assert.equal(files[2], files[0], 'Sydney');
  assert.ok(!/TZID|VTIMEZONE/.test(files[0]), 'no local time anywhere in the file');
});

check(`${CAL}what the dialog says follows the clock: when the next start passes while it is open, the summary moves to the following start; the details redrawn under it meanwhile, Escape still returns focus to their Add to calendar`, async () => {
  const page = await openLink('#event/tequatl-the-sunless', { at: utc('2026-10-25T23:59:57Z') });
  try {
    await activate(page, '#event-dialog [data-calendar]');
    await page.waitFor("document.getElementById('calendar-dialog').open");
    await page.eval("document.querySelector('#event-dialog [data-calendar]').dataset.before = '1'");
    assert.equal((await calState(page)).summary, '1 entry: Tequatl the Sunless, today at 7:00 PM (00:00 UTC).');
    await page.waitFor("document.getElementById('calendar-summary').textContent === '1 entry: Tequatl the Sunless, today at 10:00 PM (03:00 UTC).'", 6000);
    assert.ok(await pageNow(page) >= utc('2026-10-26T00:00:00Z'));
    // Tequatl's window opened at 00:00, so its details were drawn again: the button that opened the dialog is gone.
    assert.match(await text(page, '#event-dialog-when'), /^Scheduled now, until 7:30 PM/);
    assert.equal(await page.eval("document.querySelector('#event-dialog [data-calendar]').dataset.before || ''"), '', 'a new button');
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('calendar-dialog').open");
    // The browser's own return goes to the old button, which is gone; the page's comes with the close event, which
    // can arrive a frame later (Edge here, and Chrome on Linux as v0.3.0 found).
    await page.waitFor("document.activeElement.getAttribute('data-fkey') === 'dlg:calendar'", 2000);
    assert.equal(await page.eval("document.getElementById('event-dialog').open"), true, 'the details stay open');
  } finally { await page.close(); }
});

check(`${CAL}keyboard and screen readers: a modal named Add to calendar, described by what it does; every choice has a name; the summary is a status; Tab stays inside; Escape returns focus to the Calendar button`, async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), seed: { [PREFS]: { ...SAVED, starred: ['drakkar'] } } });
  try {
    await page.send('Accessibility.enable');
    const ax = async (sel) => {
      const { root } = await page.send('DOM.getDocument', {});
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      const { nodes } = await page.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const n = nodes[0], prop = (k) => ((n.properties || []).find((p) => p.name === k) || {}).value;
      return { role: n.role && n.role.value, name: n.name && n.name.value, description: n.description && n.description.value, modal: prop('modal') && prop('modal').value, haspopup: prop('hasPopup') && prop('hasPopup').value };
    };
    const btn = await ax('#calendar-btn');
    assert.deepEqual([btn.role, btn.name, btn.haspopup], ['button', 'Calendar', 'dialog']);
    await page.eval("document.getElementById('calendar-btn').focus()");
    await key(page, 'Enter', 'Enter', 13);
    await page.waitFor("document.getElementById('calendar-dialog').open");
    const d = await ax('#calendar-dialog');
    assert.deepEqual([d.role, d.name, d.modal], ['dialog', 'Add to calendar', true]);
    assert.match(d.description, /^A calendar file \(\.ics\) with the scheduled starts you choose/);
    assert.equal((await ax('#calendar-summary')).role, 'status');
    assert.equal((await ax('#calendar-done')).role, 'status');
    await click(page, '[name="calendar-scope"][value="choose"]'); await settle();
    const names = await page.eval(`(() => [...document.querySelectorAll('#calendar-dialog input, #calendar-dialog select, #calendar-dialog button')].filter((x) => x.getClientRects().length)
      .map((x) => (x.labels && x.labels[0] ? x.labels[0].textContent : x.getAttribute('aria-label') || x.textContent).replace(/\\s+/g, ' ').trim()))()`);
    assert.ok(names.every(Boolean), JSON.stringify(names));
    for (const n of ['Close', 'Starred events (1)', 'Choose events', 'Select all', 'Clear', 'Drakkar', 'Secrets of the Weald (time unverified)', 'Download calendar file']) assert.ok(names.includes(n), n);
    assert.ok(names.some((n) => /^Starts /.test(n)) && names.some((n) => /^Calendar alarm /.test(n)), 'the selects are named by their labels');
    assert.deepEqual([(await ax('#calendar-pick-list fieldset')).role, (await ax('#calendar-pick-list fieldset')).name], ['group', 'World bosses']);
    const where = [];
    for (let i = 0; i < 50; i++) { await key(page, 'Tab', 'Tab', 9); where.push(await page.eval("(() => { const a = document.activeElement; return !a || a === document.body ? 'browser' : document.getElementById('calendar-dialog').contains(a) ? 'dialog' : 'page:' + (a.id || a.className); })()")); }
    assert.ok(!where.some((w) => w.startsWith('page:')) && where.filter((w) => w === 'dialog').length >= 40, where.join(','));
    await key(page, 'Escape', 'Escape', 27);
    await page.waitFor("!document.getElementById('calendar-dialog').open");
    assert.equal(await page.eval('document.activeElement.id'), 'calendar-btn');
  } finally { await page.close(); }
});

check(`${CAL}a reminder that comes while Add to calendar is open over an event's details is said in Add to calendar, the dialog on top, once`, async () => {
  const prefs = { ...SAVED, filter: 'all', hidden: [], regions: DATA.regions.map((r) => r.id), starred: ['tequatl-the-sunless'] };
  const page = await openR({ at: T0 - 10 * MIN - 4000, clock: 'fail', prefs });
  try {
    await activate(page, '#next-list .row[data-id="defense-of-amnytas"] a.event-link');
    await page.waitFor("document.getElementById('event-dialog').open");
    await activate(page, '#event-dialog [data-calendar]');
    await page.waitFor("document.getElementById('calendar-dialog').open");
    assert.equal((await trayState(page)).said.length, 0, 'not due yet');
    await page.waitFor('window.__said.length > 0', 8000);
    await sleep(1200);
    const said = (await trayState(page)).said;
    assert.deepEqual(said.map((s) => [s.text, s.where]), [['Reminder: Tequatl the Sunless starts at 7:00 PM, in 10 minutes.', 'calendar-dialog']]);
  } finally { await page.close(); }
});

check(`${CAL}the dialog and the Calendar button fit a 320, 360 and 390 px phone and a desktop, in both themes: inside the window, no sideways scroll, 36 px controls, readable text`, async () => {
  for (const [width, height, mobile] of [[320, 568, true], [360, 740, true], [390, 844, true], [1280, 900, false]]) {
    for (const theme of ['dark', 'light']) {
      const page = await open({ at: utc('2026-10-25T23:50:00Z'), width, height, mobile, seed: { [PREFS]: { ...SAVED, theme, starred: ['drakkar', 'octovine'] } } });
      try {
        if (mobile) await click(page, '#filters-toggle');
        const b = await page.eval("(() => { const r = document.getElementById('calendar-btn').getBoundingClientRect(); return { right: r.right, h: r.height, page: document.documentElement.scrollWidth }; })()");
        assert.ok(b.right <= width && b.page <= width && (!mobile || b.h >= 36), `${width} ${theme}: Calendar button ${JSON.stringify(b)}`);
        await click(page, '#calendar-btn');
        await page.waitFor("document.getElementById('calendar-dialog').open");
        await click(page, '[name="calendar-scope"][value="choose"]'); await click(page, '[data-cal-pick="secrets-of-the-weald"]'); await settle();
        const r = await page.eval("(() => { const d = document.getElementById('calendar-dialog'), b = d.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, inner: d.scrollWidth <= d.clientWidth, page: document.documentElement.scrollWidth }; })()");
        assert.ok(r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= height && r.inner && r.page <= width, `${width} ${theme}: ${JSON.stringify(r)}`);
        if (mobile) {
          const small = await page.eval("[...document.querySelectorAll('#calendar-dialog button, #calendar-dialog select, #calendar-dialog label.rm-option')].filter((x) => x.getClientRects().length && x.getBoundingClientRect().height < 36).map((x) => x.textContent.trim().slice(0, 30))");
          assert.deepEqual(small, [], `${width} ${theme}`);
        }
        assert.deepEqual(await lowContrast(page, '#calendar-dialog p, #calendar-dialog li, #calendar-dialog label, #calendar-dialog legend, #calendar-dialog span, #calendar-dialog h2, #calendar-dialog h3'), [], `${width} ${theme}`);
        if (SHOTS && theme === 'dark' && [320, 1280].includes(width)) await page.screenshot(join(SHOTS, `calendar-${width}.png`));
      } finally { await page.close(); }
    }
  }
});

check('desktop screenshot for visual review', async () => {
  if (!SHOTS) return;
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    await page.screenshot(join(SHOTS, 'desktop.png'), true);
    await click(page, '#theme-btn'); await settle();
    await page.screenshot(join(SHOTS, 'desktop-light.png'), { height: 1400 });
  } finally { await page.close(); }
});

// ---- v0.4.0 Phase C: the two modes and the Trading Post (tests/smoke-market.mjs) ----

const { marketChecks } = await import('./smoke-market.mjs');
marketChecks({ check, open, click, text, key, settle, sleep, utc, unexpected, lowContrast, BASE, ROOT, DIR, SHOTS, VERSION, reminders: { RSET, ON, PREFS, LISTEN, BLOCK_STORAGE, FAIL_WRITES, trayState } });

// ---- Run ----

if (SHOTS) mkdirSync(SHOTS, { recursive: true });
try {
  for (const c of checks) {
    if (ONLY && !c.name.includes(ONLY)) continue;
    try { await c.fn(); passed++; console.log(`ok   ${c.name}`); }
    catch (e) { failed++; console.log(`FAIL ${c.name}\n     ${String(e.message).split('\n').join('\n     ')}`); }
  }
} finally {
  await chrome.close();
  server.close(); dated.close(); skewed.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
