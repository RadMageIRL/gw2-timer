// Unit tests, data rules and house checks. Run with `node tests/run.mjs`; no dependencies.
// Reference values come from sources independent of js/schedule.js: start times decoded by separate
// Python code from the wiki's event timer data, the wiki's World boss grid, and the official API.
// The time-zone tests in tests/tz.mjs run at the end, once per zone, as child processes.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const S = require('../js/schedule.js');
const Store = require('../js/store.js');
const News = require('../js/news.js');
const Clock = require('../js/clock.js');
const DATA = require('../events-data.js');
const D = await import('../tools/lib/dataset.mjs');
const { buildEvents } = await import('../tools/build-events.mjs');
const { recordReview, scanText, terms, patchId, feedItems } = await import('../tools/patch-review.mjs');
const { recordEvidence, deltaMinutes } = await import('../tools/verify.mjs');
const { report } = await import('../tools/verification-report.mjs');
const { checkWaypoints } = await import('../tools/check-waypoints.mjs');
const { SITE_FILES } = await import('../tools/build.mjs');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}
const file = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(file(p));
const copy = (v) => JSON.parse(JSON.stringify(v));
const utc = (iso) => Date.parse(iso);
const MIN = 60000, DAY = 86400000;
const EV = new Map(DATA.events.map((e) => [e.id, e]));
const dayStart = utc('2026-10-25T00:00:00Z');
const minutesOfDay = (ms) => Math.round((ms - Math.floor(ms / DAY) * DAY) / MIN);

const SOURCE = json('data/schedule.source.json');
const PATCHES = json('data/patches.json');
const LOCK = json('data/schedule.lock.json');

// ---- Engine against the golden vectors ----

const GOLDEN = json('tests/fixtures/wiki-v5.4-day.json').events;
for (const date of ['2026-10-20', '2026-10-25', '2026-11-01']) {
  test(`every event starts on ${date} at the times decoded from the wiki data (35 events)`, () => {
    const d0 = utc(`${date}T00:00:00Z`);
    let checked = 0;
    for (const e of DATA.events) {
      const starts = S.occurrences(e.schedule, d0, d0 + DAY).filter((s) => s >= d0).map((s) => minutesOfDay(s));
      assert.deepEqual(starts, GOLDEN[e.id].starts, e.id);
      assert.equal(e.schedule.windowMin, GOLDEN[e.id].windowMin, `${e.id} window`);
      checked++;
    }
    assert.equal(checked, 35);
  });
}

test('the 13 core world bosses match the World boss page grid, start for start', () => {
  const grid = json('tests/fixtures/wiki-world-boss-grid.json').bosses;
  const name = { 'inquest-golem-mark-ii': 'Golem Mark II', 'triple-trouble': 'Evolved Jungle Wurm' };
  const core = DATA.events.filter((e) => e.kind === 'world-boss' && e.region === 'core');
  assert.equal(core.length, 13);
  for (const e of core) {
    const hm = S.occurrences(e.schedule, dayStart, dayStart + DAY).filter((s) => s >= dayStart).map((s) => new Date(s).toISOString().slice(11, 16));
    assert.deepEqual(hm, grid[name[e.id] || e.name].slice().sort(), e.id);
  }
});

test('day and night phases start where the wiki data puts them, for all three cycles', () => {
  for (const c of DATA.cycles) {
    for (const p of c.phases) {
      const want = GOLDEN[`cycle:${c.id}`][p.name].map((m) => m % 120);
      assert.ok(want.includes(p.startMin), `${c.id} ${p.name}`);
      assert.equal(S.cyclePhase(c, dayStart + p.startMin * MIN).phase, p.name, `${c.id} ${p.name} at its start`);
    }
  }
});

// ---- Engine behavior ----

test('a window is open from its start up to, not including, its end', () => {
  const teq = EV.get('tequatl-the-sunless').schedule;
  assert.deepEqual(S.currentWindow(teq, utc('2026-10-25T00:00:00Z')), { start: utc('2026-10-25T00:00:00Z'), end: utc('2026-10-25T00:30:00Z') });
  assert.notEqual(S.currentWindow(teq, utc('2026-10-25T00:29:59Z')), null);
  assert.equal(S.currentWindow(teq, utc('2026-10-25T00:30:00Z')), null);
  assert.equal(S.currentWindow(teq, utc('2026-10-24T23:59:59Z')), null);
});

test("a window that crosses midnight UTC is still open after midnight (Dragon's Stand 23:30 to 01:30)", () => {
  const ds = EV.get('dragons-stand').schedule;
  const w = S.currentWindow(ds, utc('2026-10-26T00:05:00Z'));
  assert.deepEqual(w, { start: utc('2026-10-25T23:30:00Z'), end: utc('2026-10-26T01:30:00Z') });
  const before = S.happening([EV.get('dragons-stand')], utc('2026-10-26T01:29:59Z'));
  assert.deepEqual(before.map((i) => i.start), [utc('2026-10-25T23:30:00Z')]);
  // Its window is as long as its period, so at 01:30 the old window has closed and the next one opens.
  const at = S.happening([EV.get('dragons-stand')], utc('2026-10-26T01:30:00Z'));
  assert.deepEqual(at.map((i) => i.start), [utc('2026-10-26T01:30:00Z')]);
});

test('a daily list wraps to the next UTC day after its last start (Karka Queen 23:00, then 02:00)', () => {
  const kq = EV.get('karka-queen').schedule;
  assert.equal(S.nextStart(kq, utc('2026-10-25T23:00:00Z')), utc('2026-10-26T02:00:00Z'));
  assert.equal(S.nextStart(kq, utc('2026-10-25T22:59:59Z')), utc('2026-10-25T23:00:00Z'));
});

test('the next start is strictly after now, even at the exact start instant', () => {
  const sv = EV.get('svanir-shaman-chief').schedule;
  assert.equal(S.nextStart(sv, utc('2026-10-25T00:15:00Z')), utc('2026-10-25T02:15:00Z'));
  assert.equal(S.nextStart(sv, utc('2026-10-25T00:14:59.999Z')), utc('2026-10-25T00:15:00Z'));
});

test('Coming up holds starts after now up to and including the end of the span', () => {
  const now = utc('2026-10-25T00:15:00Z');
  const list = S.upcoming([EV.get('svanir-shaman-chief')], now, 2 * 60 * MIN);
  assert.deepEqual(list.map((i) => i.start), [utc('2026-10-25T02:15:00Z')]);
  assert.equal(S.upcoming([EV.get('svanir-shaman-chief')], now, 2 * 60 * MIN - 1).length, 0);
});

test('Coming up is in time order, ties by name', () => {
  const list = S.upcoming(DATA.events, utc('2026-10-25T23:50:00Z'), 30 * MIN);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].start < list[i].start || (list[i - 1].start === list[i].start && list[i - 1].event.name.localeCompare(list[i].event.name) <= 0));
  }
  assert.deepEqual(list.filter((i) => i.start === utc('2026-10-26T00:00:00Z')).map((i) => i.event.id).sort(),
    ['admiral-taidha-covington', 'defense-of-amnytas', 'kaineng-blackout', 'tequatl-the-sunless']);
});

test('for every event over a week, next start is after now and the open window contains now', () => {
  let t = utc('2026-10-25T00:00:00Z') + 7;
  for (let i = 0; i < 2000; i++, t += 5 * 60000 + 13007) {
    for (const e of DATA.events) {
      const n = S.nextStart(e.schedule, t);
      assert.ok(n > t && n - t <= DAY, `${e.id} next`);
      const w = S.currentWindow(e.schedule, t);
      if (w) assert.ok(w.start <= t && t < w.end, `${e.id} window`);
    }
  }
});

test('Tyria is night at 19:47 UTC and dawn comes at 20:25; Cantha is day at 00:40', () => {
  const tyria = DATA.cycles.find((c) => c.id === 'tyria'), cantha = DATA.cycles.find((c) => c.id === 'cantha');
  const p = S.cyclePhase(tyria, utc('2026-10-25T19:47:00Z'));
  assert.deepEqual([p.phase, p.end, p.next], ['Night', utc('2026-10-25T20:25:00Z'), 'Dawn']);
  assert.equal(S.cyclePhase(tyria, utc('2026-10-25T00:27:00Z')).phase, 'Dawn');
  assert.equal(S.cyclePhase(tyria, utc('2026-10-25T01:40:00Z')).phase, 'Dusk');
  assert.equal(S.cyclePhase(cantha, utc('2026-10-25T00:40:00Z')).phase, 'Day');
  assert.equal(S.cyclePhase(cantha, utc('2026-10-25T00:39:59Z')).phase, 'Dawn');
});

test('the daily reset is the next 00:00 UTC, the day after when it is exactly midnight', () => {
  const daily = DATA.resets.find((r) => r.id === 'daily').rule;
  assert.equal(S.nextReset(daily, utc('2026-10-25T23:59:59Z')), utc('2026-10-26T00:00:00Z'));
  assert.equal(S.nextReset(daily, utc('2026-10-26T00:00:00Z')), utc('2026-10-27T00:00:00Z'));
});

test('the weekly reset is Monday 07:30 UTC', () => {
  const weekly = DATA.resets.find((r) => r.id === 'weekly').rule;
  assert.equal(S.nextReset(weekly, utc('2026-10-25T18:00:00Z')), utc('2026-10-26T07:30:00Z')); // Sunday
  assert.equal(S.nextReset(weekly, utc('2026-10-26T07:29:59Z')), utc('2026-10-26T07:30:00Z'));
  assert.equal(S.nextReset(weekly, utc('2026-10-26T07:30:00Z')), utc('2026-11-02T07:30:00Z'));
  assert.equal(new Date(S.nextReset(weekly, utc('2026-12-31T12:00:00Z'))).getUTCDay(), 1);
});

test('an override replaces only the offset of an adjustable event', () => {
  const sh = EV.get('shackles-of-the-ancients');
  const o = S.applyOverride(sh, 70);
  assert.deepEqual([o.schedule.offsetMin, o.schedule.periodMin, o.schedule.windowMin, o.adjusted], [70, 120, 25, true]);
  assert.equal(sh.schedule.offsetMin, 75);
  const teq = EV.get('tequatl-the-sunless');
  assert.equal(S.applyOverride(teq, 5), teq);
});

test('nudging wraps around the period in both directions', () => {
  assert.equal(S.nudge(0, -5, 120), 115);
  assert.equal(S.nudge(117, 5, 120), 2);
  assert.equal(S.nudge(75, -5, 120), 70);
});

test('rule text names the period, the first start and UTC', () => {
  assert.equal(S.ruleText(EV.get('shackles-of-the-ancients').schedule), 'every 2 h from 01:15 UTC');
  assert.equal(S.ruleText(EV.get('depths-of-cruelty').schedule), 'every 3 h from 02:00 UTC');
  assert.equal(S.ruleText(EV.get('tequatl-the-sunless').schedule), 'daily at 00:00, 03:00, 07:00, 11:30, 16:00, 19:00 UTC');
});

test('durations read as seconds, minutes, hours or days and never go negative', () => {
  assert.deepEqual([0, 59999, 61000, 3600000, 3661000, 2 * DAY + 3 * 3600000, -5000].map(S.duration),
    ['0s', '59s', '1m 01s', '1h 00m', '1h 01m', '2d 3h', '0s']);
});

// ---- The dataset ----

test('the dataset passes every build rule and the generated files are current', () => {
  assert.deepEqual(D.validate(SOURCE, PATCHES, LOCK), []);
  const r = buildEvents({ check: true, log: () => {} });
  assert.ok(r.ok, (r.errors || []).join('\n'));
});

test('the dataset holds 35 events: 15 world bosses and 20 meta-events', () => {
  assert.equal(DATA.events.length, 35);
  assert.equal(DATA.events.filter((e) => e.kind === 'world-boss').length, 15);
  assert.equal(DATA.events.filter((e) => e.kind === 'meta').length, 20);
});

test("the world bosses are exactly the API's daily world boss list", () => {
  const api = json('tests/fixtures/api-worldbosses.json').ids;
  assert.deepEqual(SOURCE.events.filter((e) => e.kind === 'world-boss').map((e) => e.apiId).sort(), api.slice().sort());
});

test('statuses start as 31 documented, 2 disputed, 2 unverified and the four adjustable events are those four', () => {
  const count = (s) => SOURCE.events.filter((e) => e.verification.status === s).length;
  assert.deepEqual([count('documented'), count('disputed'), count('unverified'), count('confirmed'), count('recheck')], [31, 2, 2, 0, 0]);
  assert.deepEqual(DATA.events.filter((e) => e.adjustable).map((e) => e.id).sort(),
    ['depths-of-cruelty', 'nexus-of-eternity', 'secrets-of-the-weald', 'shackles-of-the-ancients']);
  assert.deepEqual(SOURCE.events.filter((e) => e.verification.status === 'disputed').map((e) => e.id).sort(), ['secrets-of-the-weald', 'shackles-of-the-ancients']);
});

test('every waypoint matches the official API: id, name, map and the chat link itself', () => {
  const pois = json('tests/fixtures/api-waypoints.json').pois;
  const idx = new Map(Object.entries(pois).map(([k, v]) => [Number(k), { name: v.name, type: v.type, chat: v.chat_link, map: v.map }]));
  const bad = checkWaypoints(SOURCE, idx).filter((r) => r.problems.length);
  assert.deepEqual(bad, []);
});

test('chat links decode to their waypoint ids and malformed ones are refused', () => {
  assert.equal(D.decodeChat('[&BNABAAA=]'), 464);
  assert.equal(D.decodeChat('[&BKgBAAA=]'), 424);
  for (const bad of ['', 'BNABAAA=', '[&AdsBAAA=]', '[&BNABAAAA]', null]) assert.equal(D.decodeChat(bad), null, String(bad));
});

test('the page data carries no evidence or maintenance internals', () => {
  const text = file('events-data.js');
  for (const word of ['evidence', 'lastReviewedPatch', 'sighting', 'needsInGameCheck', 'qjv']) assert.ok(!text.includes(word), word);
});

// ---- The build rules, each shown failing on a broken copy ----

const errorsAfter = (mutate) => { const s = copy(SOURCE); mutate(s); return D.validate(s, PATCHES, LOCK).join('\n'); };
const ev = (s, id) => s.events.find((e) => e.id === id);

test('documented with only one agreeing source is refused', () => {
  // Secrets of the Weald has one agreeing source (the wiki) and one disagreeing (qjv).
  const out = errorsAfter((s) => { const e = ev(s, 'secrets-of-the-weald'); e.verification.status = 'documented'; e.verification.needsInGameCheck = false; e.adjustable = false; });
  assert.match(out, /event secrets-of-the-weald: documented needs two agreeing sources, has 1/);
});
test('confirmed without an in-game check is refused', () => {
  assert.match(errorsAfter((s) => { ev(s, 'octovine').verification.status = 'confirmed'; }), /confirmed needs an agreeing in-game check/);
});
test('an unverified event that does not need an in-game check is refused', () => {
  assert.match(errorsAfter((s) => { ev(s, 'depths-of-cruelty').verification.needsInGameCheck = false; }), /needsInGameCheck must be true for unverified/);
});
test('adjustable on a documented event is refused', () => {
  assert.match(errorsAfter((s) => { ev(s, 'octovine').adjustable = true; }), /adjustable only on an every schedule/);
});
test('a chat link for another waypoint is refused', () => {
  assert.match(errorsAfter((s) => { ev(s, 'octovine').waypoint.chat = '[&BNABAAA=]'; }), /chat link is waypoint 464/);
});
test('an unsorted daily list is refused', () => {
  assert.match(errorsAfter((s) => { ev(s, 'karka-queen').schedule.startsUtc = [360, 120, 630, 900, 1080, 1380]; }), /sorted/);
});
test('a period that does not divide the day is refused', () => {
  assert.match(errorsAfter((s) => { ev(s, 'octovine').schedule.periodMin = 100; }), /periodMin must divide a day/);
});
test('lastVerifiedOn that is not the newest evidence date is refused', () => {
  assert.match(errorsAfter((s) => { ev(s, 'octovine').verification.lastVerifiedOn = '2026-10-30'; }), /lastVerifiedOn must be the newest evidence date/);
});
test('editing or removing earlier evidence is refused (evidence is append-only)', () => {
  assert.match(errorsAfter((s) => { ev(s, 'octovine').verification.evidence[0].agrees = false; }), /append-only/);
  assert.match(errorsAfter((s) => { ev(s, 'night-and-the-enemy').verification.evidence.shift(); }), /append-only/);
});
test('a schedule edit without new evidence is refused', () => {
  assert.match(errorsAfter((s) => { ev(s, 'octovine').schedule.offsetMin = 65; }), /schedule changed without new supporting evidence/);
});
test('a schedule edit with a new agreeing in-game check is accepted', () => {
  const out = errorsAfter((s) => {
    const e = ev(s, 'octovine');
    e.schedule.offsetMin = 65;
    e.verification.evidence.push({ kind: 'in-game', ref: 'sighting:2026-10-26-octovine-0105', on: '2026-10-26', checked: '2026-10-26', agrees: true });
    e.verification.lastVerifiedOn = '2026-10-26';
    s.meta.verifiedOn = '2026-10-26';
  });
  assert.equal(out, '');
});
test('a schedule edit backed by only one new source is refused, by two is accepted', () => {
  const add = (s, refs) => {
    const e = ev(s, 'octovine');
    e.schedule.offsetMin = 65;
    for (const r of refs) e.verification.evidence.push({ kind: 'source', ref: r, on: '2026-10-26', checked: '2026-10-26', agrees: true });
    e.verification.lastVerifiedOn = '2026-10-26';
    s.meta.verifiedOn = '2026-10-26';
  };
  assert.match(errorsAfter((s) => add(s, ['qjv-8e09f2b6'])), /without new supporting evidence/);
  assert.equal(errorsAfter((s) => add(s, ['qjv-8e09f2b6', 'wiki-widget-v5.4'])), '');
});
test('an event that disappears instead of being retired is refused', () => {
  assert.match(errorsAfter((s) => { s.events = s.events.filter((e) => e.id !== 'octovine'); }), /octovine disappeared/);
});
test('meta.verifiedOn must be the newest evidence date anywhere', () => {
  assert.match(errorsAfter((s) => { s.meta.verifiedOn = '2026-10-24'; }), /meta.verifiedOn must be the newest evidence date/);
});

// ---- Dataset revisions ----

test('the lock is at r1 and matches the data, and nothing needs a revision bump', () => {
  const st = D.revisionState(SOURCE, LOCK);
  assert.deepEqual([LOCK.datasetRevision, st.changed, st.problem], [1, false, null]);
});
test('a schedule edit is a "schedule" revision and needs the bump to r2', () => {
  const s = copy(SOURCE); ev(s, 'octovine').schedule.offsetMin = 65;
  const st = D.revisionState(s, LOCK);
  assert.deepEqual([st.changed, st.kind, st.scheduleChanged], [true, 'schedule', ['event:octovine']]);
  assert.match(st.problem, /bump meta.datasetRevision to 2/);
  s.meta.datasetRevision = 2;
  assert.equal(D.revisionState(s, LOCK).problem, null);
});
test('a status or note change is a "metadata" revision', () => {
  const s = copy(SOURCE); ev(s, 'octovine').note = 'Changed note.';
  const st = D.revisionState(s, LOCK);
  assert.deepEqual([st.changed, st.kind], [true, 'metadata']);
});
test('bookkeeping (review dates, evidence, lastReviewedPatch) does not need a revision', () => {
  const s = copy(SOURCE);
  s.meta.reviewedOn = '2026-11-04';
  ev(s, 'octovine').verification.lastReviewedPatch = '2026-11-03';
  ev(s, 'octovine').verification.evidence.push({ kind: 'source', ref: 'qjv-8e09f2b6', on: '2026-11-01', checked: '2026-11-04', agrees: true });
  assert.equal(D.revisionState(s, LOCK).changed, false);
});
test('raising the revision when nothing players see changed is refused', () => {
  const s = copy(SOURCE); s.meta.datasetRevision = 2;
  assert.match(D.revisionState(s, LOCK).problem, /must stay 1/);
});

// ---- Maintenance tools on copies ----

const scheduleSnapshot = (s) => JSON.stringify(s.events.map((e) => [e.id, e.schedule, e.verification.evidence, e.verification.lastVerifiedOn, e.verification.status]));

test('a patch review with no flags changes no schedule, evidence, verification date or status', () => {
  const s = copy(SOURCE), p = copy(PATCHES);
  const before = scheduleSnapshot(s);
  const r = recordReview(s, p, { id: '2026-11-03', title: 'Game Update Notes: November 3, 2026', url: 'https://en-forum.guildwars2.com/topic/1-test/', date: '2026-11-04' });
  assert.equal(r.result, 'no schedule changes found');
  assert.equal(scheduleSnapshot(s), before);
  assert.ok(s.events.every((e) => e.verification.lastReviewedPatch === '2026-11-03'));
  assert.deepEqual([s.meta.reviewedOn, s.meta.reviewedThroughPatch, s.meta.verifiedOn], ['2026-11-04', '2026-11-03', SOURCE.meta.verifiedOn]);
  assert.deepEqual(D.validate(s, p, LOCK), []);
  assert.equal(D.revisionState(s, LOCK).changed, false);
});

test('a patch review that flags an event sets recheck and keeps its schedule', () => {
  const s = copy(SOURCE), p = copy(PATCHES);
  recordReview(s, p, { id: '2026-11-03', title: 'Game Update Notes: November 3, 2026', url: 'https://en-forum.guildwars2.com/topic/1-test/', flag: ['octovine'], reason: 'Auric Basin meta rework', date: '2026-11-04' });
  const o = ev(s, 'octovine');
  assert.deepEqual([o.verification.status, o.verification.needsInGameCheck, o.verification.flag.previousStatus], ['recheck', true, 'documented']);
  assert.deepEqual(o.schedule, ev(SOURCE, 'octovine').schedule);
  assert.equal(o.verification.lastVerifiedOn, ev(SOURCE, 'octovine').verification.lastVerifiedOn);
  assert.deepEqual(D.validate(s, p, LOCK), []);
  assert.equal(D.revisionState(s, LOCK).kind, 'metadata');
});

test('a review cannot be recorded twice or flag an unknown event', () => {
  assert.throws(() => recordReview(copy(SOURCE), copy(PATCHES), { id: '2026-10-13', title: 'x', url: 'https://x/' }), /already recorded/);
  assert.throws(() => recordReview(copy(SOURCE), copy(PATCHES), { id: '2026-11-03', title: 'x', url: 'https://x/', flag: ['nope'], reason: 'r' }), /unknown event/);
});

test('an agreeing in-game sighting confirms an event and removes its override', () => {
  const s = copy(SOURCE);
  const r = recordEvidence(s, { id: 'shackles-of-the-ancients', method: 'in-game', seen: '2026-10-26T21:16:00Z', date: '2026-10-26', sightingsDir: null });
  const e = ev(s, 'shackles-of-the-ancients');
  assert.deepEqual([r.agrees, e.verification.status, e.verification.needsInGameCheck, e.adjustable], [true, 'confirmed', false, false]);
  assert.deepEqual(e.schedule, ev(SOURCE, 'shackles-of-the-ancients').schedule);
  assert.deepEqual([e.verification.lastVerifiedOn, s.meta.verifiedOn], ['2026-10-26', '2026-10-26']);
  assert.deepEqual(D.validate(s, PATCHES, LOCK), []);
});

test('a disagreeing sighting marks the event disputed, implies a schedule, and does not change it', () => {
  const s = copy(SOURCE);
  const r = recordEvidence(s, { id: 'depths-of-cruelty', method: 'in-game', seen: '2026-10-26T20:10:00Z', date: '2026-10-26', sightingsDir: null });
  const e = ev(s, 'depths-of-cruelty');
  // Seen 10 minutes after the 20:00 start: 20:10 is 130 minutes into the 18:00 three-hour cycle.
  assert.deepEqual([r.agrees, e.verification.status, r.implied.offsetMin], [false, 'disputed', 130]);
  assert.deepEqual(e.schedule, ev(SOURCE, 'depths-of-cruelty').schedule);
  assert.deepEqual(D.validate(s, PATCHES, LOCK), []);
});

test('a sighting within two minutes agrees; three minutes off disagrees', () => {
  const sch = EV.get('octovine').schedule; // every 2 h from 01:00
  assert.deepEqual(['2026-10-26T01:02:00Z', '2026-10-26T00:58:00Z', '2026-10-26T01:03:00Z', '2026-10-26T00:57:00Z', '2026-10-26T01:40:00Z'].map((t) => deltaMinutes(sch, utc(t))),
    [2, -2, 3, -3, 40]);
});

test('a sighting 2 minutes off is recorded as agreeing, 3 minutes off as disagreeing', () => {
  const two = copy(SOURCE), three = copy(SOURCE);
  assert.equal(recordEvidence(two, { id: 'octovine', method: 'in-game', seen: '2026-10-26T01:02:00Z', date: '2026-10-26', sightingsDir: null }).agrees, true);
  assert.equal(recordEvidence(three, { id: 'octovine', method: 'in-game', seen: '2026-10-26T01:03:00Z', date: '2026-10-26', sightingsDir: null }).agrees, false);
  assert.deepEqual([ev(two, 'octovine').verification.status, ev(three, 'octovine').verification.status], ['confirmed', 'disputed']);
});

test('a recheck clears to documented only after two agreeing sources dated after the flag', () => {
  const s = copy(SOURCE), p = copy(PATCHES);
  recordReview(s, p, { id: '2026-11-03', title: 'Game Update Notes: November 3, 2026', url: 'https://en-forum.guildwars2.com/topic/1-test/', flag: ['octovine'], reason: 'r', date: '2026-11-04' });
  recordEvidence(s, { id: 'octovine', method: 'sources', ref: 'qjv-8e09f2b6', on: '2026-11-05', agrees: 'yes', date: '2026-11-05' });
  assert.equal(ev(s, 'octovine').verification.status, 'recheck');
  recordEvidence(s, { id: 'octovine', method: 'sources', ref: 'wiki-widget-v5.4', on: '2026-11-05', agrees: 'yes', date: '2026-11-05' });
  assert.equal(ev(s, 'octovine').verification.status, 'documented');
  assert.deepEqual(D.validate(s, p, LOCK), []);
});

test('the scan finds event names, map names and schedule words, and lists unknown new metas', () => {
  const t = terms(SOURCE);
  const known = SOURCE.events.flatMap((e) => [e.name.toLowerCase(), e.map.toLowerCase()]);
  const text = 'Fixed a bug in the Depths of Cruelty meta-event.\nThe Octovine now starts five minutes earlier.\nA new map, Glimmering Reach, brings the Starfall meta-event.\nReduced the cooldown of a sword skill.';
  const { hits, newContent } = scanText(text, t, known);
  assert.deepEqual(hits.map((h) => h.n), [1, 2, 3]);
  assert.ok(hits[0].ids.includes('depths-of-cruelty'));
  assert.ok(hits[1].ids.includes('octovine') && hits[1].terms.includes('minutes earlier'));
  assert.deepEqual(newContent.map((c) => c.n), [3]);
});

test('patch ids come from the date in the notes title', () => {
  assert.equal(patchId('Game Update Notes: October 13, 2026'), '2026-10-13');
  assert.equal(patchId('Game Update Notes: September 9, 2025'), '2025-09-09');
  assert.equal(patchId('Wikis are down for maintenance'), null);
});

test('feed items are read from RSS with their text and dates', () => {
  const items = feedItems(file('tests/fixtures/news-feed.xml'));
  assert.equal(items.length, 9);
  assert.equal(items[0].pubMs, utc('2026-10-13T16:06:21Z'));
});

test('the report keeps the patch review date and the verification date apart and lists each status', () => {
  const r = report(SOURCE, PATCHES, LOCK, '0.1.0', '2026-10-25');
  assert.match(r, /Latest patch review: 2026-10-13 .*reviewed 2026-10-25/);
  assert.match(r, /Last direct or independently sourced verification: 2026-10-25/);
  assert.match(r, /Last in-game verification: none yet/);
  assert.match(r, /## Disputed \(sources disagree\): 2/);
  assert.match(r, /## Unverified: 2/);
  assert.match(r, /## Documented .*: 31/);
  assert.match(r, /r1 \(2026-10-25\): first dataset/);
  assert.match(r, /A patch review that does not mention an event is not a verification of it/);
});

// ---- Saved settings ----

test('saved preferences that are garbage fall back to the defaults', () => {
  const ids = DATA.events.map((e) => e.id), regions = DATA.regions.map((r) => r.id);
  for (const raw of [null, 'x', 42, [], { filter: 'evil', aheadMin: 7, theme: 'neon', regions: 'core' }]) {
    const p = Store.sanitizePrefs(raw, ids, regions);
    assert.deepEqual([p.filter, p.aheadMin, p.theme, p.regions.length, p.starred.length], ['all', 120, 'dark', 8, 0], JSON.stringify(raw));
  }
});
test('saved stars and hidden events keep only ids the dataset knows, once each', () => {
  const p = Store.sanitizePrefs({ starred: ['octovine', 'octovine', 'gone', 5], hidden: ['drakkar', null] }, DATA.events.map((e) => e.id), DATA.regions.map((r) => r.id));
  assert.deepEqual([p.starred, p.hidden], [['octovine'], ['drakkar']]);
});
test('saved overrides are kept only for adjustable events with an offset inside the period', () => {
  const o = Store.sanitizeOverrides({
    'shackles-of-the-ancients': { offsetMin: 70, setAt: 1 }, 'depths-of-cruelty': { offsetMin: 180 },
    'nexus-of-eternity': { offsetMin: 1.5 }, octovine: { offsetMin: 10 }, 'secrets-of-the-weald': { offsetMin: 105 },
  }, DATA.events);
  assert.deepEqual(Object.keys(o).sort(), ['secrets-of-the-weald', 'shackles-of-the-ancients']);
});

// ---- News ----

test('the feed parser keeps five guildwars2.com https links as plain text, without tracking parameters', () => {
  const items = News.parseFeed(file('tests/fixtures/news-feed.xml'));
  assert.deepEqual(items.map((i) => i.title), ['First Test Post - Plain & Simple', 'Second Post with “Quotes”alert(1)', 'No date still shows', 'Fourth Kept Post', 'Fifth Kept Post']);
  assert.deepEqual(items.slice(0, 2).map((i) => i.link), ['https://www.guildwars2.com/en/news/first-test-post/', 'https://www.guildwars2.com/en/news/second-post/?keep=1']);
  assert.equal(items[2].dateMs, null);
  assert.ok(items.every((i) => !/[<>]/.test(i.title)));
});
test('links to other sites, other schemes or plain http are refused', () => {
  for (const l of ['https://example.com/', 'javascript:alert(1)', 'http://www.guildwars2.com/x', 'https://www.guildwars2.com.evil.com/x', 'not a url']) assert.equal(News.cleanLink(l), null, l);
});
test('a cached copy is fresh for 30 minutes and is re-checked when read back', () => {
  const now = utc('2026-10-25T12:00:00Z');
  assert.equal(News.isFresh({ fetchedAt: now - 29 * MIN, items: [] }, now), true);
  assert.equal(News.isFresh({ fetchedAt: now - 31 * MIN, items: [] }, now), false);
  assert.equal(News.isFresh({ fetchedAt: now + MIN, items: [] }, now), false);
  assert.equal(News.sanitizeCache({ fetchedAt: now, items: [{ title: 'x', link: 'https://example.com/' }] }), null);
  assert.equal(News.sanitizeCache({ fetchedAt: now, items: [{ title: 'x', link: 'https://www.guildwars2.com/en/news/x/' }] }).items.length, 1);
});

// ---- Clock check (D4 Tracker's rules) ----

const sample = (sentMs, date, age = null, rt = 100) => ({ sentMs, receivedMs: sentMs + rt, date: new Date(date).toUTCString(), age });
test('a live Date header that is 90 s ahead corrects the clock by about 90 s', () => {
  const t = utc('2026-10-25T12:00:00.000Z');
  const est = Clock.estimateClock([sample(t, t + 90000), sample(t + 5000, t + 95000)]);
  assert.ok(est.applied && Math.abs(est.offsetMs - 89950) <= 1100, JSON.stringify(est));
});
test('a frozen Date header with no Age is ignored, and an offset under 1.5 s is measured but not applied', () => {
  const t = utc('2026-10-25T12:00:00.000Z');
  assert.equal(Clock.estimateClock([sample(t, t + 90000), sample(t + 5000, t + 90000)]), null);
  const small = Clock.estimateClock([sample(t, t + 1000), sample(t + 5000, t + 6000)]);
  assert.ok(small.measuredMs >= 900 && small.measuredMs <= 1000 && small.applied === false && small.offsetMs === 0, JSON.stringify(small));
});
test('readings too close together or with slow round trips are not trusted', () => {
  const t = utc('2026-10-25T12:00:00.000Z');
  assert.equal(Clock.estimateClock([sample(t, t + 90000), sample(t + 1000, t + 91000)]), null);
  assert.equal(Clock.estimateClock([sample(t, t + 90000, null, 2000), sample(t + 5000, t + 95000, null, 2000)]), null);
});
test('a wall clock that jumps or a long pause asks for a new clock check', () => {
  assert.equal(Clock.detectResume(0, 0, 1000, 1000), null);
  assert.equal(Clock.detectResume(0, 0, 10000, 1000), 'clock-jump');
  assert.equal(Clock.detectResume(0, 0, 6 * 60000, 6 * 60000), 'long-gap');
});

// ---- House checks ----

const html = file('index.html');
const VERSION = /^## v(\d+\.\d+\.\d+) /m.exec(file('CHANGELOG.md'))[1];
test(`the page, About, README and every asset say v${VERSION}, the newest version in the changelog`, () => {
  assert.ok(html.includes(`<title>GW2 Timer v${VERSION} - World Bosses, Meta Events &amp; More | Unofficial fansite | RadMage Labs</title>`));
  assert.ok(html.includes(`<span class="tag">v${VERSION} · World Bosses, Meta Events &amp; More · `));
  assert.ok(html.includes(`<h2 id="about-title">GW2 Timer v${VERSION}</h2>`));
  assert.match(file('README.md'), new RegExp(`^# GW2 Timer v${VERSION.replace(/\./g, '\\.')}\\n`));
  const assets = [...html.matchAll(/(?:src|href)="((?:js\/[^"]+\.js|style\.css)[^"]*)"/g)].map((m) => m[1]);
  assert.equal(assets.length, 7);
  for (const a of assets) assert.ok(a.endsWith(`?v=${VERSION}`), a);
});
test('the page loads the schedule data with ?r= set to the dataset revision', () => {
  assert.ok(html.includes(`<script src="events-data.js?r=${DATA.meta.datasetRevision}"></script>`));
});
test('the changelog lists the current dataset revision with its kind', () => {
  const last = LOCK.history[LOCK.history.length - 1];
  const label = { initial: 'first dataset', schedule: 'schedule change', metadata: 'metadata only' }[last.kind];
  assert.match(file('CHANGELOG.md'), new RegExp(`^- r${last.revision} \\(${last.date}\\), ${label}:`, 'm'));
});
test('the title bar says Unofficial fansite and the ArenaNet notice appears verbatim in page, About, README and NOTICE', () => {
  const notice = 'Guild Wars Games © ArenaNet LLC. All rights reserved. NCSOFT, ArenaNet, Guild Wars, Guild Wars 2, GW2, Heart of Thorns, Path of Fire, End of Dragons, Secrets of the Obscure, Janthir Wilds, Visions of Eternity, and all associated logos, designs, and composite marks are trademarks or registered trademarks of NCSOFT Corporation. All other trademarks are the property of their respective owners.';
  assert.match(html, /<title>[^<]*Unofficial fansite[^<]*<\/title>/);
  assert.equal(html.split(notice).length - 1, 2);
  assert.ok(file('README.md').includes(notice));
  assert.ok(file('NOTICE').includes(notice));
});
test('the CSP allows scripts and styles from this site only, and connections to this site and guildwars2.com', () => {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  assert.equal(csp, "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://www.guildwars2.com; base-uri 'none'; form-action 'none'");
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1].trim());
  assert.deepEqual(inline, ['type="application/ld+json"']);
  assert.ok(!/\sstyle="/.test(html) && !/\son[a-z]+="/.test(html), 'no inline style or handler attributes');
});
test('the only network calls in the code are the news feed and the same-origin clock check', () => {
  const calls = [];
  for (const f of readdirSync(join(ROOT, 'js'))) {
    const src = file(`js/${f}`);
    for (const m of src.matchAll(/\bfetch\(([^,)]+)/g)) calls.push(`${f}: ${m[1].trim()}`);
    assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource|import\(/.test(src), f);
    const urls = [...src.matchAll(/https?:\/\/[a-z0-9.-]+/gi)].map((m) => m[0]);
    for (const u of urls) assert.ok(['https://www.guildwars2.com', 'https://wiki.guildwars2.com'].includes(u), `${f}: ${u}`);
  }
  assert.deepEqual(calls.sort(), ['app.js: News.FEED_URL', 'app.js: url']);
});
test('no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval in the page code', () => {
  for (const f of readdirSync(join(ROOT, 'js'))) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(file(`js/${f}`)), f);
});

// Every project file that is ours (not local research, not build output).
function projectFiles(dir = ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (['.git', 'local', 'dist', 'node_modules'].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) projectFiles(p, out);
    else if (!/\.(png|ico)$/.test(name)) out.push(p);
  }
  return out;
}
test('no em dashes in any project file', () => {
  const EM_DASH = String.fromCharCode(0x2014);
  const bad = projectFiles().filter((p) => readFileSync(p, 'utf8').includes(EM_DASH)).map((p) => relative(ROOT, p));
  assert.deepEqual(bad, []);
});
test('the project has no package.json and no dependencies', () => {
  assert.equal(existsSync(join(ROOT, 'package.json')), false);
  assert.equal(existsSync(join(ROOT, 'node_modules')), false);
});
test('every site file exists and README links point at real files', () => {
  for (const f of SITE_FILES) assert.ok(existsSync(join(ROOT, f)), f);
  for (const m of file('README.md').matchAll(/\]\(((?!https?:)[^)#]+)\)/g)) assert.ok(existsSync(join(ROOT, m[1])), m[1]);
});
test('README counts match the data: 15 world bosses, 20 meta-events, the four adjustable events', () => {
  const readme = file('README.md');
  assert.ok(readme.includes('**15 world bosses**') && readme.includes('**20 meta-events**'));
  for (const e of DATA.events.filter((x) => x.adjustable)) assert.ok(readme.includes(e.name), e.name);
});

// ---- Time zones: tests/tz.mjs once per zone ----

for (const tz of ['America/Chicago', 'Europe/London', 'Asia/Kolkata', 'Australia/Lord_Howe', 'UTC']) {
  test(`time-zone checks pass in ${tz}`, () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'tests', 'tz.mjs')], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
