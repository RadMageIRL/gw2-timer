// Calendar files (iCalendar, RFC 5545) for the scheduled starts GW2 Timer shows. Pure: the file is a function
// of the events, the reader's choices and a clock passed in, so the page and the Node tests share this file
// unchanged and the same choices at the same instant give the same bytes.
//
// Every entry is one start taken from js/schedule.js itself (upcoming or nextStart), written in UTC with a
// "Z". There are no recurrence rules and no time zones: the game runs on UTC, so a calendar shows each start
// in its own local time, and a daylight-saving change cannot move one. A recurrence rule would save bytes
// but not faithfully repeat everything: an Adjust time, a later schedule revision or a 2-hour cycle (which
// calendars do not reliably repeat) would all be wrong. A file is bounded instead: at most MAX_ENTRIES.
(function (root) {
  'use strict';

  const MIN = 60000, DAY = 86400000;
  /** How far ahead a file reaches. 'next' is each event's next start; the others are spans after now. */
  const SPANS = { next: 0, '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY, '30d': 30 * DAY };
  const SPAN_SLUG = { next: 'next-start', '24h': 'next-24-hours', '3d': 'next-3-days', '7d': 'next-7-days', '30d': 'next-30-days' };
  /** Minutes before a start for the calendar's own alarm; 0 is none. */
  const ALARMS = [0, 5, 10, 15];
  const MAX_ENTRIES = 500;
  const PRODID = '-//RadMage Labs//GW2 Timer//EN';
  const UID_HOST = 'gw2-timer.radmagelabs.com';
  const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const KIND = { 'world-boss': 'world boss', meta: 'meta event' };

  const pad = (n) => String(n).padStart(2, '0');
  /** An instant as an iCalendar UTC date-time: 20261026T000000Z. */
  function utc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  }

  // TEXT values: control characters are dropped, then backslash, semicolon, comma and line breaks escaped.
  const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
  const text = (s) => String(s).replace(CONTROL, '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');

  /**
   * One content line folded at 75 octets of UTF-8; continuation lines start with a space. A fold never splits
   * a character, nor an escape such as "\," (the standard allows that, but some readers do not take it well).
   * Every backslash in a line here starts an escape: text() escapes the backslashes of the text itself.
   */
  function fold(line) {
    const chars = Array.from(line);
    let out = '', len = 0;
    for (let i = 0; i < chars.length; i++) {
      let unit = chars[i];
      if (unit === '\\' && i + 1 < chars.length) unit += chars[++i];
      let n = 0;
      for (const ch of unit) { const cp = ch.codePointAt(0); n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4; }
      if (len + n > 75) { out += '\r\n '; len = 1; }
      out += unit; len += n;
    }
    return out;
  }

  /** What an entry's title adds after the name: the reader's own time, or how sure the schedule is (as the page's reminders say it). */
  function note(e) {
    if (e.adjusted) return 'your adjusted time';
    if (e.status === 'unverified' || e.status === 'disputed') return 'time unverified';
    if (e.status === 'recheck') return 'time may have changed';
    return '';
  }
  const STATUS_LINE = {
    disputed: 'Unverified: sources disagree on this time.',
    unverified: 'Unverified: new or thinly sourced, and not yet checked in game.',
    recheck: 'Recheck: a game update may have changed this time. It is the previous schedule until checked.',
  };

  const uid = (e, start) => `${e.id}-${utc(start)}@${UID_HOST}`;
  // An event the file can describe: an id fit for a UID, a name, a window, and a schedule with a start in every day.
  const usable = (e) => Boolean(e) && typeof e.id === 'string' && ID.test(e.id) && typeof e.name === 'string' && e.name.trim() !== ''
    && Boolean(e.schedule) && Number.isInteger(e.schedule.windowMin) && e.schedule.windowMin > 0
    && (e.schedule.type === 'every' ? Number.isInteger(e.schedule.periodMin) && e.schedule.periodMin > 0
      : e.schedule.type === 'daily' && Array.isArray(e.schedule.startsUtc) && e.schedule.startsUtc.length > 0);

  /**
   * The entries a file would hold: { ok, reason, count, entries: [{ event, start, end, uid }] }, in time order
   * (ties by event id). An event given twice counts once, and so does a start. reason: 'span' (unknown span),
   * 'event' (an event without an id, a name, a window or a usable schedule), 'empty' (no events), 'none' (no
   * start in the span), 'too-many' (over MAX_ENTRIES; count says how many it would be).
   */
  function plan({ events, engine, now, span }) {
    const fail = (reason, count = 0) => ({ ok: false, reason, count, entries: [] });
    if (!Object.prototype.hasOwnProperty.call(SPANS, span)) return fail('span');
    if (!Array.isArray(events) || !Number.isFinite(now)) return fail('event');
    const list = [], ids = new Set();
    for (const e of events) {
      if (!usable(e)) return fail('event');
      if (!ids.has(e.id)) { ids.add(e.id); list.push(e); }
    }
    if (!list.length) return fail('empty');
    const found = span === 'next' ? list.map((e) => ({ event: e, start: engine.nextStart(e.schedule, now) })) : engine.upcoming(list, now, SPANS[span]);
    const seen = new Set(), entries = [];
    for (const it of found) {
      const u = uid(it.event, it.start);
      if (!Number.isFinite(it.start) || seen.has(u)) continue;
      seen.add(u);
      entries.push({ event: it.event, start: it.start, end: it.start + it.event.schedule.windowMin * MIN, uid: u });
    }
    entries.sort((a, b) => a.start - b.start || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0));
    if (!entries.length) return fail('none');
    if (entries.length > MAX_ENTRIES) return fail('too-many', entries.length);
    return { ok: true, reason: null, count: entries.length, entries };
  }

  function vevent(it, stamp, alarmMin, meta, link) {
    const e = it.event, n = note(e), name = `GW2: ${e.name}${n ? ` (${n})` : ''}`;
    const about = [
      `Scheduled start of the Guild Wars 2 ${KIND[e.kind] || 'event'} ${e.name}${e.map ? `, in ${e.map}` : ''}.`,
      `Its scheduled window is ${e.schedule.windowMin} minutes. Scheduled, not live: the game has no public live-event feed, so a map can run early, late, fail or close.`,
      e.adjusted ? 'This start is the time you set with Adjust in GW2 Timer, not the default schedule.' : null,
      STATUS_LINE[e.status] || null,
      e.waypoint && e.waypoint.chat ? `Waypoint: ${e.waypoint.name ? `${e.waypoint.name} ` : ''}${e.waypoint.chat}` : null,
      meta && meta.datasetRevision ? `GW2 Timer schedule r${meta.datasetRevision}${meta.reviewedThroughPatch ? `, checked against game updates through ${meta.reviewedThroughPatch}` : ''}.` : null,
      link ? `Details: ${link(e.id)}` : null,
    ].filter(Boolean).join('\n');
    return [
      'BEGIN:VEVENT',
      `UID:${it.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${utc(it.start)}`,
      `DTEND:${utc(it.end)}`,
      `SUMMARY:${text(name)}`,
      ...(e.map ? [`LOCATION:${text(`${e.map} (Guild Wars 2)`)}`] : []),
      `DESCRIPTION:${text(about)}`,
      ...(link ? [`URL:${link(e.id)}`] : []),
      ...(n ? ['STATUS:TENTATIVE'] : []),
      'TRANSP:TRANSPARENT',
      ...(alarmMin ? ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${text(`GW2: ${e.name} starts in ${alarmMin} minutes`)}`, `TRIGGER:-PT${alarmMin}M`, 'END:VALARM'] : []),
      'END:VEVENT',
    ];
  }

  /**
   * The calendar file for { events, engine, now, span, alarmMin, meta, link }: plan()'s answer plus `text`
   * (CRLF lines, folded, ending in CRLF) and `uncertain` (the events whose entries carry a note, once each).
   * `now` is also the file's DTSTAMP (to the second). `link(id)`, when given, is each entry's URL. An alarm
   * that is not one of ALARMS is refused (reason 'alarm'); nothing is guessed.
   */
  function build(opts) {
    const alarmMin = opts.alarmMin === undefined ? 0 : opts.alarmMin;
    if (!ALARMS.includes(alarmMin)) return { ok: false, reason: 'alarm', count: 0, entries: [], text: '', uncertain: [] };
    const p = plan(opts);
    if (!p.ok) return Object.assign(p, { text: '', uncertain: [] });
    const stamp = utc(Math.floor(opts.now / 1000) * 1000);
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:GW2 Timer',
      ...p.entries.flatMap((it) => vevent(it, stamp, alarmMin, opts.meta, opts.link)), 'END:VCALENDAR'];
    const uncertain = [];
    for (const it of p.entries) if (note(it.event) && !uncertain.includes(it.event)) uncertain.push(it.event);
    return Object.assign(p, { text: lines.map(fold).join('\r\n') + '\r\n', uncertain });
  }

  /** A file name of lowercase letters, digits and hyphens: gw2-timer-<event>.ics, gw2-timer-starred-next-7-days.ics, gw2-timer-3-events-next-24-hours.ics. */
  function filename({ scope, span, events }) {
    const slug = SPAN_SLUG[span] || 'events';
    const one = Array.isArray(events) && events.length === 1 && usable(events[0]) ? events[0].id : null;
    if (one && scope !== 'starred') return `gw2-timer-${one}${span === 'next' ? '' : `-${slug}`}.ics`;
    if (scope === 'starred') return `gw2-timer-starred-${slug}.ics`;
    return `gw2-timer-${Array.isArray(events) ? events.length : 0}-events-${slug}.ics`;
  }

  const Ics = { SPANS, ALARMS, MAX_ENTRIES, PRODID, utc, text, fold, note, plan, build, filename };
  if (typeof module === 'object' && module.exports) module.exports = Ics;
  else root.GW2Ics = Ics;
})(typeof globalThis !== 'undefined' ? globalThis : this);
