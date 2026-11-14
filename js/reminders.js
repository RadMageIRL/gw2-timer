// Reminders for starred events. Pure and without a clock of its own: the time, the saved records and
// everything that touches storage or other tabs are passed in, so the page and the Node tests share
// this file unchanged.
//
// The rule (V0.3.0_REMINDERS_ALGORITHM.md, local): a reminder ANNOUNCES a start time for an event,
// and that announcement COVERS the event until the announced time has come. An event is reminded
// again only for a start whose reminder time (start minus the lead) is at or after the last
// announced start. Every natural next occurrence qualifies; a start that Adjust merely corrected
// does not. So "new occurrence or changed schedule" is one comparison between two schedule instants.
// All of them are UTC instants: local time and daylight saving never enter.
//
// A reminder is due from (start - lead) until the start and never at or after it. Nothing is queued:
// every decision is made from the current time and the saved records, so a late tick, a sleep or a
// reload cannot replay anything.
//
// One record is kept per event: its last announced start. It is written BEFORE anything is shown.
// That gives at most one reminder per occurrence, not a guaranteed one: a tab that claims a reminder
// and is closed before it shows it has used that reminder up.
(function (root) {
  'use strict';

  const MIN = 60000, DAY = 86400000;
  const LEADS = [5, 10, 15];
  const MAX_LEAD = 15;
  /** The Web Lock every tab of this app claims under. Locks are shared by the whole origin, which serves other apps. */
  const LOCK_NAME = 'gw2-timer:reminders';
  /** Without Web Locks: how long a tab waits before checking that its claim is the one that stayed. */
  const SETTLE_MS = 250;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  // ---- Settings ----

  /** Off until the reader turns them on; 10 minutes; no browser notifications. */
  const defaults = () => ({ on: false, lead: 10, notify: false });

  /** Saved settings, checked: anything unexpected falls back to the default. */
  function sanitize(raw) {
    const d = defaults();
    if (!isObj(raw)) return d;
    return { on: raw.on === true, lead: LEADS.includes(raw.lead) ? raw.lead : d.lead, notify: raw.notify === true };
  }

  // ---- Records: the last announced start of each event ----

  /**
   * Saved records, checked against the dataset's event ids: { [event id]: { start, at, by } }.
   * An entry is kept only for a known event, with finite numbers, and a start within a day of now
   * either way: an older one can no longer cover anything, and one further ahead is damage.
   */
  function prune(records, eventIds, now) {
    const out = {};
    if (!isObj(records)) return out;
    for (const id of eventIds || []) {
      const r = records[id];
      if (!isObj(r) || !Number.isFinite(r.start) || !Number.isFinite(r.at) || Math.abs(r.start - now) > DAY) continue;
      out[id] = { start: r.start, at: r.at, by: typeof r.by === 'string' && r.by.length <= 64 ? r.by : '' };
    }
    return out;
  }

  /** Two sets of records as one: for each event, the later announced start. */
  function merge(a, b) {
    const out = Object.assign({}, a);
    for (const id of Object.keys(b || {})) if (!out[id] || b[id].start > out[id].start) out[id] = b[id];
    return out;
  }

  /** True when a start is covered by a record: its reminder time falls before a start already announced. */
  const covered = (record, start, lead) => Boolean(record) && record.start > start - lead * MIN;

  /** The records with this item announced. The later start wins, so an announcement never moves a record back. */
  function announce(records, item, now, by) {
    const out = Object.assign({}, records);
    if (!out[item.id] || item.start > out[item.id].start) out[item.id] = { start: item.start, at: now, by: by || '' };
    return out;
  }

  // ---- What is due ----

  /** The event as the page shows it: with the reader's Adjust offset when it has one. */
  const effective = (event, overrides, engine) => (overrides && has(overrides, event.id) && overrides[event.id]
    ? engine.applyOverride(event, overrides[event.id].offsetMin) : event);

  const byStart = (a, b) => a.start - b.start || a.event.name.localeCompare(b.event.name, 'en') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  /**
   * Reminders due at now, soonest first: for each starred event that is not hidden, its next start
   * when that start is at most the lead away. The start itself is never due (the next start is
   * always after now). Records are not looked at here: see decide().
   * engine: { nextStart(schedule, now), applyOverride(event, offsetMin) } (js/schedule.js).
   */
  function due({ events, overrides, starred, hidden, settings, now, engine }) {
    const s = sanitize(settings);
    if (!s.on) return [];
    const star = new Set(starred || []), hide = new Set(hidden || []), out = [];
    for (const e of events || []) {
      if (!star.has(e.id) || hide.has(e.id)) continue;
      const ev = effective(e, overrides, engine);
      const start = engine.nextStart(ev.schedule, now);
      if (start - s.lead * MIN <= now) out.push({ id: e.id, event: ev, start, lead: s.lead, adjusted: ev.adjusted === true });
    }
    return out.sort(byStart);
  }

  /** Due items split in two: those to alert for (not covered) and those already announced (covered). */
  function decide(dueItems, records) {
    const alert = [], quiet = [];
    for (const it of dueItems) (covered(records && records[it.id], it.start, it.lead) ? quiet : alert).push(it);
    return { alert, quiet };
  }

  // ---- The claim: one tab delivers each reminder ----

  /**
   * Claims one due item for this tab. Resolves to { won, persisted, locked }.
   *   read()        the saved records (anything; it is checked), or a throw
   *   write(obj)    saves them; true when it worked
   *   mem           this tab's own copy of what it has seen announced (an object, updated here), so
   *                 that a tab whose storage is blocked still never repeats itself
   *   by            this tab's id, any short text unique to the tab
   *   locks         navigator.locks, or nothing
   *   wait(ms)      a promise that resolves after ms (the page passes a setTimeout)
   *
   * With Web Locks the read, the test and the write happen under one exclusive lock, held for one
   * synchronous function: two tabs cannot both win.
   *
   * Without them there is no atomic step to be had, and localStorage is not treated as one. The tab
   * writes its claim, waits a moment, and reads again: when two tabs wrote the same occurrence, the
   * record that stayed names one of them, and only that one goes on. This is a best effort: two tabs
   * can still both deliver if the browser shows a write to the other tab later than the wait.
   */
  async function claim({ item, now, by, mem, read, write, locks, wait, eventIds }) {
    const load = () => { try { return prune(read(), eventIds, now); } catch (e) { return {}; } };
    const save = (rec) => { try { return write(rec) === true; } catch (e) { return false; } };
    const attempt = () => {
      const rec = merge(load(), mem);
      if (covered(rec[item.id], item.start, item.lead)) { mem[item.id] = rec[item.id]; return { won: false, persisted: false }; }
      const next = announce(rec, item, now, by);
      mem[item.id] = next[item.id];
      return { won: true, persisted: save(next) };
    };

    let ran = null;
    if (locks && typeof locks.request === 'function') {
      try {
        await locks.request(LOCK_NAME, () => { ran = attempt(); });
      } catch (e) { /* no usable locks here: go on without one */ }
      if (ran) return Object.assign(ran, { locked: true });
    }

    const first = attempt();
    if (!first.won || !first.persisted) return Object.assign(first, { locked: false });
    await wait(SETTLE_MS);
    const cur = load()[item.id];
    if (cur && cur.start === item.start && cur.by !== (by || '')) return { won: false, persisted: true, locked: false }; // another tab's claim stayed
    if (cur && cur.start > item.start) return { won: false, persisted: true, locked: false };
    if (!cur || cur.start < item.start) save(merge(load(), mem)); // a write for another event replaced ours: put it back
    return { won: true, persisted: true, locked: false };
  }

  // ---- Notices: what this tab shows for the reminders it delivered ----

  /** How much later than the start a notice was following an adjusted start may be and still be the same notice. */
  const reach = (schedule) => (schedule.type === 'every' ? (schedule.periodMin * MIN) / 2 : 0);

  /**
   * This tab's notices with one more: a delivered item. An event has one notice at most, so a new
   * reminder for an event that already has one replaces it (the same card, updated).
   */
  function open(live, item) {
    return (live || []).filter((n) => n.id !== item.id).concat([{ id: item.id, target: item.start }]);
  }

  /** This tab's notices without the dismissed ones. Their occurrences stay covered. */
  const dismiss = (live, ids) => (live || []).filter((n) => !(ids || []).includes(n.id));

  /**
   * Brings this tab's notices up to date and says which to show. Returns { live, shown }.
   *
   * A notice follows its event's next start. When the event is adjusted, the notice moves with it
   * and stays: to an earlier start always, to a later one as long as it is no more than half the
   * event's period later. Nothing is announced for that. A notice ends when its start comes: the
   * event's next start is then a whole period on, which is further than a notice follows. The same
   * holds when an adjustment puts the start in the past. A notice is shown while reminders are on
   * and the event is starred and not hidden; otherwise it waits, and comes back without an alert.
   */
  function follow({ live, events, overrides, starred, hidden, settings, now, engine }) {
    const s = sanitize(settings), star = new Set(starred || []), hide = new Set(hidden || []);
    const byId = new Map((events || []).map((e) => [e.id, e]));
    const kept = [], shown = [];
    for (const n of live || []) {
      const e = byId.get(n.id);
      if (!e) continue;
      const ev = effective(e, overrides, engine);
      const next = engine.nextStart(ev.schedule, now);
      if (next - n.target > reach(ev.schedule)) continue; // the start it followed has come, or is gone
      kept.push({ id: n.id, target: next });
      if (s.on && star.has(n.id) && !hide.has(n.id)) shown.push({ id: n.id, event: ev, start: next, adjusted: ev.adjusted === true });
    }
    return { live: kept, shown: shown.sort(byStart) };
  }

  // ---- The list of what is coming, for the settings dialog ----

  /**
   * For each starred event: its next start, when its reminder comes (start minus the lead) and a state:
   *   'on'        a reminder will be shown at `trigger`, if the page is open then
   *   'due'       the reminder time has come and the event has not started
   *   'reminded'  this start was already announced (or is a correction of one that was)
   *   'off'       reminders are turned off
   *   'hidden'    the event is hidden
   * Soonest reminder first, then start, name and id.
   */
  function upcoming({ events, overrides, starred, hidden, settings, records, now, engine }) {
    const s = sanitize(settings), star = new Set(starred || []), hide = new Set(hidden || []), out = [];
    for (const e of events || []) {
      if (!star.has(e.id)) continue;
      const ev = effective(e, overrides, engine);
      const start = engine.nextStart(ev.schedule, now), trigger = start - s.lead * MIN;
      const state = hide.has(e.id) ? 'hidden' : !s.on ? 'off' : covered(records && records[e.id], start, s.lead) ? 'reminded' : trigger <= now ? 'due' : 'on';
      out.push({ id: e.id, event: ev, start, trigger, lead: s.lead, adjusted: ev.adjusted === true, state });
    }
    return out.sort((a, b) => a.trigger - b.trigger || byStart(a, b));
  }

  /** The next moment after now at which time alone changes a row of upcoming(): a reminder time or a start. */
  function nextChange(rows, now) {
    let next = Infinity;
    for (const r of rows || []) for (const t of [r.trigger, r.start]) if (typeof t === 'number' && t > now && t < next) next = t;
    return next;
  }

  // ---- What the data must guarantee ----

  /**
   * The shortest time, in minutes, between two starts of any one event. While it is at least the
   * longest lead, an event's next occurrence is never covered by the one before it, and an event
   * never has two starts due at once. (Adjust moves all of an event's starts alike.)
   */
  function shortestGap(events) {
    let min = Infinity;
    for (const e of events || []) {
      const sch = e.schedule;
      if (sch.type === 'every') min = Math.min(min, sch.periodMin);
      else sch.startsUtc.forEach((m, i) => { min = Math.min(min, (i + 1 < sch.startsUtc.length ? sch.startsUtc[i + 1] : sch.startsUtc[0] + 1440) - m); });
    }
    return min;
  }

  const Reminders = {
    LEADS, MAX_LEAD, LOCK_NAME, SETTLE_MS, defaults, sanitize, prune, merge, covered, announce, effective, due, decide, claim,
    open, dismiss, follow, upcoming, nextChange, shortestGap,
  };
  if (typeof module === 'object' && module.exports) module.exports = Reminders;
  else root.GW2Reminders = Reminders;
})(typeof globalThis !== 'undefined' ? globalThis : this);
