// Time-zone checks, run by tests/run.mjs once per zone (TZ set in the environment). Schedules are
// UTC, so the only code that may change with the zone is the display and "I saw it at" math.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const S = createRequire(import.meta.url)('../js/schedule.js');
const DATA = createRequire(import.meta.url)('../events-data.js');
const tz = process.env.TZ;
const utc = (iso) => Date.parse(iso);
const ev = (id) => DATA.events.find((e) => e.id === id);
let failed = 0;
function test(name, fn) { try { fn(); } catch (e) { failed++; console.log(`FAIL [${tz}] ${name}\n  ${e.message}`); } }

// The local clock reading of an instant, from the platform (independent of schedule.js).
const local = (ms) => { const d = new Date(ms); return [d.getHours(), d.getMinutes()]; };

test('the same UTC start is reached from the local time it shows, for every event, on DST change days too', () => {
  for (const day of ['2026-03-08', '2026-03-29', '2026-04-05', '2026-10-04', '2026-10-25', '2026-11-01', '2026-11-02']) {
    for (const id of ['shackles-of-the-ancients', 'depths-of-cruelty', 'nexus-of-eternity', 'secrets-of-the-weald']) {
      const sch = ev(id).schedule;
      for (const start of S.occurrences(sch, utc(`${day}T00:00:00Z`), utc(`${day}T23:59:59Z`))) {
        const [hh, mm] = local(start);
        const r = S.offsetFromSeen(hh, mm, start + 5 * 60000, sch.periodMin);
        assert.equal(r.seenMs, start, `${id} ${new Date(start).toISOString()}`);
        assert.equal(r.offsetMin, sch.offsetMin, `${id} ${new Date(start).toISOString()}`);
      }
    }
  }
});

test('a time entered for later today is read as yesterday', () => {
  const now = utc('2026-10-25T12:00:00Z');
  const later = now + 3 * 3600000;
  const [hh, mm] = local(later);
  const r = S.offsetFromSeen(hh, mm, now, 120);
  assert.ok(r.seenMs <= now && now - r.seenMs < 24 * 3600000 + 3600001, new Date(r.seenMs).toISOString());
});

test('Today and Tomorrow follow the local calendar, across a DST change', () => {
  for (const nowIso of ['2026-10-24T22:00:00Z', '2026-10-31T23:00:00Z', '2026-11-01T05:30:00Z', '2026-03-08T07:30:00Z']) {
    const now = utc(nowIso);
    const n = new Date(now);
    const endOfDay = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1, 0, 0, 0, 0).getTime();
    assert.equal(S.dayLabel(endOfDay - 1, now), 'Today', nowIso);
    assert.equal(S.dayLabel(endOfDay, now), 'Tomorrow', nowIso);
    assert.equal(S.localDayKey(endOfDay - 1) < S.localDayKey(endOfDay), true, nowIso);
  }
});

test('Coming up across the US DST change matches the starts decoded from the wiki data, in any zone', () => {
  // The expected list comes from the Python-decoded fixture, not from schedule.js.
  const golden = JSON.parse(readFileSync(new URL('./fixtures/wiki-v5.4-day.json', import.meta.url), 'utf8')).events;
  const now = utc('2026-11-01T06:58:00Z'), end = now + 2 * 3600000, day0 = utc('2026-11-01T00:00:00Z');
  const want = [];
  for (const e of DATA.events) for (const m of golden[e.id].starts) { const s = day0 + m * 60000; if (s > now && s <= end) want.push(`${s} ${e.id}`); }
  const got = S.upcoming(DATA.events, now, end - now).map((i) => `${i.start} ${i.event.id}`);
  assert.deepEqual(got.slice().sort(), want.sort());
  assert.ok(got.length > 10, `${got.length} starts`);
});

if (failed) process.exit(1);
