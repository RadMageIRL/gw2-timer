// GW2 Timer schedule engine. Every function is a pure function of epoch milliseconds, so the page
// and the Node tests share this file unchanged. Every schedule repeats on the UTC day and every
// period divides 24 hours, so counting from the Unix epoch (a UTC midnight) needs no calendar: local
// time and daylight saving only ever touch the display helpers at the bottom.
(function (root) {
  'use strict';

  const MIN = 60000, HOUR = 3600000, DAY = 86400000, WEEK = 7 * DAY;
  // 1970-01-01 was a Thursday, so the first Monday 00:00 UTC is day 4.
  const FIRST_MONDAY = 4 * DAY;
  const mod = (a, n) => ((a % n) + n) % n;

  // ---- Occurrences ----

  /** Start times (ms) of every window that overlaps [fromMs, toMs), in order. */
  function occurrences(schedule, fromMs, toMs) {
    const w = schedule.windowMin * MIN, out = [];
    if (schedule.type === 'every') {
      const p = schedule.periodMin * MIN, o = schedule.offsetMin * MIN;
      // The first window still open at fromMs: start + w > fromMs.
      for (let s = o + (Math.floor((fromMs - w - o) / p) + 1) * p; s < toMs; s += p) out.push(s);
    } else {
      for (let d = Math.floor((fromMs - w) / DAY); d * DAY < toMs; d++) {
        for (const m of schedule.startsUtc) {
          const s = d * DAY + m * MIN;
          if (s + w > fromMs && s < toMs) out.push(s);
        }
      }
    }
    return out;
  }

  /** The window containing nowMs ({start, end}), or null. */
  function currentWindow(schedule, nowMs) {
    const starts = occurrences(schedule, nowMs, nowMs + 1);
    if (!starts.length) return null;
    const start = starts[starts.length - 1];
    return { start, end: start + schedule.windowMin * MIN };
  }

  /** The first start strictly after nowMs. */
  function nextStart(schedule, nowMs) {
    if (schedule.type === 'every') {
      const p = schedule.periodMin * MIN, o = schedule.offsetMin * MIN;
      return o + (Math.floor((nowMs - o) / p) + 1) * p;
    }
    for (let d = Math.floor(nowMs / DAY); ; d++) {
      for (const m of schedule.startsUtc) {
        const s = d * DAY + m * MIN;
        if (s > nowMs) return s;
      }
    }
  }

  /** Events whose scheduled window contains nowMs, soonest to end first. */
  function happening(events, nowMs) {
    const out = [];
    for (const e of events) {
      const win = currentWindow(e.schedule, nowMs);
      if (win) out.push({ event: e, start: win.start, end: win.end });
    }
    return out.sort((a, b) => a.end - b.end || a.event.name.localeCompare(b.event.name));
  }

  /** Every start in (nowMs, nowMs + spanMs], in time order. */
  function upcoming(events, nowMs, spanMs) {
    const out = [];
    for (const e of events) {
      for (const s of occurrences(e.schedule, nowMs + 1, nowMs + spanMs + 1)) {
        if (s > nowMs) out.push({ event: e, start: s, end: s + e.schedule.windowMin * MIN });
      }
    }
    return out.sort((a, b) => a.start - b.start || a.event.name.localeCompare(b.event.name));
  }

  // ---- Day/night cycles and resets ----

  /** The phase at nowMs: { phase, start, end, next } where next is the following phase. */
  function cyclePhase(cycle, nowMs) {
    const P = cycle.periodMin * MIN, t = mod(nowMs, P);
    const phases = cycle.phases;
    for (let i = 0; i < phases.length; i++) {
      const ph = phases[i], into = mod(t - ph.startMin * MIN, P);
      if (into < ph.durMin * MIN) {
        const start = nowMs - into;
        return { phase: ph.name, start, end: start + ph.durMin * MIN, next: phases[(i + 1) % phases.length].name };
      }
    }
    throw new Error(`cycle ${cycle.id} does not cover its period`);
  }

  /** The next reset after nowMs. Rules: { type: 'every', periodMin, offsetMin } or { type: 'weekly', weekday (0 = Sunday), minuteUtc }. */
  function nextReset(rule, nowMs) {
    if (rule.type === 'every') return nextStart({ type: 'every', periodMin: rule.periodMin, offsetMin: rule.offsetMin, windowMin: 1 }, nowMs);
    const anchor = FIRST_MONDAY + mod(rule.weekday - 1, 7) * DAY + rule.minuteUtc * MIN;
    return anchor + (Math.floor((nowMs - anchor) / WEEK) + 1) * WEEK;
  }

  // ---- Player overrides for unverified schedules ----

  /** A copy of the event with its start offset replaced; everything downstream stays unaware. */
  function applyOverride(event, offsetMin) {
    if (!event.adjustable || event.schedule.type !== 'every') return event;
    return Object.assign({}, event, { schedule: Object.assign({}, event.schedule, { offsetMin }), adjusted: true });
  }

  /**
   * The offset implied by "I saw it start at hh:mm" (local clock): the most recent instant at or before
   * nowMs that showed that local time, reduced to the period. Seconds are ignored.
   */
  function offsetFromSeen(hh, mm, nowMs, periodMin) {
    const d = new Date(nowMs);
    let seen = null;
    for (let back = 0; back <= 2 && seen === null; back++) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, hh, mm, 0, 0).getTime();
      // In the hour that repeats when daylight saving ends, the same local time happens twice;
      // JavaScript returns the first, but the later one is the more recent sighting.
      for (const c of [t + HOUR, t]) {
        const l = new Date(c);
        if (c <= nowMs && l.getHours() === hh && l.getMinutes() === mm) { seen = c; break; }
      }
    }
    return { seenMs: seen, offsetMin: mod(Math.floor(seen / MIN), periodMin) };
  }

  const nudge = (offsetMin, delta, periodMin) => mod(offsetMin + delta, periodMin);

  // ---- Display helpers (the only code that depends on the local time zone) ----

  const pad = (n) => String(n).padStart(2, '0');
  const hm = (minutes) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

  /** "every 2 h from 01:15 UTC" or "daily at 00:00, 03:00 UTC". */
  function ruleText(schedule) {
    if (schedule.type === 'every') {
      const p = schedule.periodMin;
      const every = p % 60 === 0 ? `${p / 60} h` : `${p} min`;
      return `every ${every} from ${hm(schedule.offsetMin)} UTC`;
    }
    return `daily at ${schedule.startsUtc.map(hm).join(', ')} UTC`;
  }

  /** "2d 4h", "1h 05m", "12m 05s", "45s". Rounds down; negative values count as zero. */
  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${pad(m)}m`;
    if (m) return `${m}m ${pad(sec)}s`;
    return `${sec}s`;
  }

  /** A sortable key for the local calendar day of ms. */
  function localDayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** "Today", "Tomorrow" or a weekday name for the local day of ms, relative to nowMs. */
  function dayLabel(ms, nowMs, locale) {
    const n = new Date(nowMs), t = new Date(ms);
    const days = Math.round((Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - Date.UTC(n.getFullYear(), n.getMonth(), n.getDate())) / DAY);
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    return t.toLocaleDateString(locale, { weekday: 'long' });
  }

  const Schedule = {
    MIN, HOUR, DAY, WEEK, occurrences, currentWindow, nextStart, happening, upcoming, cyclePhase, nextReset,
    applyOverride, offsetFromSeen, nudge, ruleText, duration, localDayKey, dayLabel,
  };
  if (typeof module === 'object' && module.exports) module.exports = Schedule;
  else root.GW2Schedule = Schedule;
})(typeof globalThis !== 'undefined' ? globalThis : this);
