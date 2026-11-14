// Browser tests on the built site (dist/, from node tools/build.mjs), in headless Chrome over the
// DevTools protocol with no dependencies. Each check opens a fresh tab with a simulated clock and time
// zone; the news feed is answered from a fixture, failed, or cut off, so no test reaches ArenaNet.
//
//   node tests/smoke.mjs [--dir dist] [--only <part of a check name>] [--shots <folder>]
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
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
const BASE = `http://127.0.0.1:${port}/`;
const chrome = await launchChrome();
await chrome.grant(BASE.slice(0, -1), ['clipboardReadWrite', 'clipboardSanitizedWrite']);

let passed = 0, failed = 0;
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

/** A fresh tab: storage cleared, a simulated clock and zone, and the news feed answered by `news.mode`. */
async function open({ at, tz = 'America/Chicago', width = 1280, height = 900, mobile = false, news = { mode: 'fixture' }, url = BASE, keepStorage = false } = {}) {
  const page = await chrome.newPage();
  if (!keepStorage) await page.send('Storage.clearDataForOrigin', { origin: BASE.slice(0, -1), storageTypes: 'all' });
  await page.emulate({ timezone: tz, locale: 'en-US' });
  await page.viewport(width, height, mobile);
  if (at) await page.startClockAt(at);
  page.newsRequests = 0;
  await page.send('Fetch.enable', { patterns: [{ urlPattern: 'https://www.guildwars2.com/*' }] });
  page.on('Fetch.requestPaused', async (p) => {
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
  await page.waitFor("document.querySelectorAll('#next-list .row, #next-empty:not([hidden])').length > 0");
  return page;
}
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
    assert.equal(await page.eval('document.title'), 'GW2 Timer: Guild Wars 2 World Boss and Meta Event Timers');
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

check('the news headlines are on screen without scrolling, on a desktop and on a phone', async () => {
  for (const [width, height, mobile] of [[1280, 900, false], [1366, 768, false], [390, 844, true], [360, 640, true]]) {
    const page = await open({ at: utc('2026-10-25T23:50:00Z'), width, height, mobile });
    try {
      await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
      const b = await page.eval("[document.querySelector('#news-list li:last-child').getBoundingClientRect().bottom, innerHeight, scrollY]");
      assert.ok(b[0] <= b[1] && b[2] === 0, `${width}x${height}: last headline ends at ${b[0]} of ${b[1]}`);
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
check('on a 390 px phone nothing scrolls sideways and every control is at least 36 px tall', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), width: 390, height: 844, mobile: true });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 3");
    await click(page, '#next-list .row [data-adjust], #now-list [data-adjust]'); await settle();
    await click(page, '#schedule-notes summary'); await settle();
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
    const order = [at('news-toggle'), at('news-link'), at('news-more'), at('seg-btn'), at('chip'), at('ahead'), at(/star-btn/), at(/copy/)];
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
    const unnamed = await page.eval("[...document.querySelectorAll('button, a[href], select, summary')].filter((el) => !(el.getAttribute('aria-label') || el.textContent.trim() || (el.labels && el.labels.length))).map((el) => el.outerHTML.slice(0, 80))");
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
  server.close(); dated.close();
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
