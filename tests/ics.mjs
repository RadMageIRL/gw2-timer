// Tests for js/ics.js. Run alone with `node tests/ics.mjs`, or through tests/run.mjs, which runs it once per
// time zone: a calendar file is written in UTC only, so every zone must produce the same bytes.
//
// The files are read back here by a strict reader of its own, not by the module: it checks the line
// endings, the folding, the structure and the value formats, then expands the entries so their starts can
// be compared with js/schedule.js, the engine the page itself shows.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Ics = require('../js/ics.js');
const S = require('../js/schedule.js');
const Link = require('../js/link.js');
const DATA = require('../events-data.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = DATA.events, BY = new Map(EVENTS.map((e) => [e.id, e]));
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const utc = (iso) => Date.parse(iso);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

// ---- A strict reader of the files this module writes ----

const STAMP = /^\d{8}T\d{6}Z$/;
const parseStamp = (s) => { assert.match(s, STAMP, s); return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)); };
const unescapeText = (v) => v.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? '\n' : c));
/** Every TEXT value: no bare comma or semicolon, and a backslash only as the start of an escape. */
function checkEscaped(v, what) {
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '\\') { assert.ok('\\;,nN'.includes(v[i + 1] || 'x'), `${what}: stray backslash: ${v}`); i++; }
    else assert.ok(c !== ',' && c !== ';', `${what}: unescaped ${c}: ${v}`);
  }
}
const TEXT_PROPS = ['SUMMARY', 'LOCATION', 'DESCRIPTION', 'X-WR-CALNAME'];

function read(file) {
  assert.ok(file.endsWith('\r\n'), 'ends with CRLF');
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(file), 'every line break is CRLF');
  const physical = file.slice(0, -2).split('\r\n');
  for (const l of physical) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `a physical line over 75 octets: ${l}`);
  for (const [i, l] of physical.entries()) {
    if (i + 1 < physical.length && physical[i + 1].startsWith(' ')) assert.ok(/(^|[^\\])(\\\\)*$/.test(l), `a fold splits an escape after: ${l}`);
  }
  const lines = file.slice(0, -2).replace(/\r\n[ \t]/g, '').split('\r\n');
  const stack = [], cal = { props: {}, events: [] };
  let ev = null, alarm = null;
  for (const l of lines) {
    const m = /^([A-Z][A-Z0-9-]*):(.*)$/.exec(l);
    assert.ok(m, `not a NAME:value line: ${l}`);
    const [, name, value] = m;
    if (name === 'BEGIN') {
      stack.push(value);
      if (value === 'VEVENT') { assert.equal(stack.join('/'), 'VCALENDAR/VEVENT'); ev = { props: {}, alarms: [] }; }
      else if (value === 'VALARM') { assert.equal(stack.join('/'), 'VCALENDAR/VEVENT/VALARM'); alarm = {}; }
      else assert.equal(stack.join('/'), 'VCALENDAR', `unexpected component ${value}`);
      continue;
    }
    if (name === 'END') {
      assert.equal(stack.pop(), value, `END:${value} closes what it should`);
      if (value === 'VEVENT') { cal.events.push(ev); ev = null; }
      if (value === 'VALARM') { ev.alarms.push(alarm); alarm = null; }
      continue;
    }
    const into = alarm || (ev && ev.props) || cal.props;
    assert.ok(!(name in into), `${name} given twice in one component`);
    if (TEXT_PROPS.includes(name) || (alarm && name === 'DESCRIPTION')) { checkEscaped(value, name); into[name] = unescapeText(value); } else into[name] = value;
  }
  assert.equal(stack.length, 0, 'every component is closed');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.deepEqual([cal.props.VERSION, cal.props.PRODID, cal.props.CALSCALE, cal.props.METHOD], ['2.0', Ics.PRODID, 'GREGORIAN', 'PUBLISH']);
  const uids = new Set();
  for (const e of cal.events) {
    for (const k of ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY', 'DESCRIPTION', 'TRANSP']) assert.ok(k in e.props, `VEVENT without ${k}`);
    assert.ok(!uids.has(e.props.UID), `UID given twice: ${e.props.UID}`);
    uids.add(e.props.UID);
    e.start = parseStamp(e.props.DTSTART); e.end = parseStamp(e.props.DTEND); e.stamp = parseStamp(e.props.DTSTAMP);
    assert.ok(e.end > e.start, 'ends after it starts');
    assert.ok(!('RRULE' in e.props) && !('RDATE' in e.props) && !('EXDATE' in e.props) && !('TZID' in e.props), 'explicit occurrences only');
    for (const a of e.alarms) {
      assert.deepEqual(Object.keys(a).sort(), ['ACTION', 'DESCRIPTION', 'TRIGGER']);
      assert.equal(a.ACTION, 'DISPLAY');
      assert.match(a.TRIGGER, /^-PT(5|10|15)M$/);
    }
  }
  return cal;
}

const effective = (overrides = {}) => EVENTS.map((e) => (overrides[e.id] !== undefined ? S.applyOverride(e, overrides[e.id]) : e));
const build = (o) => Ics.build({ engine: S, meta: DATA.meta, link: Link.make, alarmMin: 0, ...o });
/** What the page shows for the same choice, from the engine directly. */
function truth(events, now, span) {
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];
  const items = span === 'next' ? unique.map((e) => ({ id: e.id, start: S.nextStart(e.schedule, now) })) : S.upcoming(unique, now, Ics.SPANS[span]).map((i) => ({ id: i.event.id, start: i.start }));
  return items.sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : 1));
}
const idOf = (ev) => ev.props.UID.replace(/-\d{8}T\d{6}Z@gw2-timer\.radmagelabs\.com$/, '');

// ---- The module ----

test('the module needs nothing from a page: it loads with no window, document or location, and sets one global', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'ics.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['GW2Ics']);
});

test('the output depends on nothing but its inputs: no clock, randomness, locale, network or storage in the module', () => {
  const src = readFileSync(join(ROOT, 'js', 'ics.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const bad of ['Date.now', 'new Date()', 'Math.random', 'performance.', 'localeCompare', 'toLocale', 'Intl.', 'fetch(', 'XMLHttpRequest', 'localStorage', 'sessionStorage', 'document.', 'window.', 'navigator.']) {
    assert.ok(!src.includes(bad), bad);
  }
  assert.ok(!/RRULE|RDATE|TZID|VTIMEZONE/.test(src), 'no recurrence rules or time zones are written');
});

test('the spans, alarms and limit are the ones the dialog offers', () => {
  assert.deepEqual(Object.keys(Ics.SPANS), ['next', '24h', '3d', '7d', '30d']);
  assert.deepEqual(Object.values(Ics.SPANS), [0, DAY, 3 * DAY, 7 * DAY, 30 * DAY]);
  assert.deepEqual(Ics.ALARMS, [0, 5, 10, 15]);
  assert.equal(Ics.MAX_ENTRIES, 500);
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const dlg = html.slice(html.indexOf('<dialog id="calendar-dialog"'), html.indexOf('</dialog>', html.indexOf('<dialog id="calendar-dialog"')));
  assert.deepEqual([...dlg.matchAll(/<select id="calendar-span">([\s\S]*?)<\/select>/g)].length, 1);
  assert.deepEqual([.../<select id="calendar-span">([\s\S]*?)<\/select>/.exec(dlg)[1].matchAll(/value="([^"]+)"/g)].map((m) => m[1]), Object.keys(Ics.SPANS));
  assert.deepEqual([.../<select id="calendar-alarm">([\s\S]*?)<\/select>/.exec(dlg)[1].matchAll(/value="([^"]+)"/g)].map((m) => Number(m[1])), Ics.ALARMS);
});

// ---- Format ----

test('UTC date-times are written with a Z, to the second, whatever the zone', () => {
  assert.equal(Ics.utc(utc('2026-10-26T00:00:00Z')), '20261026T000000Z');
  assert.equal(Ics.utc(utc('2027-03-14T08:05:09.999Z')), '20270314T080509Z');
  assert.equal(Ics.utc(utc('1999-12-31T23:59:59Z')), '19991231T235959Z');
});

test('text values escape backslash, semicolon and comma, turn line breaks into \\n and drop control characters', () => {
  assert.equal(Ics.text('a,b;c\\d'), 'a\\,b\\;c\\\\d');
  assert.equal(Ics.text('one\ntwo\r\nthree\rfour'), 'one\\ntwo\\nthree\\nfour');
  assert.equal(Ics.text('bell\u0007tab\tok'), 'belltab\tok');
  assert.equal(Ics.text("Serpents' Ire: Hammerhart Rumble!"), "Serpents' Ire: Hammerhart Rumble!");
});

test('long lines fold at 75 octets, never inside a character, and unfold to the same line', () => {
  for (const line of ['DESCRIPTION:' + 'x'.repeat(300), 'SUMMARY:' + 'é'.repeat(100), 'SUMMARY:' + '☆★'.repeat(60), 'SUMMARY:' + '😀'.repeat(40) + 'a', 'SHORT:ok', 'X:' + 'a'.repeat(73)]) {
    const f = Ics.fold(line);
    const parts = f.split('\r\n');
    for (const [i, p] of parts.entries()) {
      assert.ok(Buffer.byteLength(p, 'utf8') <= 75, `${i}: ${Buffer.byteLength(p, 'utf8')} octets`);
      if (i) assert.equal(p[0], ' ');
      assert.ok(!p.includes('�'), 'no character split');
    }
    assert.equal(f.replace(/\r\n /g, ''), line);
  }
  assert.equal(Ics.fold('X:' + 'a'.repeat(73)), 'X:' + 'a'.repeat(73), 'exactly 75 octets is not folded');
  // An escape that would straddle the 75th octet moves to the next line whole.
  const esc = Ics.fold('X:' + 'a'.repeat(72) + '\\,b');
  assert.equal(esc, 'X:' + 'a'.repeat(72) + '\r\n \\,b');
  for (let k = 60; k < 80; k++) {
    const line = 'D:' + 'a'.repeat(k) + Ics.text(',;\\\n'.repeat(20));
    for (const part of Ics.fold(line).split('\r\n')) assert.ok(/(^|[^\\])(\\\\)*$/.test(part), `${k}: ${part}`);
  }
});

test('a file with odd characters in a name still reads back: commas, semicolons, a backslash, a line break and a long name', () => {
  const odd = Object.assign({}, BY.get('tequatl-the-sunless'), { id: 'odd-one', name: 'A, B; C\\D\nE ' + 'Long '.repeat(30), map: 'Map, with; marks' });
  const r = build({ events: [odd], now: utc('2026-10-25T23:50:00Z'), span: 'next' });
  assert.ok(r.ok);
  const cal = read(r.text);
  assert.equal(cal.events[0].props.SUMMARY, 'GW2: A, B; C\\D\nE ' + 'Long '.repeat(30));
  assert.equal(cal.events[0].props.LOCATION, 'Map, with; marks (Guild Wars 2)');
});

// ---- The entries are the engine's starts ----

// Each instant with the spans it is checked for: every span once, and spans of 3 days from 1 to 2 days before
// each daylight-saving change, so the files reach across it.
const ALL = Object.keys(Ics.SPANS), SHORT = ['next', '24h', '3d'];
const INSTANTS = [
  ['an ordinary evening', '2026-10-25T23:50:00Z', ALL],
  ['the exact instant of a start', '2026-10-26T00:00:00Z', ['next', '24h', '7d']],
  ['a millisecond before a start', '2026-10-25T23:59:59.999Z', ['next', '24h', '7d']],
  ['before the US change to daylight time (2027-03-14)', '2027-03-12T18:20:00Z', SHORT],
  ['before the EU change to summer time (2027-03-28)', '2027-03-26T09:41:30Z', SHORT],
  ['before the US change back (2026-11-01)', '2026-10-31T16:07:00Z', SHORT],
  ['before the EU change back (2026-10-25)', '2026-10-23T22:00:00Z', SHORT],
  ['before Lord Howe moves 30 minutes (2026-10-04)', '2026-10-02T13:15:00Z', SHORT],
  ['across a year end', '2026-12-31T21:00:00Z', SHORT],
];
test('for every event alone, every span and nine instants (exact starts, every daylight-saving change), the file holds exactly the starts the engine gives', () => {
  for (const [what, iso, spans] of INSTANTS) {
    const now = utc(iso);
    for (const span of spans) {
      for (const e of EVENTS) {
        const r = build({ events: [e], now, span });
        assert.ok(r.ok, `${what} ${span} ${e.id}: ${r.reason}`);
        const cal = read(r.text), want = truth([e], now, span);
        assert.deepEqual(cal.events.map((x) => x.start), want.map((x) => x.start), `${what} ${span} ${e.id}`);
        for (const x of cal.events) {
          assert.ok(x.start > now, 'only starts after now');
          assert.equal(x.end - x.start, e.schedule.windowMin * MIN, `${e.id}: the entry lasts the scheduled window`);
          assert.equal(idOf(x), e.id);
        }
      }
    }
  }
});

test('several events in one file: the union of their starts in time order, ties by event id, each start once', () => {
  const now = utc('2026-10-25T23:50:00Z');
  const four = ['tequatl-the-sunless', 'admiral-taidha-covington', 'kaineng-blackout', 'defense-of-amnytas'].map((id) => BY.get(id));
  for (const span of ['next', '24h', '3d']) {
    const r = build({ events: four, now, span }), cal = read(r.text), want = truth(four, now, span);
    assert.deepEqual(cal.events.map((x) => [idOf(x), x.start]), want.map((x) => [x.id, x.start]), span);
    assert.equal(r.count, want.length);
  }
  // All four start at 00:00 UTC: one entry each, by id.
  const first = read(build({ events: four, now, span: 'next' }).text).events.map(idOf);
  assert.deepEqual(first, ['admiral-taidha-covington', 'defense-of-amnytas', 'kaineng-blackout', 'tequatl-the-sunless']);
});

test('every event for 24 hours fits in one file and matches the engine; 7 or 30 days of everything is refused as too many, with the count', () => {
  const now = utc('2027-03-27T20:00:00Z');
  const day = build({ events: EVENTS, now, span: '24h' });
  assert.ok(day.ok, day.reason);
  assert.deepEqual(read(day.text).events.map((x) => x.start), truth(EVENTS, now, '24h').map((x) => x.start));
  for (const span of ['7d', '30d']) {
    const r = build({ events: EVENTS, now, span });
    assert.deepEqual([r.ok, r.reason, r.count, r.text, r.entries], [false, 'too-many', truth(EVENTS, now, span).length, '', []], span);
  }
  // At the limit and one over it: a 2-hour event has 12 starts a day, so 30 days is 360 and fits.
  const nightly = build({ events: [BY.get('night-and-the-enemy')], now, span: '30d' });
  assert.deepEqual([nightly.ok, nightly.count], [true, 360]);
});

test('the limit is exact: 500 entries make a file, 501 do not (an engine that gives that many starts)', () => {
  const t = BY.get('tequatl-the-sunless'), now = utc('2026-10-25T23:50:00Z');
  const many = (n) => ({ nextStart: () => NaN, upcoming: (evs) => Array.from({ length: n }, (_, i) => ({ event: evs[0], start: now + (i + 1) * MIN })) });
  const at = Ics.build({ events: [t], engine: many(500), now, span: '30d' });
  assert.deepEqual([at.ok, at.count], [true, 500]);
  assert.equal(read(at.text).events.length, 500);
  const over = Ics.build({ events: [t], engine: many(501), now, span: '30d' });
  assert.deepEqual([over.ok, over.reason, over.count, over.text], [false, 'too-many', 501, '']);
});

test('a start the engine gives twice is written once', () => {
  const t = BY.get('tequatl-the-sunless'), now = utc('2026-10-25T23:50:00Z'), s = utc('2026-10-26T00:00:00Z');
  const twice = { nextStart: () => s, upcoming: (evs) => [{ event: evs[0], start: s }, { event: evs[0], start: s }, { event: evs[0], start: s + 3 * HOUR }] };
  const r = Ics.build({ events: [t], engine: twice, now, span: '24h' });
  assert.deepEqual(read(r.text).events.map((x) => x.start), [s, s + 3 * HOUR]);
  assert.equal(r.count, 2);
});

test('the same event given twice, by itself or adjusted, counts once', () => {
  const now = utc('2026-10-25T23:50:00Z'), t = BY.get('tequatl-the-sunless');
  const r = build({ events: [t, t, Object.assign({}, t)], now, span: '24h' });
  assert.equal(r.count, truth([t], now, '24h').length);
  read(r.text);
});

test('an empty choice, an unknown span, a bad alarm or an event without an id, name or window makes no file', () => {
  const now = utc('2026-10-25T23:50:00Z'), t = BY.get('tequatl-the-sunless');
  const no = (r, reason) => assert.deepEqual([r.ok, r.reason, r.text, r.count], [false, reason, '', 0]);
  no(build({ events: [], now, span: 'next' }), 'empty');
  no(build({ events: [t], now, span: '1y' }), 'span');
  no(build({ events: [t], now, span: 'toString' }), 'span');
  for (const alarmMin of [7, -5, '10', 60, null, NaN]) no(build({ events: [t], now, span: 'next', alarmMin }), 'alarm');
  for (const bad of [null, {}, Object.assign({}, t, { id: 'Bad Id' }), Object.assign({}, t, { id: 'x\r\nATTACH:evil' }), Object.assign({}, t, { name: ' ' }), Object.assign({}, t, { schedule: Object.assign({}, t.schedule, { windowMin: 0 }) })]) {
    no(build({ events: [bad], now, span: 'next' }), 'event');
  }
  for (const schedule of [{ type: 'daily', startsUtc: [], windowMin: 30 }, { type: 'every', periodMin: 0, offsetMin: 0, windowMin: 15 }, { type: 'weekly', windowMin: 15 }, null]) {
    no(build({ events: [Object.assign({}, t, { schedule })], now, span: 'next' }), 'event');
  }
  no(build({ events: null, now, span: 'next' }), 'event');
  no(build({ events: [t], now: NaN, span: 'next' }), 'event');
  // An engine with no start in the span (none of today's events can do that): no empty file either.
  no(Ics.build({ events: [t], engine: { upcoming: () => [], nextStart: () => NaN }, now, span: '24h' }), 'none');
  no(Ics.build({ events: [t], engine: { upcoming: () => [], nextStart: () => NaN }, now, span: 'next' }), 'none');
});

// ---- What an entry says ----

test('a documented event: its name, map, window, waypoint, schedule revision and link, and no note or tentative status', () => {
  const now = utc('2026-10-25T23:50:00Z'), t = BY.get('tequatl-the-sunless');
  const ev = read(build({ events: [t], now, span: 'next' }).text).events[0];
  assert.equal(ev.props.SUMMARY, 'GW2: Tequatl the Sunless');
  assert.equal(ev.props.LOCATION, 'Sparkfly Fen (Guild Wars 2)');
  assert.equal(ev.props.URL, 'https://radmagelabs.com/gw2-timer/#event/tequatl-the-sunless');
  assert.equal(ev.props.UID, 'tequatl-the-sunless-20261026T000000Z@gw2-timer.radmagelabs.com');
  assert.equal(ev.props.TRANSP, 'TRANSPARENT');
  assert.ok(!('STATUS' in ev.props));
  const d = ev.props.DESCRIPTION;
  assert.ok(d.startsWith('Scheduled start of the Guild Wars 2 world boss Tequatl the Sunless, in Sparkfly Fen.\n'), d);
  assert.ok(d.includes('Its scheduled window is 30 minutes. Scheduled, not live: the game has no public live-event feed, so a map can run early, late, fail or close.'));
  assert.ok(d.includes(`Waypoint: ${t.waypoint.name} ${t.waypoint.chat}`));
  assert.ok(d.includes(`GW2 Timer schedule r${DATA.meta.datasetRevision}, checked against game updates through ${DATA.meta.reviewedThroughPatch}.`));
  assert.ok(d.endsWith('Details: https://radmagelabs.com/gw2-timer/#event/tequatl-the-sunless'));
  assert.ok(!/unverified|adjust|recheck/i.test(d));
});

test('disputed and unverified events say "time unverified" in the title and why in the description, and are tentative', () => {
  const now = utc('2026-10-25T23:50:00Z');
  const cases = [['secrets-of-the-weald', 'Unverified: sources disagree on this time.'], ['shackles-of-the-ancients', 'Unverified: sources disagree on this time.'],
    ['depths-of-cruelty', 'Unverified: new or thinly sourced, and not yet checked in game.'], ['nexus-of-eternity', 'Unverified: new or thinly sourced, and not yet checked in game.']];
  for (const [id, line] of cases) {
    const e = BY.get(id), r = build({ events: [e], now, span: 'next' }), ev = read(r.text).events[0];
    assert.equal(ev.props.SUMMARY, `GW2: ${e.name} (time unverified)`);
    assert.equal(ev.props.STATUS, 'TENTATIVE');
    assert.ok(ev.props.DESCRIPTION.includes(line), id);
    assert.deepEqual(r.uncertain.map((x) => x.id), [id]);
  }
  for (const e of EVENTS.filter((x) => x.status === 'documented')) assert.deepEqual(build({ events: [e], now, span: 'next' }).uncertain, [], e.id);
});

test('an event adjusted with Adjust follows the reader\'s time, says "your adjusted time", and keeps its own status line', () => {
  const now = utc('2026-10-25T23:50:00Z'), eff = effective({ 'secrets-of-the-weald': 105 }), w = eff.find((e) => e.id === 'secrets-of-the-weald');
  const r = build({ events: [w], now, span: '24h' }), cal = read(r.text);
  assert.deepEqual(r.uncertain.map((x) => x.id), ['secrets-of-the-weald'], 'named once, though it has 12 entries');
  assert.deepEqual(cal.events.map((x) => x.start), S.upcoming([w], now, DAY).map((i) => i.start));
  assert.ok(cal.events.every((x) => new Date(x.start).getUTCMinutes() === 45 && new Date(x.start).getUTCHours() % 2 === 1), 'xx:45 on odd UTC hours (offset 105 of 120)');
  assert.notDeepEqual(cal.events.map((x) => x.start), S.upcoming([BY.get('secrets-of-the-weald')], now, DAY).map((i) => i.start), 'not the default times');
  for (const x of cal.events) {
    assert.equal(x.props.SUMMARY, 'GW2: Secrets of the Weald (your adjusted time)');
    assert.equal(x.props.STATUS, 'TENTATIVE');
    assert.ok(x.props.DESCRIPTION.includes('This start is the time you set with Adjust in GW2 Timer, not the default schedule.'));
    assert.ok(x.props.DESCRIPTION.includes('Unverified: sources disagree on this time.'));
  }
});

test('an event marked Recheck says "time may have changed"', () => {
  const now = utc('2026-10-25T23:50:00Z'), e = Object.assign({}, BY.get('the-shatterer'), { status: 'recheck', flag: { patch: '2026-11-10' } });
  const ev = read(build({ events: [e], now, span: 'next' }).text).events[0];
  assert.equal(ev.props.SUMMARY, 'GW2: The Shatterer (time may have changed)');
  assert.ok(ev.props.DESCRIPTION.includes('Recheck: a game update may have changed this time.'));
  assert.equal(ev.props.STATUS, 'TENTATIVE');
});

test('alarms: none by default; 5, 10 or 15 minutes before each start, with its own description', () => {
  const now = utc('2026-10-25T23:50:00Z'), two = [BY.get('tequatl-the-sunless'), BY.get('claw-of-jormag')];
  assert.ok(read(build({ events: two, now, span: '24h' }).text).events.every((x) => x.alarms.length === 0));
  assert.ok(!Ics.build({ events: two, engine: S, now, span: '24h' }).text.includes('VALARM'), 'no alarm when none is asked for');
  for (const m of [5, 10, 15]) {
    const evs = read(build({ events: two, now, span: '24h', alarmMin: m }).text).events;
    for (const x of evs) {
      assert.deepEqual(x.alarms, [{ ACTION: 'DISPLAY', DESCRIPTION: `GW2: ${BY.get(idOf(x)).name} starts in ${m} minutes`, TRIGGER: `-PT${m}M` }]);
    }
  }
});

test('ids are stable: the same start has the same UID in any later file, a different start never does', () => {
  const t = BY.get('tequatl-the-sunless');
  const a = read(build({ events: [t], now: utc('2026-10-25T20:00:00Z'), span: '24h' }).text).events;
  const b = read(build({ events: [t], now: utc('2026-10-25T22:00:00Z'), span: '24h' }).text).events;
  const byStart = new Map(a.map((x) => [x.start, x.props.UID]));
  const shared = b.filter((x) => byStart.has(x.start));
  assert.ok(shared.length >= 4);
  for (const x of shared) assert.equal(x.props.UID, byStart.get(x.start));
  assert.equal(new Set(a.concat(b).map((x) => x.props.UID)).size, new Set(a.concat(b).map((x) => x.start)).size);
  assert.ok(b.every((x) => x.stamp === utc('2026-10-25T22:00:00Z')), 'DTSTAMP is the moment the file was made');
});

test('deterministic: the same choices at the same instant give the same bytes; DTSTAMP drops milliseconds', () => {
  const now = utc('2026-10-25T23:50:00.789Z'), o = { events: effective({ 'depths-of-cruelty': 30 }), now, span: '24h', alarmMin: 10 };
  const a = build(o).text, b = build(o).text;
  assert.equal(a, b);
  assert.ok(a.includes('DTSTAMP:20261025T235000Z\r\n'));
});

test('the golden file: Tequatl, an adjusted Secrets of the Weald and Depths of Cruelty, next start, 10-minute alarm, byte for byte (in every zone)', () => {
  const eff = effective({ 'secrets-of-the-weald': 105 });
  const events = ['tequatl-the-sunless', 'secrets-of-the-weald', 'depths-of-cruelty'].map((id) => eff.find((e) => e.id === id));
  const r = build({ events, now: utc('2026-10-25T23:50:00Z'), span: 'next', alarmMin: 10 });
  // .gitattributes keeps *.ics byte for byte (-text); the CRLF of the output itself is checked by read().
  const golden = readFileSync(join(ROOT, 'tests', 'fixtures', 'calendar-golden.ics'), 'utf8').replace(/\r?\n/g, '\r\n');
  assert.equal(r.text, golden);
  read(r.text);
});

// ---- File names ----

test('file names are lowercase letters, digits and hyphens, and say what is in the file', () => {
  const t = BY.get('tequatl-the-sunless'), c = BY.get('claw-of-jormag');
  assert.equal(Ics.filename({ scope: 'one', span: 'next', events: [t] }), 'gw2-timer-tequatl-the-sunless.ics');
  assert.equal(Ics.filename({ scope: 'one', span: '7d', events: [t] }), 'gw2-timer-tequatl-the-sunless-next-7-days.ics');
  assert.equal(Ics.filename({ scope: 'choose', span: '24h', events: [t] }), 'gw2-timer-tequatl-the-sunless-next-24-hours.ics');
  assert.equal(Ics.filename({ scope: 'choose', span: '3d', events: [t, c] }), 'gw2-timer-2-events-next-3-days.ics');
  assert.equal(Ics.filename({ scope: 'starred', span: 'next', events: [t] }), 'gw2-timer-starred-next-start.ics');
  assert.equal(Ics.filename({ scope: 'starred', span: '30d', events: [t, c] }), 'gw2-timer-starred-next-30-days.ics');
  for (const span of Object.keys(Ics.SPANS)) for (const scope of ['one', 'starred', 'choose']) for (const evs of [[t], [t, c], EVENTS]) {
    assert.match(Ics.filename({ scope, span, events: evs }), /^gw2-timer-[a-z0-9-]+\.ics$/);
  }
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
