// Tests for js/reminders.js. Run alone with `node tests/reminders.mjs`, or through tests/run.mjs, which
// runs it once per time zone (TZ in the environment): every rule here compares UTC instants, so the
// results must be the same everywhere.
//
// The cases follow V0.3.0_REMINDERS_ALGORITHM.md section 9 (local): T timing, S same occurrence,
// J Adjust, C time jumps and the clock, P properties. The "tab" below is the smallest page wiring
// that the module allows, so the tests exercise the module the way the page will.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const R = require('../js/reminders.js');
const S = require('../js/schedule.js');
const DATA = require('../events-data.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = DATA.events, IDS = EVENTS.map((e) => e.id);
const MIN = 60000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const utc = (iso) => Date.parse(iso);
const ev = (id) => EVENTS.find((e) => e.id === id);
const mod = (a, n) => ((a % n) + n) % n;
const tz = process.env.TZ || 'default zone';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.error(`FAIL [${tz}] ${name}\n  ${String(e.stack || e.message).split('\n').slice(0, 8).join('\n  ')}`); }
}

// ---- A storage shared by tabs, and tabs ----

function makeWorld() {
  const w = { value: undefined, readFails: false, writeFails: false, writes: 0, lockNames: [] };
  w.read = () => { if (w.readFails) throw new Error('storage blocked'); return w.value === undefined ? null : JSON.parse(w.value); };
  w.write = (o) => { if (w.writeFails) return false; w.value = JSON.stringify(o); w.writes++; return true; };
  w.locks = { request: async (name, fn) => { w.lockNames.push(name); return fn(); } };
  w.wait = () => Promise.resolve();
  return w;
}

function makeTab(world, name, { locks = true } = {}) {
  const tab = { name, mem: {}, live: [], shown: [], alerts: [], read: world.read, write: world.write, locks: locks ? world.locks : undefined };
  tab.reload = () => { tab.mem = {}; tab.live = []; tab.shown = []; };
  tab.dismiss = (id) => { tab.live = R.dismiss(tab.live, [id]); };
  /** One tick of the page: bring notices up to date, deliver what is due and not covered, say what is shown. */
  tab.tick = async (st, now) => {
    const ctx = { events: EVENTS, engine: S, now, starred: st.starred, hidden: st.hidden, settings: st.settings, overrides: st.overrides };
    tab.live = R.follow({ live: tab.live, ...ctx }).live;
    let stored = {};
    try { stored = R.prune(tab.read(), IDS, now); } catch (e) { stored = {}; }
    const { alert } = R.decide(R.due(ctx), R.merge(stored, tab.mem));
    const won = [];
    for (const item of alert) {
      const r = await R.claim({ item, now, by: name, mem: tab.mem, read: tab.read, write: tab.write, locks: tab.locks, wait: world.wait, eventIds: IDS });
      if (!r.won) continue;
      tab.live = R.open(tab.live, item);
      won.push(item);
      tab.alerts.push({ id: item.id, start: item.start, lead: item.lead, at: now });
    }
    tab.shown = R.follow({ live: tab.live, ...ctx }).shown;
    return won;
  };
  return tab;
}

const state = (over = {}) => Object.assign({ starred: ['shackles-of-the-ancients'], hidden: [], settings: { on: true, lead: 10, notify: false }, overrides: {} }, over);

// "Shackles" is adjustable and starts every 120 minutes. T0 is one of its starts; at(n) is n minutes from it,
// so at(-10) is the reminder time with a 10 minute lead. The matrix calls T0 "7:00".
const SH = ev('shackles-of-the-ancients');
const T0 = S.nextStart(SH.schedule, utc('2026-11-20T12:00:00Z'));
const at = (minutes) => T0 + minutes * MIN;
/** The Adjust setting that moves Shackles' starts by delta minutes from the dataset's. */
const moved = (delta) => ({ [SH.id]: { offsetMin: mod(SH.schedule.offsetMin + delta, SH.schedule.periodMin), setAt: 0 } });
const ids = (items) => items.map((i) => i.id);

// ---- The module itself ----

await test('the module needs nothing from a page: it loads with no window, document, storage or timers, and sets one global', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'reminders.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['GW2Reminders']);
  // The code, without its comments, names nothing of the page, the clock or the network.
  const src = readFileSync(join(ROOT, 'js', 'reminders.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const word of ['localStorage', 'document', 'window', 'navigator', 'Date.now', 'new Date', 'setTimeout', 'setInterval', 'Notification', 'serviceWorker', 'fetch(']) assert.ok(!src.includes(word), word);
});

await test('settings: off by default, lead 10, and junk falls back to the defaults', () => {
  assert.deepEqual(R.defaults(), { on: false, lead: 10, notify: false });
  assert.deepEqual(R.LEADS, [5, 10, 15]);
  assert.equal(R.MAX_LEAD, Math.max(...R.LEADS));
  for (const junk of [null, undefined, [], 'on', 7, { on: 'yes' }, { on: 1, lead: 7 }, { lead: '10' }, { lead: 60 }, { notify: 'true' }]) assert.deepEqual(R.sanitize(junk), R.defaults(), JSON.stringify(junk));
  assert.deepEqual(R.sanitize({ on: true, lead: 5, notify: true, extra: 1 }), { on: true, lead: 5, notify: true });
  assert.deepEqual(R.sanitize({ on: true, lead: 15 }), { on: true, lead: 15, notify: false });
  assert.deepEqual(R.sanitize(JSON.parse('{"on":true,"lead":10,"__proto__":{"notify":true}}')), { on: true, lead: 10, notify: false });
});

await test('the data keeps its promise: the shortest gap between two starts of an event is at least the longest lead', () => {
  assert.equal(R.shortestGap(EVENTS), 120);
  assert.ok(R.shortestGap(EVENTS) >= R.MAX_LEAD);
  assert.equal(R.shortestGap([{ schedule: { type: 'every', periodMin: 60, offsetMin: 0 } }, { schedule: { type: 'daily', startsUtc: [10, 400, 1430] } }]), 20); // 23:50 to 00:10 across midnight
  assert.equal(R.shortestGap([{ schedule: { type: 'daily', startsUtc: [0, 45, 600] } }]), 45);
  assert.equal(R.shortestGap([]), Infinity);
});

// ---- T: timing and eligibility ----

await test('T1 to T4: due from the reminder time, inclusive, to the start, exclusive', () => {
  const dueAt = (now, lead = 10) => R.due({ events: EVENTS, engine: S, now, ...state({ settings: { on: true, lead } }) });
  assert.deepEqual(dueAt(at(-10) - 1), []);
  assert.deepEqual(dueAt(at(-10)).map((i) => [i.id, i.start, i.lead, i.adjusted]), [[SH.id, T0, 10, false]]);
  assert.deepEqual(ids(dueAt(at(0) - 1)), [SH.id]);
  assert.deepEqual(dueAt(at(0)), []);          // at the start: the next start is two hours away
  assert.deepEqual(dueAt(at(1)), []);
  assert.deepEqual(ids(dueAt(at(-5), 5)), [SH.id]);
  assert.deepEqual(dueAt(at(-5) - 1, 5), []);
  assert.deepEqual(ids(dueAt(at(-15), 15)), [SH.id]);
  assert.deepEqual(dueAt(at(-15) - 1, 15), []);
});

await test('T5: over a full UTC day, for each lead, every start of every event is announced exactly once, before it starts and within the lead', () => {
  const day = utc('2026-11-20T00:00:00Z');
  for (const lead of R.LEADS) {
    const st = state({ starred: IDS, settings: { on: true, lead } });
    let rec = {};
    const got = [];
    for (let now = day; now <= day + DAY; now += 20000) {
      const { alert } = R.decide(R.due({ events: EVENTS, engine: S, now, ...st }), rec);
      for (const it of alert) {
        assert.ok(it.start - now > 0 && it.start - now <= lead * MIN, `${it.id} ${it.start - now}`);
        got.push(`${it.start} ${it.id}`);
        rec = R.announce(rec, it, now, 'a');
      }
    }
    const want = EVENTS.flatMap((e) => S.occurrences(e.schedule, day, day + DAY + lead * MIN + 1).filter((s) => s > day && s - lead * MIN <= day + DAY).map((s) => `${s} ${e.id}`));
    assert.deepEqual(got.slice().sort(), want.sort(), `lead ${lead}`);
    assert.equal(new Set(got).size, got.length);
  }
});

await test('T6: nothing is due when reminders are off, for an event that is not starred, or for one that is hidden', () => {
  const base = { events: EVENTS, engine: S, now: at(-5) };
  assert.deepEqual(R.due({ ...base, ...state({ settings: { on: false, lead: 10 } }) }), []);
  assert.deepEqual(R.due({ ...base, ...state({ settings: undefined }) }), []);
  assert.deepEqual(R.due({ ...base, ...state({ starred: [] }) }), []);
  assert.deepEqual(R.due({ ...base, ...state({ starred: undefined }) }), []);
  assert.deepEqual(R.due({ ...base, ...state({ hidden: [SH.id] }) }), []);
  assert.deepEqual(ids(R.due({ ...base, ...state({ hidden: ['drakkar'] }) })), [SH.id]);
  assert.deepEqual(R.due({ ...base, ...state({ starred: ['not-an-event'] }) }), []);
});

await test('T7: the view (filter, regions, span, search) is not an input: only stars and the Hidden list decide', () => {
  const got = R.due({ events: EVENTS, engine: S, now: at(-5), ...state(), filter: 'world-boss', regions: [], aheadMin: 60, query: 'zzzz' });
  assert.deepEqual(ids(got), [SH.id]);
});

await test('T8 and T9: a 00:00 UTC start is due from 23:50 UTC the day before, and on daylight-saving days the instants are the same in every zone', () => {
  const st = state({ starred: ['tequatl-the-sunless'] });
  for (const day of ['2026-11-20', '2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01', '2026-04-05', '2026-10-04']) {
    const midnight = utc(`${day}T00:00:00Z`);
    assert.deepEqual(R.due({ events: EVENTS, engine: S, now: midnight - 10 * MIN - 1, ...st }), [], day);
    const d = R.due({ events: EVENTS, engine: S, now: midnight - 10 * MIN, ...st });
    assert.deepEqual(d.map((i) => new Date(i.start).toISOString()), [`${day}T00:00:00.000Z`], day);
  }
  // 07:00 UTC on the US change day (1:00 AM twice over in Chicago): one instant, one reminder.
  const d = R.due({ events: EVENTS, engine: S, now: utc('2026-11-01T06:50:00Z'), ...st });
  assert.deepEqual(d.map((i) => i.start), [utc('2026-11-01T07:00:00Z')]);
});

await test('due items come soonest first, then by name, and carry the adjusted event', () => {
  const now = utc('2026-11-20T00:50:00Z');
  const d = R.due({ events: EVENTS, engine: S, now, ...state({ starred: IDS, settings: { on: true, lead: 15 } }) });
  assert.ok(d.length > 1);
  for (let i = 1; i < d.length; i++) assert.ok(d[i - 1].start < d[i].start || (d[i - 1].start === d[i].start && d[i - 1].event.name.localeCompare(d[i].event.name, 'en') <= 0));
  const adj = R.due({ events: EVENTS, engine: S, now: at(-8), ...state({ overrides: moved(2) }) });
  assert.deepEqual(adj.map((i) => [i.start, i.adjusted, i.event.adjusted, i.event.schedule.offsetMin]), [[at(2), true, true, mod(SH.schedule.offsetMin + 2, 120)]]);
  // An override for an event that is not adjustable changes nothing (the engine refuses it).
  const teq = R.due({ events: EVENTS, engine: S, now: utc('2026-11-20T02:55:00Z'), ...state({ starred: ['tequatl-the-sunless'], overrides: { 'tequatl-the-sunless': { offsetMin: 30, setAt: 0 } } }) });
  assert.deepEqual(teq.map((i) => [i.start, i.adjusted]), [[utc('2026-11-20T03:00:00Z'), false]]);
});

// ---- Coverage, the heart of it ----

await test('covered: a start is covered exactly when its reminder time is before a start already announced', () => {
  const rec = { start: T0, at: at(-10), by: 'a' };
  assert.equal(R.covered(undefined, T0, 10), false);
  assert.equal(R.covered(null, T0, 10), false);
  assert.equal(R.covered(rec, T0, 10), true);                 // the same start
  assert.equal(R.covered(rec, at(9), 10), true);              // 9 minutes later: reminder time 1 minute before the announced start
  assert.equal(R.covered(rec, at(10) - 1, 10), true);
  assert.equal(R.covered(rec, at(10), 10), false);            // the lead later: reminder time is the announced start itself
  assert.equal(R.covered(rec, at(120), 10), false);           // the next occurrence
  assert.equal(R.covered(rec, at(-3), 10), true);             // earlier
  assert.equal(R.covered(rec, at(-120), 10), true);           // much earlier
  assert.equal(R.covered(rec, at(14), 15), true);             // the threshold follows the lead
  assert.equal(R.covered(rec, at(15), 15), false);
  assert.equal(R.covered(rec, at(4), 5), true);
  assert.equal(R.covered(rec, at(5), 5), false);
});

await test('announce keeps one record per event, and a later start replaces an earlier one, never the reverse', () => {
  let rec = R.announce({}, { id: 'a', start: 1000 }, 900, 'tab');
  assert.deepEqual(rec, { a: { start: 1000, at: 900, by: 'tab' } });
  const same = R.announce(rec, { id: 'a', start: 1000 }, 950, 'other');
  assert.deepEqual(same, rec);
  assert.deepEqual(R.announce(rec, { id: 'a', start: 500 }, 950, 'other'), rec);
  assert.deepEqual(R.announce(rec, { id: 'a', start: 2000 }, 1900, 'other').a, { start: 2000, at: 1900, by: 'other' });
  assert.deepEqual(Object.keys(R.announce(rec, { id: 'b', start: 5 }, 1)), ['a', 'b']);
  assert.deepEqual(R.announce(rec, { id: 'b', start: 5 }, 1).b.by, '');
  assert.deepEqual(rec, { a: { start: 1000, at: 900, by: 'tab' } }); // the argument is not changed
  assert.deepEqual(R.merge({ a: { start: 1 }, b: { start: 9 } }, { a: { start: 5 }, c: { start: 2 } }), { a: { start: 5 }, b: { start: 9 }, c: { start: 2 } });
  assert.deepEqual(R.merge({ a: { start: 5 } }, { a: { start: 1 } }), { a: { start: 5 } });
  assert.deepEqual(R.merge({ a: { start: 5 } }, undefined), { a: { start: 5 } });
});

await test('prune keeps only sound records of known events whose start is within a day of now', () => {
  const now = at(0), ok = { start: at(5), at: at(-5), by: 'tab' };
  const raw = {
    [SH.id]: ok,
    drakkar: { start: now - DAY, at: 1, by: 'x' },                 // exactly a day old: kept
    octovine: { start: now - DAY - 1, at: 1 },                      // older: dropped
    'karka-queen': { start: now + DAY, at: 1 },                     // exactly a day ahead: kept
    'claw-of-jormag': { start: now + DAY + 1, at: 1 },              // further ahead: damage
    megadestroyer: { start: '1', at: 1 },
    'fire-elemental': { start: at(1) },
    'the-shatterer': { start: NaN, at: 1 },
    'shadow-behemoth': { start: Infinity, at: 1 },
    'modniir-ulgoth': null,
    'great-jungle-wurm': [at(1), 1],
    'triple-trouble': { start: at(1), at: 1, by: 42 },              // kept, with the odd tab id dropped
    'chak-gerent': { start: at(1), at: 1, by: 'x'.repeat(65) },
    'not-an-event': ok, __proto__: ok, constructor: ok,
  };
  assert.deepEqual(R.prune(raw, IDS, now), {
    [SH.id]: ok, drakkar: { start: now - DAY, at: 1, by: 'x' }, 'karka-queen': { start: now + DAY, at: 1, by: '' },
    'triple-trouble': { start: at(1), at: 1, by: '' }, 'chak-gerent': { start: at(1), at: 1, by: '' },
  });
  for (const junk of [null, undefined, 'x', 7, [], [ok], true]) assert.deepEqual(R.prune(junk, IDS, now), {});
  assert.deepEqual(R.prune(raw, [], now), {});
  assert.deepEqual(R.prune(raw, undefined, now), {});
  assert.deepEqual(R.prune(JSON.parse(`{"__proto__":{"${SH.id}":{"start":${at(1)},"at":1}}}`), IDS, now), {});
  // A record never survives as the same object: what is kept is rebuilt from the three known fields.
  assert.notEqual(R.prune(raw, IDS, now)[SH.id], ok);
  assert.deepEqual(Object.keys(R.prune({ [SH.id]: { start: at(1), at: 1, by: 'a', extra: 'x' } }, IDS, now)[SH.id]), ['start', 'at', 'by']);
});

await test('decide splits what is due into what alerts and what was already announced', () => {
  const items = [{ id: 'a', start: 1000 * MIN, lead: 10 }, { id: 'b', start: 1000 * MIN, lead: 10 }, { id: 'c', start: 1000 * MIN, lead: 10 }];
  const rec = { a: { start: 1000 * MIN }, b: { start: 990 * MIN }, c: { start: 990 * MIN + 1 } };
  const d = R.decide(items, rec);
  assert.deepEqual([ids(d.alert), ids(d.quiet)], [['b'], ['a', 'c']]);
  assert.deepEqual(ids(R.decide(items, undefined).alert), ['a', 'b', 'c']);
  assert.deepEqual(R.decide([], rec), { alert: [], quiet: [] });
});

// ---- S: the same occurrence ----

await test('S1: a reload inside the lead time does not alert again, and the tray starts empty', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a'), st = state();
  assert.deepEqual(ids(await tab.tick(st, at(-10))), [SH.id]);
  assert.deepEqual(ids(tab.shown), [SH.id]);
  tab.reload();
  assert.deepEqual(await tab.tick(st, at(-5)), []);
  assert.deepEqual(tab.shown, []);
  const fresh = makeTab(w, 'b'); // the browser restarted: a new tab on the same storage
  assert.deepEqual(await fresh.tick(st, at(-1)), []);
  assert.equal(tab.alerts.length + fresh.alerts.length, 1);
});

await test('S2: two tabs ticking at the same moment give one alert in all, under the app\'s own lock name', async () => {
  const w = makeWorld(), a = makeTab(w, 'a'), b = makeTab(w, 'b'), st = state();
  const [x, y] = await Promise.all([a.tick(st, at(-10)), b.tick(st, at(-10))]);
  assert.equal(x.length + y.length, 1);
  assert.deepEqual(new Set(w.lockNames), new Set(['gw2-timer:reminders']));
  assert.equal(R.LOCK_NAME, 'gw2-timer:reminders');
  await Promise.all([a.tick(st, at(-9)), b.tick(st, at(-9))]);
  assert.equal(a.alerts.length + b.alerts.length, 1);
  assert.equal(a.shown.length + b.shown.length, 1); // the notice is in the tab that delivered
});

await test('S3 and S4: changing the lead never repeats a reminder; a longer lead that reaches a start not yet announced alerts once', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a');
  await tab.tick(state(), at(-10));
  for (const lead of [15, 5, 10]) assert.deepEqual(await tab.tick(state({ settings: { on: true, lead } }), at(-8)), [], `lead ${lead}`);
  assert.equal(tab.alerts.length, 1);
  assert.deepEqual(ids(tab.shown), [SH.id]);
  const w2 = makeWorld(), t2 = makeTab(w2, 'a');
  assert.deepEqual(await t2.tick(state({ settings: { on: true, lead: 5 } }), at(-12)), []);
  assert.deepEqual(ids(await t2.tick(state({ settings: { on: true, lead: 15 } }), at(-12))), [SH.id]);
  assert.deepEqual(await t2.tick(state({ settings: { on: true, lead: 5 } }), at(-4)), []);
});

await test('S5 and S6: off and on, unstar and star, hide and restore: no second alert, and this tab\'s notice comes back', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a');
  await tab.tick(state(), at(-10));
  for (const away of [{ settings: { on: false, lead: 10 } }, { starred: [] }, { hidden: [SH.id] }]) {
    assert.deepEqual(await tab.tick(state(away), at(-8)), []);
    assert.deepEqual(tab.shown, [], JSON.stringify(away));
    assert.deepEqual(await tab.tick(state(), at(-7)), []);
    assert.deepEqual(ids(tab.shown), [SH.id], JSON.stringify(away));
  }
  assert.equal(tab.alerts.length, 1);
});

await test('S7: Dismiss removes the notice and nothing else: the occurrence stays covered', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a'), st = state();
  await tab.tick(st, at(-10));
  tab.dismiss(SH.id);
  for (const m of [-9, -5, -1]) { assert.deepEqual(await tab.tick(st, at(m)), []); assert.deepEqual(tab.shown, []); }
  assert.deepEqual(R.dismiss([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['a', 'c']), [{ id: 'b' }]);
  assert.deepEqual(R.dismiss(undefined, ['a']), []);
  assert.deepEqual(R.dismiss([{ id: 'a' }], undefined), [{ id: 'a' }]);
});

await test('S8: starring an event, or turning reminders on, inside the lead time alerts at once', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a');
  assert.deepEqual(await tab.tick(state({ starred: [] }), at(-5)), []);
  assert.deepEqual(ids(await tab.tick(state(), at(-5) + 1000)), [SH.id]);
  const w2 = makeWorld(), t2 = makeTab(w2, 'a');
  assert.deepEqual(await t2.tick(state({ settings: { on: false, lead: 10 } }), at(-3)), []);
  assert.deepEqual(ids(await t2.tick(state(), at(-3) + 1000)), [SH.id]);
});

// ---- J: Adjust. Announced at 6:50 for 7:00 (at(-10) for T0); the change is made at 6:51. ----

async function announced() {
  const w = makeWorld(), tab = makeTab(w, 'a');
  assert.deepEqual(ids(await tab.tick(state(), at(-10))), [SH.id]);
  return { w, tab };
}
const notice = (tab) => tab.shown.map((n) => [n.id, n.start, n.adjusted]);

await test('J1 to J3: a correction (earlier, or later by less than the lead) never alerts; the notice shows the new time', async () => {
  for (const delta of [2, -3, 9, 1, -8]) {
    const { tab } = await announced();
    const st = state({ overrides: moved(delta) });
    assert.deepEqual(await tab.tick(st, at(-9)), [], `moved ${delta}`);
    assert.deepEqual(notice(tab), [[SH.id, at(delta), true]], `moved ${delta}`);
    // ...and stays silent, second by second, until its start.
    for (let now = at(-9); now < at(delta); now += 30000) assert.deepEqual(await tab.tick(st, now), [], `moved ${delta}`);
    assert.equal(tab.alerts.length, 1);
    await tab.tick(st, at(delta));
    assert.deepEqual(tab.shown, [], 'the notice ends at the start');
  }
});

await test('J4 and J5: moved later by the lead or more is a reschedule: the notice stays and shows the new time at once, and the event alerts again at its new reminder time, in the same notice', async () => {
  for (const delta of [10, 40, 60]) {
    const { tab } = await announced();
    const st = state({ overrides: moved(delta) });
    assert.deepEqual(await tab.tick(st, at(-9)), []);
    assert.deepEqual(notice(tab), [[SH.id, at(delta), true]], `moved ${delta}: the notice is kept and updated`);
    for (let now = at(-9); now < at(delta - 10); now += 30000) { assert.deepEqual(await tab.tick(st, now), [], `moved ${delta}`); assert.equal(tab.shown.length, 1); }
    assert.deepEqual((await tab.tick(st, at(delta - 10))).map((i) => i.start), [at(delta)], `moved ${delta}: alerts at the new reminder time`);
    assert.deepEqual(notice(tab), [[SH.id, at(delta), true]], 'one notice for the event, not two');
    assert.equal(tab.live.length, 1);
    for (let now = at(delta - 10); now < at(delta); now += 30000) assert.deepEqual(await tab.tick(st, now), []);
    assert.equal(tab.alerts.length, 2);
    assert.ok(tab.alerts[1].at >= tab.alerts[0].start, 'the second alert is not before the start the first one named');
  }
});

await test('J6: moved earlier into the past, the notice ends; the next occurrence alerts normally', async () => {
  const { tab } = await announced();
  const st = state({ overrides: moved(-15) }); // 6:45, and it is 6:51
  assert.deepEqual(await tab.tick(st, at(-9)), []);
  assert.deepEqual(tab.shown, []);
  assert.deepEqual(tab.live, []);
  for (let now = at(-9); now < at(120 - 15 - 10); now += 60000) assert.deepEqual(await tab.tick(st, now), []);
  assert.deepEqual((await tab.tick(st, at(120 - 15 - 10))).map((i) => i.start), [at(105)]);
});

await test('J7 and J8: three small nudges are one notice and no alert; a later substantial move then alerts at its own time', async () => {
  const { tab } = await announced();
  for (const [delta, m] of [[2, -9], [4, -8.5], [1, -8]]) {
    assert.deepEqual(await tab.tick(state({ overrides: moved(delta) }), at(m)), []);
    assert.deepEqual(notice(tab), [[SH.id, at(delta), true]]);
  }
  const st = state({ overrides: moved(45) });
  assert.deepEqual(await tab.tick(st, at(-2)), []);
  assert.deepEqual(notice(tab), [[SH.id, at(45), true]]);
  assert.deepEqual(await tab.tick(st, at(35) - 1), []);
  assert.deepEqual((await tab.tick(st, at(35))).map((i) => i.start), [at(45)]);
  assert.equal(tab.alerts.length, 2);
});

await test('J9 and J10: clearing Adjust is a change like any other; an adjustment before any reminder just moves the reminder', async () => {
  // Adjusted 5 minutes early from the start: announced for at(-5); cleared at 6:46, back to the dataset time.
  const w = makeWorld(), tab = makeTab(w, 'a');
  assert.deepEqual((await tab.tick(state({ overrides: moved(-5) }), at(-15))).map((i) => i.start), [at(-5)]);
  assert.deepEqual(await tab.tick(state(), at(-14)), []);
  assert.deepEqual(notice(tab), [[SH.id, T0, false]]);
  assert.equal(tab.alerts.length, 1);
  const w2 = makeWorld(), t2 = makeTab(w2, 'a'), st = state({ overrides: moved(20) });
  for (const m of [-20, -10, 0, 9.9]) assert.deepEqual(await t2.tick(st, at(m)), []);
  assert.deepEqual((await t2.tick(st, at(10))).map((i) => i.start), [at(20)]);
  assert.equal(t2.alerts.length, 1);
});

await test('J11: a nudge across half the period (the case that breaks numbering cycles) is still a correction', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a');
  assert.deepEqual((await tab.tick(state({ overrides: moved(59) }), at(49))).map((i) => i.start), [at(59)]);
  for (const delta of [61, 60, 62]) {
    assert.deepEqual(await tab.tick(state({ overrides: moved(delta) }), at(50)), [], `to +${delta}`);
    assert.deepEqual(notice(tab), [[SH.id, at(delta), true]]);
  }
  assert.equal(tab.alerts.length, 1);
});

await test('J12: the threshold is the lead in force: 15 minutes with a 15 minute lead, 5 with 5', async () => {
  for (const lead of [5, 15]) {
    const settings = { on: true, lead };
    const w = makeWorld(), tab = makeTab(w, 'a');
    assert.deepEqual(ids(await tab.tick(state({ settings }), at(-lead))), [SH.id]);
    const near = state({ settings, overrides: moved(lead - 1) });
    for (let now = at(-lead) + 1000; now < at(lead - 1); now += 20000) assert.deepEqual(await tab.tick(near, now), [], `lead ${lead}, moved ${lead - 1}`);
    const w2 = makeWorld(), t2 = makeTab(w2, 'a');
    await t2.tick(state({ settings }), at(-lead));
    const far = state({ settings, overrides: moved(lead) });
    assert.deepEqual(await t2.tick(far, at(0) - 1), []);
    assert.deepEqual((await t2.tick(far, at(0))).map((i) => i.start), [at(lead)], `lead ${lead}, moved ${lead}`);
  }
});

await test('J13 and J14: a correction stays covered after a reload; the natural next occurrence alerts as usual', async () => {
  const { tab } = await announced();
  const st = state({ overrides: moved(2) });
  await tab.tick(st, at(-9));
  tab.reload();
  for (const m of [-8, -4, 0, 1.9]) assert.deepEqual(await tab.tick(st, at(m)), []);
  assert.deepEqual(tab.shown, []);
  const { tab: t2 } = await announced();
  for (let now = at(-9); now < at(110); now += 60000) assert.deepEqual(await t2.tick(state(), now), []);
  assert.deepEqual((await t2.tick(state(), at(110))).map((i) => i.start), [at(120)]);
});

await test('a move beyond half the period ends the notice (the start it followed is gone), and the new start alerts in a new one', async () => {
  const { tab } = await announced();
  const st = state({ overrides: moved(70) }); // the nearest start to 7:00 is now 6:10, in the past; the next is 8:10
  assert.deepEqual(await tab.tick(st, at(-9)), []);
  assert.deepEqual(tab.live, []);
  assert.deepEqual((await tab.tick(st, at(60))).map((i) => i.start), [at(70)]);
  assert.deepEqual(notice(tab), [[SH.id, at(70), true]]);
});

// ---- Notices on their own ----

await test('open keeps one notice per event; follow ends a notice at its start and for an event that is gone', () => {
  const item = { id: SH.id, start: T0, event: SH };
  let live = R.open([], item);
  assert.deepEqual(live, [{ id: SH.id, target: T0 }]);
  live = R.open(live, { id: SH.id, start: at(120), event: SH });
  assert.deepEqual(live.map((n) => [n.id, n.target]), [[SH.id, at(120)]]);
  live = R.open(R.open([], item), { id: 'drakkar', start: S.nextStart(ev('drakkar').schedule, T0 - 1), event: ev('drakkar') });
  assert.deepEqual(ids(live), [SH.id, 'drakkar']);
  const ctx = (now, over = {}) => ({ live, events: EVENTS, engine: S, now, ...state({ starred: [SH.id, 'drakkar'] }), ...over });
  assert.deepEqual(ids(R.follow(ctx(T0 - 1)).live), [SH.id, 'drakkar']);
  assert.ok(!ids(R.follow(ctx(T0)).live).includes(SH.id), 'ended at its start');
  assert.deepEqual(ids(R.follow(ctx(T0 - 1, { events: EVENTS.filter((e) => e.id !== 'drakkar') })).live), [SH.id]);
  assert.deepEqual(R.follow(ctx(T0 - 1, { live: undefined })), { live: [], shown: [] });
  // A daily-list event (never adjustable): its notice ends at its start too.
  const teq = ev('tequatl-the-sunless'), t3 = utc('2026-11-20T03:00:00Z');
  const tLive = R.open([], { id: teq.id, start: t3, event: teq });
  const tRun = (now) => R.follow({ live: tLive, events: EVENTS, engine: S, now, ...state({ starred: [teq.id] }) });
  assert.deepEqual(tRun(t3 - 1).shown.map((n) => n.start), [t3]);
  assert.deepEqual(tRun(t3).live, []);
});

await test('follow shows a notice only while reminders are on and the event is starred and not hidden, soonest first', () => {
  const dr = ev('drakkar');
  const live = [{ id: 'drakkar', target: S.nextStart(dr.schedule, T0 - MIN) }, { id: SH.id, target: T0 }];
  const run = (over) => R.follow({ live, events: EVENTS, engine: S, now: T0 - MIN, ...state({ starred: [SH.id, 'drakkar'] }), ...over });
  assert.deepEqual(run({}).shown.map((n) => [n.id, n.start, n.adjusted]), [[SH.id, T0, false], ['drakkar', S.nextStart(dr.schedule, T0 - MIN), false]].sort((a, b) => a[1] - b[1]));
  assert.deepEqual(ids(run({ starred: [SH.id] }).shown), [SH.id]);
  assert.deepEqual(ids(run({ hidden: [SH.id] }).shown), ['drakkar']);
  assert.deepEqual(run({ settings: { on: false, lead: 10 } }).shown, []);
  for (const over of [{ starred: [] }, { hidden: [SH.id, 'drakkar'] }, { settings: { on: false, lead: 10 } }]) assert.equal(run(over).live.length, 2, 'not shown is not ended');
});

await test('a notice follows an adjusted start: earlier always, later by up to half the period, and no further', () => {
  const live = [{ id: SH.id, target: T0 }];
  const run = (delta, now = at(-9)) => R.follow({ live, events: EVENTS, engine: S, now, ...state({ overrides: moved(delta) }) });
  for (const delta of [1, 30, 60, -1, -8]) assert.deepEqual(run(delta).shown.map((n) => n.start), [at(delta)], `moved ${delta}`);
  for (const delta of [61, 90, -9, -30]) assert.deepEqual(run(delta).live, [], `moved ${delta}`); // 61 on: too much later; -9 on: already past
  for (const delta of [1, 60]) assert.deepEqual(run(delta).live, [{ id: SH.id, target: at(delta) }]);
  // Moved a long way earlier, and still ahead: the notice follows (a notice at 8:00 whose event is put back to 6:55).
  const far = [{ id: SH.id, target: at(60) }];
  assert.deepEqual(R.follow({ live: far, events: EVENTS, engine: S, now: at(-9), ...state({ overrides: moved(-5) }) }).shown.map((n) => n.start), [at(-5)]);
  // A three-hour event reaches 90 minutes.
  const dc = ev('depths-of-cruelty'), d0 = S.nextStart(dc.schedule, utc('2026-11-20T12:00:00Z'));
  const dLive = [{ id: dc.id, target: d0 }];
  const dRun = (delta) => R.follow({ live: dLive, events: EVENTS, engine: S, now: d0 - 9 * MIN, ...state({ starred: [dc.id], overrides: { [dc.id]: { offsetMin: mod(dc.schedule.offsetMin + delta, 180), setAt: 0 } } }) });
  assert.deepEqual(dRun(90).shown.map((n) => n.start), [d0 + 90 * MIN]);
  assert.deepEqual(dRun(91).live, []);
});

// ---- C: time jumps and the clock ----

await test('C1 to C4: after a sleep, only what is due now alerts; nothing that has started, and a late tick is late, not lost', async () => {
  const st = state();
  const a = makeTab(makeWorld(), 'a');
  await a.tick(st, at(-20));
  assert.deepEqual(await a.tick(st, at(1)), []);                       // C1: slept past the start
  const b = makeTab(makeWorld(), 'b');
  await b.tick(st, at(-30));
  assert.deepEqual((await b.tick(st, at(-3))).map((i) => i.start - at(-3)), [3 * MIN]); // C2: woke inside the lead time
  const d = makeTab(makeWorld(), 'd');
  await d.tick(st, at(-11));
  assert.deepEqual(ids(await d.tick(st, at(-10) + 65000)), [SH.id]);   // C4: a tick 65 s late
});

await test('C3: six hours asleep with every event starred: at most one alert per event, each for a start still ahead and within the lead, and no backlog', async () => {
  const tab = makeTab(makeWorld(), 'a'), st = state({ starred: IDS, settings: { on: true, lead: 15 } });
  const t = utc('2026-11-20T00:00:30Z');
  await tab.tick(st, t);
  const before = tab.alerts.length;
  const woke = t + 6 * HOUR;
  const won = await tab.tick(st, woke);
  assert.equal(new Set(ids(won)).size, won.length);
  for (const it of won) assert.ok(it.start > woke && it.start - woke <= 15 * MIN, it.id);
  const missed = EVENTS.flatMap((e) => S.occurrences(e.schedule, t + 16 * MIN, woke).filter((s) => s > t + 16 * MIN && s <= woke)).length;
  assert.ok(missed > 50, 'many starts passed during the sleep');
  assert.ok(tab.alerts.length - before <= IDS.length && won.length < missed);
  assert.deepEqual(await tab.tick(st, woke + 1000), []);
});

await test('C5 and C6: a clock correction, backward or forward, after a reminder does not repeat it', async () => {
  for (const jump of [-3, 3, -9, -30, 8]) {
    const { tab } = await announced();
    const st = state();
    let now = at(-7) + jump * MIN; // the corrected clock
    for (; now < at(0); now += 20000) assert.deepEqual(await tab.tick(st, now), [], `corrected by ${jump} min`);
    assert.equal(tab.alerts.length, 1);
  }
});

await test('C8: announced early by a clock 30 minutes fast, then the clock is fixed: not repeated at the true time, and the next occurrence alerts', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a'), st = state();
  assert.deepEqual(ids(await tab.tick(st, at(-10))), [SH.id]); // the true time is 6:20
  for (let now = at(-40); now < at(0); now += 30000) assert.deepEqual(await tab.tick(st, now), []);
  tab.reload();
  for (let now = at(-12); now < at(110); now += 60000) assert.deepEqual(await tab.tick(st, now), []);
  assert.deepEqual((await tab.tick(st, at(110))).map((i) => i.start), [at(120)]);
});

await test('C9: damaged or hostile saved records are ignored and reminders work', async () => {
  for (const value of ['"text"', '[]', '42', 'null', '{"__proto__":{"x":1}}', JSON.stringify({ [SH.id]: { start: T0 + 2 * DAY, at: 1 } }), JSON.stringify({ [SH.id]: { start: 'soon', at: 'now' } }), JSON.stringify({ [SH.id]: 'x', nope: { start: T0, at: 1 } })]) {
    const w = makeWorld();
    w.value = value;
    const tab = makeTab(w, 'a');
    assert.deepEqual(ids(await tab.tick(state(), at(-10))), [SH.id], value);
    assert.deepEqual(Object.keys(JSON.parse(w.value)), [SH.id], value); // and what is saved afterwards is clean
  }
  const w = makeWorld();
  w.read = () => 'not an object at all';
  const tab = makeTab(w, 'a');
  assert.deepEqual(ids(await tab.tick(state(), at(-10))), [SH.id]);
});

await test('C10: a tab discarded before the reminder time and reloaded after the start alerts nothing', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a'), st = state();
  await tab.tick(st, at(-15));
  tab.reload();
  assert.deepEqual(await tab.tick(st, at(5)), []);
  assert.equal(tab.alerts.length, 0);
});

// ---- The claim: storage failures and tabs in contention ----

const ITEM = { id: SH.id, start: T0, lead: 10, event: SH };
const claimWith = (over) => R.claim({ item: ITEM, now: at(-10), by: 'a', mem: {}, read: () => null, write: () => true, wait: () => Promise.resolve(), eventIds: IDS, ...over });

await test('the claim is written before it is won, with this tab\'s id, and a second claim loses', async () => {
  const w = makeWorld(), mem = {};
  const r = await claimWith({ read: w.read, write: w.write, locks: w.locks, mem });
  assert.deepEqual(r, { won: true, persisted: true, locked: true });
  assert.deepEqual(JSON.parse(w.value), { [SH.id]: { start: T0, at: at(-10), by: 'a' } });
  assert.deepEqual(mem, { [SH.id]: { start: T0, at: at(-10), by: 'a' } });
  assert.deepEqual(await claimWith({ read: w.read, write: w.write, locks: w.locks, by: 'b' }), { won: false, persisted: false, locked: true });
  assert.equal(w.writes, 1);
});

await test('storage that cannot be written: the tab still reminds once and never repeats itself, in memory', async () => {
  const w = makeWorld();
  w.writeFails = true;
  const tab = makeTab(w, 'a'), st = state();
  assert.deepEqual(ids(await tab.tick(st, at(-10))), [SH.id]);
  for (const m of [-9, -5, -1]) assert.deepEqual(await tab.tick(st, at(m)), []);
  assert.equal(w.value, undefined);
  assert.deepEqual(await claimWith({ write: () => false }), { won: true, persisted: false, locked: false });
  assert.deepEqual(await claimWith({ write: () => { throw new Error('quota'); } }), { won: true, persisted: false, locked: false });
  assert.deepEqual(await claimWith({ write: () => undefined }), { won: true, persisted: false, locked: false }); // only a plain true counts as saved
});

await test('storage that cannot be read: the same, and a second tab cannot be coordinated (the stated limit)', async () => {
  const w = makeWorld();
  w.readFails = true; w.writeFails = true;
  const a = makeTab(w, 'a'), b = makeTab(w, 'b'), st = state();
  assert.deepEqual(ids(await a.tick(st, at(-10))), [SH.id]);
  assert.deepEqual(await a.tick(st, at(-9)), []);
  assert.deepEqual(ids(await b.tick(st, at(-9))), [SH.id]); // each tab has only its own memory
  assert.deepEqual(await claimWith({ read: () => { throw new Error('blocked'); } }), { won: true, persisted: true, locked: false });
});

await test('storage that fails after a reminder was saved, then works again: still no repeat', async () => {
  const w = makeWorld(), tab = makeTab(w, 'a'), st = state();
  await tab.tick(st, at(-10));
  w.readFails = true;
  assert.deepEqual(await tab.tick(st, at(-8)), []); // from memory
  w.readFails = false;
  tab.reload();
  assert.deepEqual(await tab.tick(st, at(-6)), []); // from storage
});

await test('without Web Locks, two tabs that both wrote the same occurrence: only the one whose record stayed goes on', async () => {
  const w = makeWorld();
  // Each tab's first read is from before the other wrote, as two processes can see it.
  const stale = () => { let first = true; return () => { if (first) { first = false; return null; } return w.read(); }; };
  const results = await Promise.all(['a', 'b'].map((by) => claimWith({ by, read: stale(), write: w.write })));
  assert.equal(w.writes, 2, 'both wrote');
  assert.deepEqual(results.map((r) => r.won), [false, true]); // b wrote last; its record stayed
  assert.equal(JSON.parse(w.value)[SH.id].by, 'b');
  assert.deepEqual(results.map((r) => r.locked), [false, false]);
});

await test('without Web Locks, the tab waits before it checks, for the time the module names', async () => {
  const waits = [];
  const w = makeWorld();
  await claimWith({ read: w.read, write: w.write, wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
  assert.deepEqual(waits, [R.SETTLE_MS]);
  assert.ok(R.SETTLE_MS >= 100 && R.SETTLE_MS <= 1000);
  // With a lock there is nothing to wait for.
  const none = [];
  await claimWith({ read: makeWorld().read, write: () => true, locks: makeWorld().locks, wait: (ms) => { none.push(ms); return Promise.resolve(); } });
  assert.deepEqual(none, []);
});

await test('without Web Locks, a write for another event that replaced ours is put back, and ours still wins', async () => {
  const w = makeWorld();
  const other = { drakkar: { start: T0, at: at(-10), by: 'b' } };
  const r = await claimWith({ read: w.read, write: w.write, wait: () => { w.value = JSON.stringify(other); return Promise.resolve(); } });
  assert.equal(r.won, true);
  assert.deepEqual(JSON.parse(w.value), { drakkar: other.drakkar, [SH.id]: { start: T0, at: at(-10), by: 'a' } });
});

await test('without Web Locks, a later start announced by another tab meanwhile means this claim is lost', async () => {
  const w = makeWorld();
  const r = await claimWith({ read: w.read, write: w.write, wait: () => { w.value = JSON.stringify({ [SH.id]: { start: at(30), at: at(-10), by: 'b' } }); return Promise.resolve(); } });
  assert.equal(r.won, false);
});

await test('Web Locks that throw or reject fall back to the unlocked claim; a lock that ran the claim is never run twice', async () => {
  const w = makeWorld();
  assert.deepEqual(await claimWith({ read: w.read, write: w.write, locks: { request: () => { throw new Error('SecurityError'); } } }), { won: true, persisted: true, locked: false });
  const w2 = makeWorld();
  assert.deepEqual(await claimWith({ read: w2.read, write: w2.write, locks: { request: () => Promise.reject(new Error('no')) } }), { won: true, persisted: true, locked: false });
  const w3 = makeWorld();
  const ranThenRejected = { request: async (name, fn) => { await fn(); throw new Error('after the fact'); } };
  assert.deepEqual(await claimWith({ read: w3.read, write: w3.write, locks: ranThenRejected }), { won: true, persisted: true, locked: true });
  assert.equal(w3.writes, 1);
  for (const locks of [undefined, null, {}, { request: 'no' }]) assert.equal((await claimWith({ locks })).locked, false);
});

await test('a claim for a start that is covered in memory only (storage blocked) is refused without a write', async () => {
  let writes = 0;
  const mem = { [SH.id]: { start: T0, at: 1, by: 'a' } };
  assert.deepEqual(await claimWith({ mem, write: () => { writes++; return true; } }), { won: false, persisted: false, locked: false });
  assert.equal(writes, 0);
  // And a covered record in storage is copied to memory, so a later storage failure cannot bring a repeat.
  const w = makeWorld(), seen = {};
  w.value = JSON.stringify({ [SH.id]: { start: T0, at: 1, by: 'b' } });
  await claimWith({ read: w.read, write: w.write, mem: seen });
  assert.deepEqual(seen, { [SH.id]: { start: T0, at: 1, by: 'b' } });
});

// ---- The list in the dialog ----

await test('upcoming lists each starred event with its next start, reminder time and state, soonest reminder first', () => {
  const now = at(-30);
  const ctx = (over = {}) => ({ events: EVENTS, engine: S, now, records: {}, ...state({ starred: [SH.id, 'drakkar', 'tequatl-the-sunless'] }), ...over });
  const rows = R.upcoming(ctx());
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.start, S.nextStart(ev(r.id).schedule, now));
    assert.equal(r.trigger, r.start - 10 * MIN);
    assert.equal(r.state, r.trigger <= now ? 'due' : 'on');
  }
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].trigger <= rows[i].trigger);
  const stateOf = (over, nowAt = now) => R.upcoming(ctx({ now: nowAt, ...over })).find((r) => r.id === SH.id).state;
  assert.equal(stateOf({}), 'on');
  assert.equal(stateOf({}, at(-10)), 'due');
  assert.equal(stateOf({}, at(-10) - 1), 'on');
  assert.equal(stateOf({ settings: { on: false, lead: 10 } }), 'off');
  assert.equal(stateOf({ hidden: [SH.id] }), 'hidden');
  assert.equal(stateOf({ records: { [SH.id]: { start: T0, at: 1 } } }, at(-5)), 'reminded');
  assert.equal(stateOf({ records: { [SH.id]: { start: T0, at: 1 } }, overrides: moved(3) }, at(-5)), 'reminded');
  assert.equal(stateOf({ records: { [SH.id]: { start: T0 - 120 * MIN, at: 1 } } }, at(-5)), 'due');
  assert.equal(R.upcoming(ctx({ settings: { on: true, lead: 15 } }))[0].lead, 15);
  assert.deepEqual(R.upcoming(ctx({ starred: [] })), []);
  assert.equal(R.upcoming(ctx({ overrides: moved(7) })).find((r) => r.id === SH.id).start, at(7));
});

await test('nextChange is the next reminder time or start after now, or Infinity', () => {
  const rows = [{ trigger: 100, start: 200 }, { trigger: 150, start: 250 }];
  assert.deepEqual([0, 100, 149, 150, 200, 249, 250].map((now) => R.nextChange(rows, now)), [100, 150, 150, 200, 250, 250, Infinity]);
  assert.equal(R.nextChange([], 0), Infinity);
  assert.equal(R.nextChange(undefined, 0), Infinity);
});

// ---- P: properties, over generated sequences ----

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

await test('P1, P2, P4, P5: over random sequences of ticks, reloads, two tabs, lead, star, hide, on and off, Adjust, sleeps and clock corrections', async () => {
  const POOL = ['shackles-of-the-ancients', 'secrets-of-the-weald', 'depths-of-cruelty', 'nexus-of-eternity', 'tequatl-the-sunless', 'octovine', 'karka-queen', 'claw-of-jormag'];
  const ADJUSTABLE = POOL.filter((id) => ev(id).adjustable);
  let alerts = 0, moves = 0;
  for (let seed = 1; seed <= 160; seed++) {
    const rand = rng(seed * 7919), pick = (list) => list[Math.floor(rand() * list.length)], int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
    const w = makeWorld(), locks = seed % 2 === 0;
    const tabs = [makeTab(w, 'a', { locks }), makeTab(w, 'b', { locks })];
    const st = state({ starred: POOL.filter(() => rand() < 0.7), settings: { on: true, lead: pick(R.LEADS) } });
    let now = utc('2026-10-24T00:00:00Z') + int(0, 3 * DAY);
    const last = {}; // the latest start announced for each event, by any tab
    const check = (tab, tickNow, won) => {
      const where = `seed ${seed} at ${new Date(tickNow).toISOString()}`;
      for (const it of won) {
        alerts++;
        assert.ok(tickNow < it.start, `P2 ${where} ${it.id}`);
        assert.ok(it.start - tickNow <= it.lead * MIN, `within the lead ${where} ${it.id}`);
        if (last[it.id] !== undefined) assert.ok(it.start - it.lead * MIN >= last[it.id], `P1 ${where} ${it.id}: reminded again before the start already announced`);
        last[it.id] = Math.max(last[it.id] === undefined ? -Infinity : last[it.id], it.start);
      }
      assert.equal(new Set(ids(tab.shown)).size, tab.shown.length, `P4 one notice per event ${where}`);
      for (const n of tab.shown) {
        const e = R.effective(ev(n.id), st.overrides, S);
        assert.equal(n.start, S.nextStart(e.schedule, tickNow), `P4 the notice shows the current start ${where} ${n.id}`);
        assert.ok(st.settings.on && st.starred.includes(n.id) && !st.hidden.includes(n.id), `P4 shown only when wanted ${where}`);
      }
      if (w.value !== undefined) {
        const saved = JSON.parse(w.value);
        assert.ok(Object.keys(saved).every((k) => IDS.includes(k)) && Object.keys(saved).length <= IDS.length, `P5 ${where}`);
        // What is read back for use is always pruned: sound, and within a day of now.
        for (const r of Object.values(R.prune(saved, IDS, tickNow))) assert.ok(Number.isFinite(r.start) && Math.abs(r.start - tickNow) <= DAY, `P5 ${where}`);
      }
    };
    for (let step = 0; step < 90; step++) {
      const op = rand();
      if (op < 0.40) now += int(1, 90) * 1000;
      else if (op < 0.62) now += int(1, 20) * MIN;
      else if (op < 0.66) now += int(1, 6) * HOUR;                      // asleep
      else if (op < 0.70) now += int(-5, 5) * MIN;                      // the clock is corrected
      else if (op < 0.74) pick(tabs).reload();
      else if (op < 0.78) st.settings = { on: st.settings.on, lead: pick(R.LEADS) };
      else if (op < 0.81) st.settings = { on: !st.settings.on, lead: st.settings.lead };
      else if (op < 0.85) { const id = pick(POOL); st.starred = st.starred.includes(id) ? st.starred.filter((x) => x !== id) : st.starred.concat([id]); }
      else if (op < 0.88) { const id = pick(POOL); st.hidden = st.hidden.includes(id) ? st.hidden.filter((x) => x !== id) : st.hidden.concat([id]); }
      else if (op < 0.90) { const t = pick(tabs); if (t.shown.length) t.dismiss(pick(t.shown).id); }
      else {
        moves++;
        const id = pick(ADJUSTABLE), e = ev(id), p = e.schedule.periodMin;
        const cur = st.overrides[id] ? st.overrides[id].offsetMin : e.schedule.offsetMin;
        const kind = rand();
        st.overrides = Object.assign({}, st.overrides);
        if (kind < 0.15) delete st.overrides[id];
        else st.overrides[id] = { offsetMin: mod(kind < 0.7 ? cur + int(-4, 4) : int(0, p - 1), p), setAt: 0 }; // a nudge, or anywhere in the period
      }
      if (rand() < 0.25) {
        const got = await Promise.all(tabs.map((t) => t.tick(st, now)));
        assert.ok(new Set(got.flatMap(ids)).size === got.flatMap(ids).length, `seed ${seed}: two tabs alerted for the same event at once`);
        tabs.forEach((t, i) => check(t, now, got[i]));
      } else {
        const t = pick(tabs);
        check(t, now, await t.tick(st, now));
      }
    }
  }
  assert.ok(alerts > 300 && moves > 800, `the sequences did exercise reminders (${alerts} alerts, ${moves} adjustments)`);
});

await test('P3: with nothing changing and a tick every 20 seconds for two days, in two tabs, no start is missed and none is announced twice', async () => {
  const w = makeWorld(), tabs = [makeTab(w, 'a'), makeTab(w, 'b', { locks: false })];
  const starred = ['shackles-of-the-ancients', 'tequatl-the-sunless', 'depths-of-cruelty', 'octovine', 'karka-queen'];
  const st = state({ starred, settings: { on: true, lead: 5 }, overrides: moved(17) });
  const t0 = utc('2026-10-31T00:00:10Z'), t1 = t0 + 2 * DAY; // across the US clock change
  for (let now = t0, i = 0; now <= t1; now += 20000, i++) await tabs[Math.floor(i / 7) % 2].tick(st, now); // the tabs take turns, seven ticks each
  const got = tabs.flatMap((t) => t.alerts).map((a) => `${a.start} ${a.id}`).sort();
  const want = starred.flatMap((id) => { const e = R.effective(ev(id), st.overrides, S); return S.occurrences(e.schedule, t0, t1 + 6 * MIN).filter((s) => s > t0 && s - 5 * MIN <= t1).map((s) => `${s} ${id}`); }).sort();
  assert.deepEqual(got, want);
  assert.equal(new Set(got).size, got.length);
  assert.ok(tabs[0].alerts.length > 10 && tabs[1].alerts.length > 10, 'both tabs delivered some');
});

console.log(`reminders [${tz}]: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
