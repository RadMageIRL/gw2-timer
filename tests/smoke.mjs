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
const FEED = readFileSync(join(ROOT, 'tests', 'fixtures', 'news-feed.xml'), 'utf8');
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
    if (news.mode === 'fixture') {
      await page.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, body: Buffer.from(FEED).toString('base64'),
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

check('desktop load at 23:50 UTC in Chicago: header, footer, Happening now and Coming up are right', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    assert.equal(await page.eval('document.title'), 'GW2 Timer v0.1.0 - World Bosses, Meta Events & More | Unofficial fansite | RadMage Labs');
    assert.match(await text(page, '.brand .tag'), /^v0\.1\.0 · World Bosses, Meta Events & More · RadMage Labs$/);
    assert.equal(await text(page, '#revision'), 'Schedule r1 · reviewed Oct 25, 2026');
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
    assert.equal(await page.eval("[...document.querySelectorAll('.pill')].every((p) => p.textContent === 'Scheduled now')"), true);
    assert.equal(await page.eval("/\\blive\\b/i.test([...document.querySelectorAll('.pill, .badge, h2')].map((e) => e.textContent).join(' '))"), false, 'nothing is labeled live');
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

check('at midnight UTC the daily reset rolls over and the 00:00 events move into Happening now', async () => {
  const page = await open({ at: utc('2026-10-25T23:59:55Z') });
  try {
    assert.ok(!(await cards(page)).includes('tequatl-the-sunless'));
    await page.waitFor("[...document.querySelectorAll('#now-list .event')].some((c) => c.dataset.id === 'tequatl-the-sunless')", 12000);
    assert.match(await text(page, '#strip'), /Daily reset7:00 PMin 23h 5\dm/);
    const r = await rows(page);
    assert.ok(!r.some((x) => x.start === utc('2026-10-26T00:00:00Z')), 'the 00:00 starts left Coming up');
  } finally { await page.close(); }
});

check('an event that starts moves from Coming up into Happening now on its own (00:15, not midnight)', async () => {
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

check('news shows five headlines as plain text, says it contacts guildwars2.com, and can be turned off', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 5");
    assert.match(await text(page, '#news-note'), /guildwars2\.com \(ArenaNet\), so ArenaNet sees this request/);
    assert.equal(await page.eval("document.querySelector('#news-list script, #news-list b')"), null);
    assert.match(await text(page, '#news-list li:nth-child(2) a'), /alert\(1\)/);
    assert.deepEqual(await page.eval("[...document.querySelectorAll('#news-list a')].map((a) => a.getAttribute('href'))").then((h) => h.slice(0, 2)),
      ['https://www.guildwars2.com/en/news/first-test-post/', 'https://www.guildwars2.com/en/news/second-post/?keep=1']);
    await click(page, '#news-toggle'); await settle();
    assert.match(await text(page, '#news-note'), /News is off/);
    const before = page.newsRequests;
    await page.reload();
    await page.waitFor("document.querySelectorAll('#next-list .row').length > 0");
    await sleep(500);
    assert.equal(page.newsRequests, before, 'no request to guildwars2.com while news is off');
    assert.equal(await page.eval("document.querySelectorAll('#news-list li').length"), 0);
  } finally { await page.close(); }
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
  await first.waitFor("document.querySelectorAll('#news-list li').length === 5");
  await first.close();
  news.mode = 'offline';
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), news, keepStorage: true });
  try {
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await page.waitFor("/did not answer; these are the headlines saved/.test(document.getElementById('news-note').textContent)");
    assert.equal(await page.eval("document.querySelectorAll('#news-list li').length"), 5);
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
    await page.waitFor("document.querySelectorAll('#news-list li').length === 5");
    const outside = page.requests.filter((u) => !u.startsWith(BASE) && u !== FEED_URL);
    assert.deepEqual(outside, []);
    assert.ok(page.requests.includes(FEED_URL));
  } finally { await page.close(); }
});

check('opened from a file: the page works with no errors', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), url: pathToFileURL(join(DIR, 'index.html')).href });
  try {
    assert.ok((await rows(page)).length > 10);
    await page.waitFor("document.querySelectorAll('#news-list li').length === 5");
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

// ---- Layout, keyboard, motion ----

check('on a 390 px phone nothing scrolls sideways and every control is reachable', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z'), width: 390, height: 844, mobile: true });
  try {
    await click(page, '#next-list .row [data-adjust], #now-list [data-adjust]'); await settle();
    // Mobile emulation widens the layout to fit overflowing content, so compare with the device width itself.
    assert.deepEqual(await page.eval('[document.documentElement.scrollWidth, innerWidth]'), [390, 390], 'no sideways scroll');
    const small = await page.eval("[...document.querySelectorAll('button, a.btn, select')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 26).map((b) => b.textContent)");
    assert.deepEqual(small, []);
    if (SHOTS) await page.screenshot(join(SHOTS, 'mobile.png'), { height: 2200 });
  } finally { await page.close(); }
});

check('keyboard: Tab reaches the skip link, the filters and the event buttons, and Escape closes About', async () => {
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    const seen = [];
    for (let i = 0; i < 40; i++) {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      seen.push(await page.eval("(document.activeElement.className || document.activeElement.tagName) + ''"));
    }
    assert.equal(seen[0], 'skip');
    assert.ok(seen.includes('seg-btn') && seen.includes('chip') && seen.some((c) => c.includes('star-btn')) && seen.some((c) => c.includes('copy')), seen.join(','));
    await click(page, '#about-btn'); await settle();
    assert.equal(await page.eval("document.getElementById('about').open"), true);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await settle();
    assert.equal(await page.eval("document.getElementById('about').open"), false);
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

check('desktop screenshot for visual review', async () => {
  if (!SHOTS) return;
  const page = await open({ at: utc('2026-10-25T23:50:00Z') });
  try {
    await page.waitFor("document.querySelectorAll('#news-list li').length === 5");
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
