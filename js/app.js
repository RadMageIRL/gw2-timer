// GW2 Timer page. Reads the generated dataset (events-data.js) and the pure helpers in schedule.js,
// store.js, news.js, clock.js, search.js, link.js, reminders.js and ics.js; everything here is display and input. The DOM is built
// with createElement only: no outside text is ever parsed as HTML.
(function () {
  'use strict';

  const S = window.GW2Schedule, Store = window.GW2Store, News = window.GW2News, Clock = window.GW2Clock, Search = window.GW2Search, Link = window.GW2Link, R = window.GW2Reminders, Ics = window.GW2Ics, DATA = window.GW2_DATA;
  const $ = (id) => document.getElementById(id);
  const storage = (() => { try { return window.localStorage; } catch (e) { return null; } })();

  const EVENTS = DATA.events;
  const BY_ID = new Map(EVENTS.map((e) => [e.id, e]));
  const REGIONS = DATA.regions;
  const REGION = new Map(REGIONS.map((r) => [r.id, r]));
  const KIND_LABEL = { 'world-boss': 'World boss', meta: 'Meta event' };
  const SOON_MS = 10 * S.MIN; // a start this close is highlighted in Coming up

  let prefs = Store.sanitizePrefs(Store.read(storage, 'prefs'), EVENTS.map((e) => e.id), REGIONS.map((r) => r.id));
  let overrides = Store.sanitizeOverrides(Store.read(storage, 'overrides'), EVENTS);
  const openAdjust = new Set();
  let clockOffset = 0;
  const nowMs = () => Date.now() + clockOffset;

  const savePrefs = () => Store.write(storage, 'prefs', prefs);
  const saveOverrides = () => Store.write(storage, 'overrides', overrides);

  // ---- Small DOM helper ----

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  // ---- Time formatting (rebuilt when the device time zone changes) ----

  let fmt = null;
  function formats() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!fmt || fmt.zone !== zone) {
      fmt = {
        zone,
        time: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }),
        clock: new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
        weekdayTime: new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
        utc: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }),
        utcClock: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC' }),
        day: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }),
        newsDay: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }),
        stamp: new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      };
    }
    return fmt;
  }
  // A dataset date ("2026-10-25") shown as a calendar date, the same in every time zone.
  const isoDay = (iso) => formats().day.format(new Date(iso + 'T12:00:00Z'));

  // ---- Which events show ----

  // Find narrows what the saved filters show. The query is never saved: not in prefs, not in the address.
  const SEARCH_ENTRIES = EVENTS.map((e) => ({ id: e.id, index: Search.forEvent(e, REGION.get(e.region)) }));
  let query = '', found = null; // found: the ids the query finds, or null when there is no query

  const effective = () => EVENTS.map((e) => (overrides[e.id] ? S.applyOverride(e, overrides[e.id].offsetMin) : e));
  function shown(list) {
    const regions = new Set(prefs.regions), hidden = new Set(prefs.hidden), starred = new Set(prefs.starred);
    return list.filter((e) => !hidden.has(e.id) && regions.has(e.region)
      && (prefs.filter === 'all' || (prefs.filter === 'starred' ? starred.has(e.id) : e.kind === prefs.filter))
      && (!found || found.has(e.id)));
  }

  // ---- Pieces shared by cards and rows ----

  function badges(e) {
    const out = [h('span', { class: `badge kind-${e.kind}`, text: KIND_LABEL[e.kind] })];
    if (e.status === 'unverified' || e.status === 'disputed') {
      const why = e.status === 'disputed' ? 'Sources disagree on this time.' : 'New schedule, not yet checked in game.';
      out.push(h('span', { class: 'badge warn', title: `${why} If you see it start at another time, use Adjust.`, text: 'Unverified' }));
    }
    if (e.status === 'recheck' && e.flag) {
      out.push(h('span', { class: 'badge warn', title: `The ${isoDay(e.flag.patch)} game update may have changed this time. It shows the previous schedule until checked.`, text: 'Recheck' }));
    }
    if (e.adjusted) out.push(h('span', { class: 'badge adjusted', title: 'You set this start time with Adjust.', text: 'Adjusted' }));
    return out;
  }

  const wikiUrl = (e) => (e.wiki
    ? 'https://wiki.guildwars2.com/wiki/' + encodeURIComponent(e.wiki.replace(/ /g, '_')).replace(/%2F/g, '/')
    : 'https://wiki.guildwars2.com/index.php?title=Special:Search&go=Go&search=' + encodeURIComponent(e.name));

  function actions(e, key) {
    const out = [
      h('button', { type: 'button', class: 'btn small copy', 'data-copy': e.id, 'data-fkey': `${key}:copy`, 'aria-label': `Copy waypoint for ${e.name}: ${e.waypoint.chat}`, title: `${e.waypoint.name} ${e.waypoint.chat}`, text: 'Copy waypoint' }),
      h('a', { class: 'btn small', href: wikiUrl(e), target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${e.name} on the Guild Wars 2 Wiki (opens a new tab)`, text: 'Wiki' }),
      h('button', { type: 'button', class: 'btn small', 'data-hide': e.id, 'data-fkey': `${key}:hide`, 'aria-label': `Hide ${e.name}`, text: 'Hide' }),
    ];
    if (e.adjustable) out.push(h('button', { type: 'button', class: 'btn small adjust', 'data-adjust': e.id, 'data-fkey': `${key}:adjust`, 'aria-expanded': openAdjust.has(e.id) ? 'true' : 'false', 'aria-controls': `adjust-${e.id}`, 'aria-label': `Adjust the start time of ${e.name}`, text: 'Adjust' }));
    return h('div', { class: 'actions' }, out);
  }
  const isStarred = (e) => prefs.starred.includes(e.id);

  /** An event's name as a link to its details (#event/<id>); a click opens the details dialog. */
  const nameLink = (e, key, cls) => h('a', { class: `event-link${cls ? ' ' + cls : ''}`, href: Link.fragment(e.id), 'aria-haspopup': 'dialog', 'data-fkey': `${key}:name`, text: e.name });

  function star(e, key) {
    const on = prefs.starred.includes(e.id);
    return h('button', { type: 'button', class: 'star-btn' + (on ? ' on' : ''), 'data-star': e.id, 'data-fkey': `${key}:star`, 'aria-pressed': on ? 'true' : 'false', 'aria-label': `Star ${e.name}`, title: on ? 'Starred' : 'Star', text: on ? '★' : '☆' });
  }

  // An event can be both in its window and coming up again; its panel shows once, at the first place.
  const panelShown = new Set();
  function adjustPanel(e) {
    if (!e.adjustable || !openAdjust.has(e.id) || panelShown.has(e.id)) return null;
    panelShown.add(e.id);
    const base = BY_ID.get(e.id);
    const o = overrides[e.id];
    return h('div', { class: 'adjust-panel', id: `adjust-${e.id}`, 'data-panel': e.id },
      h('p', { class: 'adj-rule' }, `Default: ${S.ruleText(base.schedule)}.`, o ? h('span', { class: 'adj-now' }, ` Yours: ${S.ruleText(Object.assign({}, base.schedule, { offsetMin: o.offsetMin }))}.`) : null),
      h('div', { class: 'adj-controls' },
        h('label', { class: 'field' }, 'I saw it start at ', h('input', { type: 'time', class: 'adj-time', 'data-adj-input': e.id, 'data-fkey': `adj:${e.id}:input` })),
        h('button', { type: 'button', class: 'btn small', 'data-adj-set': e.id, 'data-fkey': `adj:${e.id}:set`, text: 'Set' }),
        h('button', { type: 'button', class: 'btn small', 'data-adj-nudge': `${e.id}:-5`, 'data-fkey': `adj:${e.id}:minus`, 'aria-label': 'Five minutes earlier', text: '-5 min' }),
        h('button', { type: 'button', class: 'btn small', 'data-adj-nudge': `${e.id}:5`, 'data-fkey': `adj:${e.id}:plus`, 'aria-label': 'Five minutes later', text: '+5 min' }),
        o ? h('button', { type: 'button', class: 'btn small', 'data-adj-reset': e.id, 'data-fkey': `adj:${e.id}:reset`, text: 'Reset to default' }) : null),
      h('p', { class: 'adj-help', text: 'The cycle length stays the same; every later start follows the time you set. Saved in this browser only.' }));
  }

  const regionShort = (e) => REGION.get(e.region).short;
  const utcText = (ms) => (prefs.showUtc ? `${formats().utc.format(ms)} UTC` : null);

  // ---- Scheduled now (cards) ----

  function card(item) {
    const e = item.event, f = formats(), key = `now:${e.id}`;
    return h('article', { class: 'event is-active' + (isStarred(e) ? ' is-starred' : ''), 'data-kind': e.kind, 'data-id': e.id },
      h('div', { class: 'event-head' }, star(e, key), h('h3', {}, nameLink(e, key))),
      h('div', { class: 'badges' }, badges(e), h('span', { class: 'where', text: `${e.map} · ${regionShort(e)}` })),
      h('p', { class: 'countdown' },
        h('span', { class: 'big', 'data-until': item.end, 'data-prefix': 'Window closes in ' }, 'Window closes in ' + S.duration(item.end - nowMs()))),
      h('p', { class: 'since' }, `Started ${f.time.format(item.start)}`, utcText(item.start) ? ` · ${utcText(item.start)}` : ''),
      e.note ? h('p', { class: 'note', text: e.note }) : null,
      actions(e, key),
      adjustPanel(e));
  }

  // ---- Coming up (rows) ----

  function row(item, now) {
    const e = item.event, f = formats(), key = `next:${e.id}:${item.start}`;
    // The visual Today/Tomorrow breaks are hidden from screen readers, so a later day is said in the row.
    const day = S.localDayKey(item.start) !== S.localDayKey(now) ? S.dayLabel(item.start, now) : null;
    return h('li', { class: 'row' + (isStarred(e) ? ' is-starred' : ''), 'data-kind': e.kind, 'data-id': e.id, 'data-start': item.start },
      h('div', { class: 'when' },
        day ? h('span', { class: 'sr-only', text: `${day}, ` }) : null,
        h('span', { class: 't', text: f.time.format(item.start) }),
        h('span', { class: 'in' + (item.start - now <= SOON_MS ? ' soon' : ''), 'data-until': item.start, 'data-prefix': 'in ' }, 'in ' + S.duration(item.start - now)),
        utcText(item.start) ? h('span', { class: 'utc', text: utcText(item.start) }) : null),
      h('div', { class: 'what' },
        h('div', { class: 'line1' }, star(e, key), nameLink(e, key, 'name'), badges(e)),
        h('div', { class: 'line2', text: `${e.map} · ${regionShort(e)} · runs about ${e.schedule.windowMin} min` }),
        e.note ? h('p', { class: 'note', text: e.note }) : null),
      actions(e, key),
      adjustPanel(e));
  }

  function rowsWithDays(items, now) {
    const out = [];
    let lastDay = S.localDayKey(now);
    for (const it of items) {
      const day = S.localDayKey(it.start);
      if (day !== lastDay) { out.push(h('li', { class: 'day-sep', 'aria-hidden': 'true', text: S.dayLabel(it.start, now) })); lastDay = day; }
      out.push(row(it, now));
    }
    return out;
  }

  // ---- The strip: day and night, resets ----

  function stripItems(now) {
    const f = formats(), out = [];
    for (const c of DATA.cycles) {
      const p = S.cyclePhase(c, now);
      out.push(h('li', { class: `cycle phase-${p.phase.toLowerCase()}`, title: c.maps },
        h('span', { class: 'label', text: c.name }),
        h('span', { class: 'value', text: p.phase }),
        h('span', { class: 'sub', 'data-until': p.end, 'data-prefix': `${p.next} in ` }, `${p.next} in ${S.duration(p.end - now)}`)));
    }
    for (const r of DATA.resets) {
      const at = S.nextReset(r.rule, now);
      out.push(h('li', { class: 'reset' },
        h('span', { class: 'label', text: r.name }),
        h('span', { class: 'value', text: r.rule.type === 'weekly' ? f.weekdayTime.format(at) : f.time.format(at) }),
        h('span', { class: 'sub', 'data-until': at, 'data-prefix': 'in ' }, 'in ' + S.duration(at - now))));
    }
    return out;
  }

  // ---- Render: a full rebuild only when what is listed changes; countdown text every second ----

  let lastKey = '';
  function structureKey(now, nowItems, nextItems) {
    return [query, prefs.filter, prefs.regions.join(), prefs.starred.join(), prefs.hidden.join(), prefs.aheadMin, prefs.compact, prefs.showUtc,
      JSON.stringify(overrides), [...openAdjust].join(), formats().zone, S.localDayKey(now),
      nowItems.map((i) => i.event.id + i.start).join(), nextItems.map((i) => i.event.id + i.start).join(),
      DATA.cycles.map((c) => S.cyclePhase(c, now).phase).join(), DATA.resets.map((r) => S.nextReset(r.rule, now)).join()].join('|');
  }

  const NO_STARS = 'No events are starred yet. To star one, set Show to All, then select the star (☆) by its name.';

  function render(force) {
    const now = nowMs(), f = formats();
    $('local-time').textContent = f.clock.format(now);
    $('utc-time').textContent = prefs.showUtc ? `${f.utcClock.format(now)} UTC` : f.zone;
    const all = effective();
    const list = shown(all);
    const nowItems = S.happening(list, now);
    const nextItems = S.upcoming(list, now, prefs.aheadMin * S.MIN);
    const key = structureKey(now, nowItems, nextItems);
    if (force || key !== lastKey) {
      lastKey = key;
      const focusKey = document.activeElement && document.activeElement.getAttribute('data-fkey');
      const typed = new Map([...document.querySelectorAll('[data-adj-input]')].map((i) => [i.getAttribute('data-fkey'), i.value]));
      panelShown.clear();
      $('strip').replaceChildren(...stripItems(now));
      const starred = new Set(prefs.starred);
      // Starred events come first in both lists; otherwise the order is unchanged.
      const nowSorted = nowItems.filter((i) => starred.has(i.event.id)).concat(nowItems.filter((i) => !starred.has(i.event.id)));
      $('now-list').replaceChildren(...nowSorted.map(card));
      $('now-empty').hidden = nowItems.length > 0;
      // Starred with nothing starred says how to star; a search that leaves a list empty says so.
      const noStars = prefs.filter === 'starred' && !prefs.starred.length;
      $('now-empty').textContent = noStars ? NO_STARS : found ? 'Nothing that matches your search is in its scheduled window right now.' : 'Nothing you follow is in its scheduled window right now.';
      $('next-empty').textContent = noStars ? NO_STARS : found ? 'Nothing that matches your search starts in this time span.' : 'Nothing you follow starts in this time span.';
      const top = prefs.filter === 'starred' ? [] : nextItems.filter((i) => starred.has(i.event.id));
      const rest = prefs.filter === 'starred' ? nextItems : nextItems.filter((i) => !starred.has(i.event.id));
      const rows = [];
      if (top.length) rows.push(h('li', { class: 'group', text: 'Starred' }), ...rowsWithDays(top, now), h('li', { class: 'group', text: 'Everything else' }));
      rows.push(...rowsWithDays(rest, now));
      $('next-list').replaceChildren(...rows);
      $('next-empty').hidden = nextItems.length > 0;
      $('coming-hint').textContent = `next ${prefs.aheadMin / 60} ${prefs.aheadMin === 60 ? 'hour' : 'hours'}, your time (${f.zone})`;
      for (const i of document.querySelectorAll('[data-adj-input]')) { const v = typed.get(i.getAttribute('data-fkey')); if (v) i.value = v; }
      if (focusKey) { const el = document.querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`); if (el) el.focus(); }
      renderNotes();
    }
    for (const el of document.querySelectorAll('[data-until]')) {
      const left = Number(el.getAttribute('data-until')) - now;
      const t = el.getAttribute('data-prefix') + S.duration(left);
      if (el.textContent !== t) el.textContent = t;
      if (el.classList.contains('in')) el.classList.toggle('soon', left <= SOON_MS);
    }
    const listed = new Set(nowItems.concat(nextItems).map((i) => i.event.id));
    renderFind(now, all, listed);
    renderEventDialog(now, listed);
    syncCalendar();
  }

  // ---- Find: what the query matches, and why a match has no row ----

  const SHOW_LABEL = { 'world-boss': 'World bosses', meta: 'Meta events', starred: 'Starred' };
  const MAX_NAMED = 5; // matches named in the status line; the rest are counted

  /** The saved settings that leave an event out of both lists (none when they all let it in). */
  function settingReasons(e) {
    const out = [];
    if (prefs.hidden.includes(e.id)) out.push('on your Hidden list');
    if (!prefs.regions.includes(e.region)) out.push(`${REGION.get(e.region).name} is off in Regions`);
    if (prefs.filter === 'starred' && !prefs.starred.includes(e.id)) out.push('not starred, and Show is set to Starred');
    else if (prefs.filter !== 'all' && prefs.filter !== 'starred' && e.kind !== prefs.filter) out.push(`Show is set to ${SHOW_LABEL[prefs.filter]}`);
    return out;
  }
  const spanReason = () => `starts after the ${prefs.aheadMin === 60 ? '1 hour' : `${prefs.aheadMin / 60} hours`} shown in Coming up`;

  /** Why an event the query finds has no card and no row: the settings that leave it out, or the span. */
  function whyNotListed(e) {
    const out = settingReasons(e);
    return out.length ? out : [spanReason()];
  }

  /** In its window now, or its next start: as a sentence, and the instant it stops being true. */
  function whenText(e, now) {
    const f = formats(), win = S.currentWindow(e.schedule, now);
    const at = win ? win.end : S.nextStart(e.schedule, now);
    const utc = prefs.showUtc ? ` (${f.utc.format(at)} UTC)` : '';
    if (win) return { at, text: `In its scheduled window now, until ${f.time.format(at)}${utc}.` };
    const day = S.localDayKey(at) === S.localDayKey(now) ? '' : S.dayLabel(at, now) === 'Tomorrow' ? 'tomorrow ' : `${S.dayLabel(at, now)} `;
    return { at, text: `Next ${day}at ${f.time.format(at)}${utc}.` };
  }

  /** The status line's sentences: how many events match, then each match without a row, and why. */
  function findStatus(now, all, listed) {
    if (!found) return null;
    const n = found.size;
    if (!n) return { lead: 'No event matches. Try part of a name, a map or a region.', items: [], more: '' };
    const missing = all.filter((e) => found.has(e.id) && !listed.has(e.id)).map((e) => ({ e, when: whenText(e, now) }))
      .sort((a, b) => a.when.at - b.when.at || a.e.name.localeCompare(b.e.name));
    const u = missing.length, events = n === 1 ? '1 event matches' : `${n} events match`;
    const lead = !u ? `${events}.` : u === n ? `${events}, but ${n === 1 ? 'it is not' : 'none is'} in your lists:` : `${events}; ${u} ${u === 1 ? 'is' : 'are'} not in your lists:`;
    const items = missing.slice(0, MAX_NAMED).map(({ e, when }) => ({ e, name: e.name, text: `: ${whyNotListed(e).join('; ')}. ${when.text}` }));
    return { lead, items, more: u > MAX_NAMED ? `And ${u - MAX_NAMED} more not in your lists.` : '' };
  }

  // The status is a polite live region, so it changes only when what it says changes, and while the
  // reader is typing it waits for a pause: one announcement per search, not one per letter.
  let statusText = '', statusHeld = false;
  function renderFind(now, all, listed) {
    if (statusHeld) return;
    const s = findStatus(now, all, listed);
    const text = s ? [s.lead, ...s.items.map((i) => i.name + i.text), s.more].join(' ') : '';
    if (text === statusText) return;
    statusText = text;
    // A match without a row can still be looked at: its name opens its details (Phase D).
    const focusKey = $('find-status').contains(document.activeElement) && document.activeElement.getAttribute('data-fkey');
    $('find-status').replaceChildren(...(s ? [
      h('p', { text: s.lead }),
      s.items.length ? h('ul', {}, s.items.map((i) => h('li', {}, nameLink(i.e, `find:${i.e.id}`, 'name'), i.text))) : null,
      s.more ? h('p', { text: s.more }) : null].filter(Boolean) : []));
    if (focusKey) { const el = document.querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`); if (el) el.focus(); }
  }

  let queryTimer = 0, statusTimer = 0;
  function setQuery(text) {
    const q = String(text || '').trim().slice(0, Search.MAX_QUERY);
    if (q === query) return;
    query = q;
    found = Search.words(q).length ? new Set(Search.find(SEARCH_ENTRIES, q)) : null;
    render(true);
  }
  /** Applies the field at once (Enter, Escape, Clear) instead of after the typing pause. */
  function findNow(value) {
    clearTimeout(queryTimer); clearTimeout(statusTimer);
    statusHeld = false;
    $('find').value = value;
    $('find-clear').hidden = !value;
    setQuery(value);
    render();
  }
  $('find').addEventListener('input', (ev) => {
    $('find-clear').hidden = !ev.target.value;
    clearTimeout(queryTimer); clearTimeout(statusTimer);
    statusHeld = true;
    queryTimer = setTimeout(() => setQuery($('find').value), 150);
    statusTimer = setTimeout(() => { statusHeld = false; render(); }, 500);
  });
  $('find').addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && ev.target.value) { ev.preventDefault(); findNow(''); }
    else if (ev.key === 'Enter') { ev.preventDefault(); findNow(ev.target.value); }
  });

  // ---- Two modes in this one page: Event Timers (the default) and the Trading Post ("#market") ----
  // The switch shows one view and hides the other. Nothing reloads and nothing is lost: each view keeps its
  // search, filters, sort and place on the page, and the timer, reminders included, keeps running under the
  // Trading Post. A click on the switch adds one history entry ("#market", or the page's own address for
  // Event Timers), so Back and Forward move between the modes. The Trading Post's code and its item list
  // load the first time it opens, never with the timer, so the timer's first load asks the API for nothing.

  const ASSET_Q = (() => { try { return new URL(document.currentScript.src).search; } catch (e) { return ''; } })();
  const MARKET_FILES = [['js/money.js', 'GW2Money'], ['js/catalog.js', 'GW2Catalog'], ['js/api.js', 'GW2Api'], ['js/market.js', 'GW2Market']];
  let mode = 'timers', market = null, marketLoading = null;
  const place = { timers: 0, market: 0 };
  const VIEW = { timers: 'timers-view', market: 'market-view' };
  /** The heading focus goes to when the control that had it is gone: Coming up, or the Trading Post's. */
  const viewHeading = () => $(mode === 'market' ? 'market-title' : 'coming-title');

  /** The mode an address asks for: "#market..." the Trading Post; no fragment, Event Timers; an element's id, its view's; else none. */
  function modeOf(hash) {
    const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
    if (/^market(?:\/|$)/.test(raw)) return 'market';
    if (!raw) return 'timers';
    if (raw.startsWith(Link.PREFIX)) return null; // one event's details, over either mode
    const el = /^[A-Za-z][\w-]{0,40}$/.test(raw) ? document.getElementById(raw) : null;
    return el && $('market-view').contains(el) ? 'market' : el && $('timers-view').contains(el) ? 'timers' : null;
  }

  function loadMarket() {
    if (marketLoading) return marketLoading;
    $('tp-boot').hidden = false; $('tp-boot').textContent = 'Loading the Trading Post...'; $('tp-retry').hidden = true;
    // In parallel, run in order (async = false); a file that has already run is not loaded again on a retry.
    marketLoading = Promise.all(MARKET_FILES.filter(([, g]) => !window[g]).map(([f]) => new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = f + ASSET_Q; s.async = false;
      s.onload = ok; s.onerror = () => { s.remove(); fail(new Error(f)); };
      document.head.append(s);
    }))).then(() => {
      market = window.GW2Market.mount({ h, storage, Store, now: nowMs, copyText, canonical: Link.CANONICAL, version: ASSET_Q });
      return market;
    }, (e) => {
      marketLoading = null;
      $('tp-boot').textContent = 'The Trading Post could not load. Check your connection and try again. The timer is not affected.';
      $('tp-retry').hidden = false;
      throw e;
    });
    return marketLoading;
  }
  $('tp-retry').addEventListener('click', () => { if (!market) loadMarket().then((m) => m.shown(), () => {}); });

  /** Shows `next`, keeping each view's place on the page; the first Trading Post opening loads it. */
  function setMode(next) {
    if (next !== mode) {
      const from = $(VIEW[mode]), hadFocus = from.contains(document.activeElement);
      place[mode] = window.scrollY;
      mode = next;
      $('timers-view').hidden = next !== 'timers';
      $('market-view').hidden = next !== 'market';
      for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-mode') === next));
      for (const a of document.querySelectorAll('[data-skip]')) a.hidden = a.getAttribute('data-skip') !== next;
      if (next === 'timers') render(true);
      window.scrollTo(0, place[next]);
      // Focus that was inside the view just hidden goes to the switch, which is where the reader is.
      if (hadFocus) document.querySelector(`button[data-mode="${next}"]`).focus({ preventScroll: true });
    }
    if (next === 'market') loadMarket().then((m) => m.shown(), () => {});
  }
  // A link names an event and nothing else. Opening one shows the reader's own view of it (their Adjust
  // time, their star) and changes no setting. A click on a name adds one history entry, so Back closes
  // the details and Forward opens them again; closing takes the event out of the address.

  const IDS = EVENTS.map((e) => e.id);
  const dialog = $('event-dialog');
  let dialogId = null, dialogKey = '', opener = null, closingByHash = false;

  const CONFIDENCE = {
    documented: 'Documented: at least two independent written sources agree on this time. It has not been checked in game.',
    confirmed: 'Confirmed in game: the start was seen in game and matched the schedule within two minutes.',
    disputed: 'Unverified: sources disagree on this time. If you see it start at another time, use Adjust on the event.',
    unverified: 'Unverified: new or thinly sourced, and not yet checked in game. If you see it start at another time, use Adjust on the event.',
  };
  const confidence = (e) => (e.status === 'recheck' && e.flag
    ? `Recheck: the ${isoDay(e.flag.patch)} game update may have changed this time. It shows the previous schedule until checked.`
    : CONFIDENCE[e.status] || '');
  const effectiveOne = (id) => (overrides[id] ? S.applyOverride(BY_ID.get(id), overrides[id].offsetMin) : BY_ID.get(id));

  /** The details of one event: where, when next (or until when now), how sure, and why it has no row. */
  function dialogBody(e, now, listed) {
    const f = formats(), base = BY_ID.get(e.id), o = overrides[e.id];
    const win = S.currentWindow(e.schedule, now);
    const at = win ? win.end : S.nextStart(e.schedule, now);
    const utc = utcText(at) ? ` (${utcText(at)})` : '';
    const day = !win && S.localDayKey(at) !== S.localDayKey(now) ? `${S.dayLabel(at, now)} ` : '';
    const when = win
      ? h('p', { class: 'ed-when', id: 'event-dialog-when' }, 'Scheduled now, until ', h('strong', { text: f.time.format(at) }), `${utc}. `,
        h('span', { class: 'ed-left', 'data-until': at, 'data-prefix': 'Window closes in ' }, 'Window closes in ' + S.duration(at - now)), '.')
      : h('p', { class: 'ed-when', id: 'event-dialog-when' }, 'Next scheduled start: ', h('strong', { text: `${day}${f.time.format(at)}` }), `${utc}, `,
        h('span', { class: 'ed-left', 'data-until': at, 'data-prefix': 'in ' }, 'in ' + S.duration(at - now)), '.');
    const rule = `${S.ruleText(e.schedule)}, runs about ${e.schedule.windowMin} min`;
    const often = o ? `Yours, set with Adjust in this browser: ${rule}. Default: ${S.ruleText(base.schedule)}.` : `${rule[0].toUpperCase()}${rule.slice(1)}.`;
    const fact = (k, v) => [h('dt', { text: k }), h('dd', { text: v })];
    // Not in either list: every reason, as in the Find status (a listed event has none). The span is the
    // reason only when nothing else is.
    const reasons = (found && !found.has(e.id) ? ['it does not match your search'] : []).concat(settingReasons(e));
    if (!listed.has(e.id) && !reasons.length) reasons.push(spanReason());
    const on = isStarred(e);
    // The actions come right after the start, so a phone shows them without scrolling; the details follow.
    return [
      h('div', { class: 'badges' }, badges(e)),
      when,
      actionsRow(e, on),
      reasons.length ? h('p', { class: 'ed-why' }, h('strong', { text: 'Not in your lists right now: ' }), `${reasons.join('; ')}. Opening it here changed none of your settings.`) : null,
      h('dl', { class: 'ed-facts' },
        ...fact('Where', `${e.map}, ${REGION.get(e.region).name}`),
        ...fact('How often', often),
        ...fact('How sure', confidence(e))),
      h('p', { class: 'ed-live', text: 'Scheduled, not live: the game has no public live-event feed, so your map may be early, late, mid-fight, finished or failed.' }),
      e.note ? h('p', { class: 'note', text: e.note }) : null,
    ].filter(Boolean);
  }

  function actionsRow(e, on) {
    return h('div', { class: 'actions ed-actions' },
        h('button', { type: 'button', class: 'btn small ed-star' + (on ? ' on' : ''), 'data-star': e.id, 'data-fkey': 'dlg:star', 'aria-pressed': String(on), 'aria-label': `Star ${e.name}` },
          h('span', { 'aria-hidden': 'true', text: on ? '★' : '☆' }), ' Star'),
        h('button', { type: 'button', class: 'btn small copy', 'data-copy': e.id, 'data-fkey': 'dlg:copy', 'aria-label': `Copy waypoint for ${e.name}: ${e.waypoint.chat}`, title: `${e.waypoint.name} ${e.waypoint.chat}`, text: 'Copy waypoint' }),
        h('a', { class: 'btn small', href: wikiUrl(e), target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${e.name} on the Guild Wars 2 Wiki (opens a new tab)`, text: 'Wiki' }),
        h('button', { type: 'button', class: 'btn small', 'data-copy-link': e.id, 'data-fkey': 'dlg:link', 'aria-label': `Copy a link to ${e.name}`, text: 'Copy link' }),
        h('button', { type: 'button', class: 'btn small', 'data-calendar': e.id, 'data-fkey': 'dlg:calendar', 'aria-haspopup': 'dialog', 'aria-label': `Add to calendar: ${e.name}`, text: 'Add to calendar' }));
  }

  /** Rebuilds the open dialog only when what it says changes; its countdown ticks through data-until. */
  function renderEventDialog(now, listed) {
    if (!dialogId) return;
    const e = effectiveOne(dialogId), win = S.currentWindow(e.schedule, now);
    const key = [dialogId, win ? `w${win.end}` : S.nextStart(e.schedule, now), isStarred(e), JSON.stringify(overrides[dialogId] || 0), prefs.showUtc, formats().zone,
      S.localDayKey(now), listed.has(dialogId), query, prefs.filter, prefs.regions.join(), prefs.hidden.join(), prefs.aheadMin].join('|');
    if (key === dialogKey) return;
    dialogKey = key;
    const focusKey = dialog.contains(document.activeElement) && document.activeElement.getAttribute('data-fkey');
    $('event-dialog-title').textContent = e.name;
    $('event-dialog-body').replaceChildren(...dialogBody(e, now, listed));
    if (focusKey) { const el = dialog.querySelector(`[data-fkey="${CSS.escape(focusKey)}"]`); if (el) el.focus(); }
  }

  function openEvent(id) {
    showLinkNotice(null);
    if (!dialog.open) {
      const el = document.activeElement;
      opener = { el, fkey: el && el.getAttribute ? el.getAttribute('data-fkey') : null };
      for (const d of document.querySelectorAll('dialog[open]')) d.close(); // About or Hidden
    }
    dialogId = id; dialogKey = '';
    $('event-dialog-status').textContent = '';
    $('event-dialog-linkbox').hidden = true;
    render();
    if (!dialog.open) dialog.showModal();
    $('event-dialog-title').focus();
  }

  // Closing takes the event out of the address: back to the entry before it when a click on this page
  // added it, else the fragment is dropped in place, so a reload shows the reader's own page and Close
  // never leaves the site.
  const dropFragment = () => { try { history.replaceState(null, '', location.pathname + location.search + (mode === 'market' ? '#market' : '')); } catch (e) { /* the address keeps it */ } };
  // Where focus goes when the details close: the control that opened them; else that control drawn again
  // (starring rebuilds the lists); else the event's name in either list; else, when the event has left
  // the lists (unstarred under Starred, or hidden, filtered out or past the span), the Coming up heading.
  // Details opened straight from a link had no opener, and focus stays where the browser leaves it.
  const shownEl = (el) => (el && el.isConnected && el !== document.body && el.getClientRects().length ? el : null);
  function focusBack(from, id) {
    if (!from || (!from.fkey && (!from.el || from.el === document.body))) return null;
    return shownEl(from.el) || (from.fkey && shownEl(document.querySelector(`[data-fkey="${CSS.escape(from.fkey)}"]`)))
      || (id && shownEl(document.querySelector(`#now-list [data-fkey="now:${CSS.escape(id)}:name"], #next-list [data-fkey^="next:${CSS.escape(id)}:"][data-fkey$=":name"]`)))
      || viewHeading();
  }
  dialog.addEventListener('close', () => {
    // The close event comes a moment after the dialog closes (Chrome on Linux sends it as late as the next
    // rendering step). When Back closes the details and Forward opens them again before it comes, it
    // belongs to that earlier close: the details open now keep their event, their opener and the address.
    if (dialog.open) { closingByHash = false; return; }
    const id = dialogId;
    dialogId = null; dialogKey = '';
    if (!closingByHash && Link.parse(location.hash, IDS)) {
      if (history.state && history.state.gw2Event === id) history.back(); else dropFragment();
    }
    closingByHash = false;
    const back = focusBack(opener, id);
    opener = null;
    if (back) back.focus();
  });

  const LINK_NOTICE = {
    unknown: 'That link names an event this timer does not cover. It may have been renamed or removed. Nothing of yours was changed.',
    malformed: 'That link to an event could not be read. Nothing of yours was changed.',
  };
  /** Fixed sentences only: nothing from the link itself is ever written into the page. */
  function showLinkNotice(reason) {
    $('link-notice').hidden = !reason;
    $('link-notice-text').textContent = reason ? LINK_NOTICE[reason] || LINK_NOTICE.malformed : '';
  }

  /**
   * What the address asks for: the Trading Post ("#market", "#market/item/<id>"), one event's details over
   * either mode, an unusable event link, or Event Timers.
   */
  function readHash() {
    const m = modeOf(location.hash);
    if (m === 'market') {
      if (dialog.open) { closingByHash = true; dialog.close(); }
      showLinkNotice(null);
      setMode('market');
      loadMarket().then((mk) => mk.route(location.hash), () => {});
      return;
    }
    if (market) market.route(location.hash); // closes an item's details when the address leaves them
    const r = Link.parse(location.hash, IDS);
    if (r && r.ok) { openEvent(r.id); return; }
    if (m === 'timers' || (r && !r.ok)) setMode('timers');
    if (dialog.open) { closingByHash = true; dialog.close(); }
    showLinkNotice(r ? r.reason : null);
  }
  window.addEventListener('hashchange', readHash);

  // A plain click on an event's name opens its details in place; a click with a modifier key, a middle
  // click and "copy link address" keep the browser's own behavior.
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest ? ev.target.closest('a[href^="#event/"]') : null;
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
    const r = Link.parse(a.getAttribute('href'), IDS);
    if (!r || !r.ok) return;
    ev.preventDefault();
    try { history.pushState({ gw2Event: r.id }, '', Link.fragment(r.id)); } catch (e) { /* no history here: the details still open */ }
    openEvent(r.id);
  });

  // ---- Reminders: a notice on this page before a starred event starts (js/reminders.js decides) ----
  // A reminder ANNOUNCES an event's start, and that covers the event until the announced time: a reload,
  // another tab, a changed lead, a clock correction or a small Adjust never repeats it, and a start moved
  // later by the lead or more is reminded again at its own time (V0.3.0_REMINDERS_ALGORITHM.md, local).
  // Each start is claimed before anything is shown, under a Web Lock when the browser has them, and the
  // claim is saved (gw2-timer:v1:reminded), so the tabs of this site give it at most once. The notices,
  // the count in the title and the one announcement per batch belong to this tab and are never saved.
  // Nothing is written to storage on a quiet tick: only a won claim and a changed setting write.

  let rset = R.sanitize(Store.read(storage, 'reminders'));
  let unsaved = !storage; // a setting or a claim could not be saved: reminders last until this tab closes
  const TAB = (() => { try { return Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(36)).join(''); } catch (e) { return String(Math.random()).slice(2, 14); } })();
  const mem = {};             // what this tab has seen announced, so it never repeats itself even when storage fails
  let live = [];              // this tab's notices ({ id, target }), brought up to date by R.follow
  const claiming = new Set(); // events whose claim has not resolved: no second claim for them meanwhile
  const fresh = new Set();    // notices delivered since the tray was last drawn (only they slide in)
  let trayOpen = false, trayKey = '', listKey = '', listUntil = 0;
  const TITLE = document.title;
  const narrow = window.matchMedia ? window.matchMedia('(max-width: 640px)') : null;
  const foot = $('reminders-foot'); // Show more and Dismiss all: under the list, or on a phone in the first notice's row of buttons

  const readRecords = () => Store.read(storage, 'reminded');
  const writeRecords = (records) => Store.write(storage, 'reminded', records);
  const rctx = (now) => ({ events: EVENTS, overrides, starred: prefs.starred, hidden: prefs.hidden, settings: rset, now, engine: S });
  /** What a reminder adds after the name: the reader's own time, or how sure the schedule is. */
  const remNote = (e) => (e.adjusted ? 'your adjusted time'
    : e.status === 'unverified' || e.status === 'disputed' ? 'time unverified' : e.status === 'recheck' ? 'time may have changed' : '');
  const inMinutes = (ms) => { const m = Math.round(ms / S.MIN); return m < 1 ? 'in less than a minute' : m === 1 ? 'in 1 minute' : `in ${m} minutes`; };
  const dayWord = (ms, now) => (S.localDayKey(ms) === S.localDayKey(now) ? '' : S.dayLabel(ms, now) === 'Tomorrow' ? 'tomorrow ' : `${S.dayLabel(ms, now)} `);

  function syncReminders() {
    $('reminders-btn').textContent = rset.on ? `Reminders: ${rset.lead} min` : 'Reminders: off';
    $('reminders-on').checked = rset.on;
    for (const r of document.querySelectorAll('[name="reminders-lead"]')) r.checked = Number(r.value) === rset.lead;
    $('reminders-unsaved').hidden = !unsaved;
  }
  function setReminders(change) {
    rset = R.sanitize(Object.assign({}, rset, change));
    if (!Store.write(storage, 'reminders', rset)) unsaved = true;
    syncReminders();
    listKey = '';
    checkReminders();
  }

  /**
   * One check: bring the notices up to date, then claim what has come due and is not covered. Runs on
   * every tick and after anything that changes what is due (a star, Hidden, Adjust, a setting, the clock).
   * Delivery waits while a clock check is settling (holding()), so a wrong device clock cannot give a
   * reminder early, which would then cover the right one.
   */
  function checkReminders() {
    const now = nowMs(), ctx = rctx(now);
    refreshTray(now);
    renderRemindersList(now);
    if (!rset.on || holding()) return;
    let { alert } = R.decide(R.due(ctx).filter((it) => !claiming.has(it.id)), mem);
    if (!alert.length) return;
    // Due and not covered by what this tab knows: only now are the saved records read.
    const saved = R.prune(readRecords(), IDS, now);
    const d = R.decide(alert, saved);
    for (const it of d.quiet) mem[it.id] = saved[it.id]; // given by another tab, or before a reload
    alert = d.alert;
    if (!alert.length) return;
    for (const it of alert) claiming.add(it.id);
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    Promise.all(alert.map((item) => R.claim({ item, now, by: TAB, mem, read: readRecords, write: writeRecords, locks: navigator.locks, wait, eventIds: IDS })
      .then((r) => { if (r.won && !r.persisted) unsaved = true; return r.won ? item : null; }, () => null)))
      .then((won) => deliver(won.filter(Boolean)))
      .finally(() => { for (const it of alert) claiming.delete(it.id); syncReminders(); });
  }

  /** The claims won on one check: one notice each (reusing an event's notice), one announcement in all. */
  function deliver(won) {
    if (!won.length) return;
    for (const it of won) { live = R.open(live, it); fresh.add(it.id); }
    const now = nowMs(), shown = refreshTray(now);
    // Only what is on show is announced: an event unstarred, hidden or started meanwhile is not.
    const said = shown.filter((n) => won.some((w) => w.id === n.id));
    if (said.length) say(announcement(said, now));
    listKey = '';
    renderRemindersList(now);
  }

  function announcement(items, now) {
    const first = items[0], note = remNote(first.event), name = `${first.event.name}${note ? ` (${note})` : ''}`;
    if (items.length === 1) return `Reminder: ${name} starts at ${formats().time.format(first.start)}, ${inMinutes(first.start - now)}.`;
    const more = items.length - 1;
    return `Reminders: ${name} and ${more} more starred ${more === 1 ? 'event start' : 'events start'} within ${rset.lead} minutes.`;
  }
  /** One polite announcement. With a dialog open, the page behind it is out of reach: it is said in the dialog,
   *  the top one when two are open (Add to calendar over an event's details, the only pair that can be). */
  function say(msg) {
    const opened = document.querySelectorAll('dialog[open]'), open = opened[opened.length - 1];
    const target = (open && open.querySelector('[data-announce]')) || $('reminders-announce');
    for (const el of document.querySelectorAll('[data-announce]')) if (el !== target) el.textContent = '';
    target.textContent = msg;
  }

  /** Follows each notice to its event's current start (R.follow) and draws the tray. Returns what is shown. */
  function refreshTray(now) {
    const f = R.follow(Object.assign({ live }, rctx(now)));
    live = f.live;
    drawTray(f.shown, now);
    return f.shown;
  }

  // The tray is rebuilt only when what it lists changes; its countdowns tick through data-until.
  function drawTray(shown, now) {
    const n = shown.length, cap = narrow && narrow.matches ? 1 : 3;
    if (n <= cap) trayOpen = false;
    const title = n ? `(${n}) ${TITLE}` : TITLE;
    if (document.title !== title) document.title = title;
    const key = [shown.map((s) => `${s.id}:${s.start}:${remNote(s.event)}`).join(), cap, trayOpen, prefs.showUtc, formats().zone, S.localDayKey(now)].join('|');
    if (key === trayKey) return;
    trayKey = key;
    const tray = $('reminders-tray'), had = tray.contains(document.activeElement) ? document.activeElement : null;
    const controls = () => [...tray.querySelectorAll('a, button')].filter((el) => el.getClientRects().length);
    const at = had ? controls().indexOf(had) : -1, fkey = had && had.getAttribute('data-fkey');
    $('reminders-notices').replaceChildren(...(trayOpen ? shown : shown.slice(0, cap)).map((s) => notice(s, now)));
    fresh.clear();
    // On a phone, with several notices, Show more and Dismiss all end the first notice's row of buttons, so
    // a folded tray is no taller than one notice. Where the row has no room for them (320 px), they wrap
    // onto a line of their own inside the notice. Wider screens keep them under the list.
    const row = cap === 1 && n > 1 ? $('reminders-notices').querySelector('.rm-actions') : null;
    if (row) row.append(foot); else if (foot.parentNode !== tray) tray.append(foot);
    tray.hidden = !n;
    foot.hidden = n < 2;
    const more = $('reminders-more'), rest = n - cap;
    more.hidden = n <= cap;
    more.textContent = trayOpen ? 'Show fewer' : row ? `+${rest} more` : `Show ${rest} more`;
    if (row && !trayOpen) more.setAttribute('aria-label', `+${rest} more ${rest === 1 ? 'reminder' : 'reminders'}`); else more.removeAttribute('aria-label');
    more.setAttribute('aria-expanded', String(trayOpen));
    // The tray never takes focus; when the control that had it goes away, focus moves to the nearest one
    // left, else to Coming up, so it is never lost behind the page. A control that was moved (Show more,
    // Dismiss all) loses focus in the move, and gets it back.
    if (had && (document.activeElement !== had || !had.getClientRects().length)) {
      const left = controls();
      const next = (had.isConnected && had.getClientRects().length && had) || (fkey && tray.querySelector(`[data-fkey="${CSS.escape(fkey)}"]`))
        || left[Math.min(Math.max(at, 0), left.length - 1)] || viewHeading();
      next.focus();
    }
    spaceForTray();
  }

  function notice(s, now) {
    const e = s.event, f = formats(), note = remNote(e), key = `rm:${e.id}`;
    return h('li', { class: 'rm-notice' + (fresh.has(e.id) ? ' is-new' : ''), 'data-id': e.id, 'data-start': s.start },
      h('p', { class: 'rm-name' }, h('span', { class: 'rm-label', text: 'Reminder' }), ' ', nameLink(e, key), note ? h('span', { class: 'rm-note', text: ` (${note})` }) : null),
      h('p', { class: 'rm-when' }, `Starts ${dayWord(s.start, now)}`, h('strong', { text: f.time.format(s.start) }), utcText(s.start) ? ` (${utcText(s.start)})` : '', ' · ',
        h('span', { class: 'rm-left', 'data-until': s.start, 'data-prefix': 'in ' }, 'in ' + S.duration(s.start - now))),
      h('div', { class: 'rm-actions' },
        h('button', { type: 'button', class: 'btn small copy', 'data-copy': e.id, 'data-fkey': `${key}:copy`, 'aria-label': `Copy waypoint for ${e.name}: ${e.waypoint.chat}`, title: `${e.waypoint.name} ${e.waypoint.chat}`, text: 'Copy waypoint' }),
        h('button', { type: 'button', class: 'btn small', 'data-rm-dismiss': e.id, 'data-fkey': `${key}:dismiss`, 'aria-label': `Dismiss the reminder for ${e.name}`, text: 'Dismiss' })));
  }

  /** Room below the page for the tray, so the footer and a focused control can be scrolled clear of it. */
  function spaceForTray() {
    const tray = $('reminders-tray');
    const room = tray.hidden ? 0 : Math.ceil(window.innerHeight - tray.getBoundingClientRect().top) + 8;
    const v = `${Math.max(0, room)}px`;
    if (document.documentElement.style.getPropertyValue('--tray-space') !== v) document.documentElement.style.setProperty('--tray-space', v);
  }
  if (window.ResizeObserver) new ResizeObserver(() => spaceForTray()).observe($('reminders-tray'));
  // A control that takes focus partly behind the tray is scrolled up to the edge of that room. Browsers do this
  // with the scroll padding, but Firefox only when less than a line of the control shows, which leaves one
  // taller than the room and a line (a summary that wraps on a phone) partly behind. Not one in the tray or a
  // dialog, which sit above the page.
  document.addEventListener('focusin', (ev) => {
    const tray = $('reminders-tray'), el = ev.target;
    if (tray.hidden || !(el instanceof Element) || tray.contains(el) || el.closest('dialog')) return;
    const b = el.getBoundingClientRect(), t = tray.getBoundingClientRect();
    if (!(b.bottom > t.top && b.top < t.bottom && b.right > t.left && b.left < t.right)) return;
    const edge = Math.min(window.innerHeight - (parseFloat(getComputedStyle(document.documentElement).scrollPaddingBottom) || 0), t.top - 8);
    window.scrollBy(0, Math.ceil(Math.min(b.bottom - edge, b.top)));
  });
  if (narrow && narrow.addEventListener) narrow.addEventListener('change', () => { trayKey = ''; refreshTray(nowMs()); });

  /** The dialog's list: each starred event's next start and its reminder. Rebuilt on a change, or when a time in it passes. */
  function renderRemindersList(now) {
    if (!$('reminders-dialog').open) return;
    const key = [JSON.stringify(rset), prefs.starred.join(), prefs.hidden.join(), JSON.stringify(overrides), prefs.showUtc, formats().zone, S.localDayKey(now)].join('|');
    if (key === listKey && now < listUntil) return;
    listKey = key;
    const f = formats();
    const rows = R.upcoming(Object.assign({ records: R.merge(R.prune(readRecords(), IDS, now), mem) }, rctx(now)));
    listUntil = R.nextChange(rows, now);
    const state = (r) => ({
      on: `reminder at ${dayWord(r.trigger, now)}${f.time.format(r.trigger)}`, due: 'reminder due now', reminded: 'reminder given',
      off: 'no reminder while reminders are off', hidden: 'hidden, so no reminder',
    })[r.state];
    $('reminders-list').replaceChildren(...(rows.length ? rows.map((r) => {
      const note = remNote(r.event), utc = utcText(r.start) ? ` (${utcText(r.start)})` : '';
      return h('li', { 'data-id': r.id, 'data-state': r.state }, h('span', { class: 'name', text: r.event.name }),
        `${note ? ` (${note})` : ''}: starts ${dayWord(r.start, now)}${f.time.format(r.start)}${utc}; ${state(r)}.`);
    }) : [h('li', { class: 'rm-none', text: "No starred events yet. Use the star (☆) by an event's name." })]));
  }

  $('reminders-on').addEventListener('change', (ev) => setReminders({ on: ev.target.checked }));
  for (const r of document.querySelectorAll('[name="reminders-lead"]')) r.addEventListener('change', (ev) => { if (ev.target.checked) setReminders({ lead: Number(ev.target.value) }); });
  // Another tab of this site changed the settings: follow them, so the tabs agree.
  window.addEventListener('storage', (ev) => {
    if (ev.key === Store.PREFIX + 'reminders') { rset = R.sanitize(Store.read(storage, 'reminders')); syncReminders(); listKey = ''; checkReminders(); }
    else if (ev.key === Store.PREFIX + 'reminded') listKey = '';
  });

  // ---- Add to calendar: scheduled starts as an .ics file, written in this browser by js/ics.js ----
  // The file holds explicit starts from the same engine and the same Adjust times as the lists, in UTC. It
  // leaves the page only as a download: no request, nothing saved. The choices last while the page is open.

  const calDialog = $('calendar-dialog');
  const cal = { one: null, scope: 'starred', span: 'next', alarm: 0, picked: new Set(), opener: null, key: '' };

  function calendarEvents() {
    const all = effective();
    if (cal.scope === 'one') return all.filter((e) => e.id === cal.one);
    if (cal.scope === 'starred') return all.filter((e) => prefs.starred.includes(e.id));
    return all.filter((e) => cal.picked.has(e.id));
  }
  /** "today at 7:00 PM (00:00 UTC)", "tomorrow at ...", a weekday within the week, else the date. */
  function calWhen(ms, now) {
    const f = formats(), u = utcText(ms) ? ` (${utcText(ms)})` : '';
    const day = S.localDayKey(ms) === S.localDayKey(now) ? 'today' : S.dayLabel(ms, now) === 'Tomorrow' ? 'tomorrow' : ms - now < 6 * S.DAY ? S.dayLabel(ms, now) : f.newsDay.format(ms);
    return `${day} at ${f.time.format(ms)}${u}`;
  }
  function calSummary(p, events, now) {
    if (!p.ok) {
      if (p.reason === 'empty') return cal.scope === 'starred' ? 'No events are starred yet. Star one with the star (☆) by its name, or choose events here.' : 'Choose at least one event.';
      if (p.reason === 'too-many') return `That would be ${p.count} entries, more than the ${Ics.MAX_ENTRIES} one file holds. Choose fewer events or a shorter time.`;
      return 'No file can be made from these choices.';
    }
    const first = p.entries[0], last = p.entries[p.entries.length - 1];
    if (p.count === 1) return `1 entry: ${first.event.name}, ${calWhen(first.start, now)}.`;
    const what = events.length === 1 ? events[0].name : `${events.length} events`;
    return `${p.count} entries for ${what}, from ${calWhen(first.start, now)} to ${calWhen(last.start, now)}, your time (${formats().zone}).`;
  }

  /** The dialog's state and summary. The summary is redone when a choice changes, and when the minute does (starts are on whole minutes). */
  function syncCalendar(force) {
    if (!calDialog.open && !force) return;
    const now = nowMs(), events = calendarEvents();
    const key = [cal.scope, cal.one, cal.span, cal.alarm, events.map((e) => e.id).join(), JSON.stringify(overrides), prefs.showUtc, formats().zone, Math.floor(now / S.MIN)].join('|');
    if (!force && key === cal.key) return;
    cal.key = key;
    for (const r of calDialog.querySelectorAll('[name="calendar-scope"]')) r.checked = r.value === cal.scope;
    $('calendar-one-option').hidden = !cal.one;
    $('calendar-one-name').textContent = cal.one ? `This event: ${BY_ID.get(cal.one).name}` : 'This event';
    $('calendar-starred-label').textContent = `Starred events (${prefs.starred.length})`;
    $('calendar-pick').hidden = cal.scope !== 'choose';
    $('calendar-span').value = cal.span;
    $('calendar-alarm').value = String(cal.alarm);
    const p = Ics.plan({ events, engine: S, now, span: cal.span });
    const summary = calSummary(p, events, now);
    if ($('calendar-summary').textContent !== summary) $('calendar-summary').textContent = summary;
    const marked = p.ok ? [...new Set(p.entries.map((it) => it.event))].filter((e) => Ics.note(e)) : [];
    $('calendar-uncertain').hidden = !marked.length;
    $('calendar-uncertain').textContent = marked.length ? `Marked in the entry titles: ${marked.map((e) => `${e.name} (${Ics.note(e)})`).join(', ')}.` : '';
    $('calendar-download').disabled = !p.ok;
  }

  /** Every event, by kind, with a box to tick; an unverified or adjusted one says so. Drawn when the dialog opens. */
  function renderCalendarPick() {
    const eff = new Map(effective().map((e) => [e.id, e]));
    const group = (kind, title) => h('fieldset', { class: 'cal-kind' }, h('legend', { text: title }),
      ...EVENTS.filter((e) => e.kind === kind).map((e) => {
        const n = Ics.note(eff.get(e.id));
        // The name and its mark are one piece of text, so a long name wraps with its mark instead of beside it.
        return h('label', { class: 'rm-option' }, h('input', { type: 'checkbox', 'data-cal-pick': e.id, checked: cal.picked.has(e.id) }),
          h('span', {}, e.name, n ? h('span', { class: 'cal-note', text: ` (${n})` }) : null));
      }));
    $('calendar-pick-list').replaceChildren(group('world-boss', 'World bosses'), group('meta', 'Meta events'));
  }

  function openCalendar(oneId) {
    const el = document.activeElement;
    cal.opener = { el, fkey: el && el.getAttribute ? el.getAttribute('data-fkey') : null };
    cal.one = oneId && BY_ID.has(oneId) ? oneId : null;
    cal.scope = cal.one ? 'one' : prefs.starred.length ? 'starred' : 'choose';
    $('calendar-done').textContent = '';
    renderCalendarPick();
    syncCalendar(true);
    calDialog.showModal();
  }

  function downloadCalendar() {
    const now = nowMs(), events = calendarEvents();
    const r = Ics.build({ events, engine: S, now, span: cal.span, alarmMin: cal.alarm, meta: DATA.meta, link: Link.make });
    if (!r.ok) { syncCalendar(true); return; }
    const name = Ics.filename({ scope: cal.scope, span: cal.span, events });
    try {
      const url = URL.createObjectURL(new Blob([r.text], { type: 'text/calendar;charset=utf-8' }));
      const a = h('a', { href: url, download: name, hidden: true });
      calDialog.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('calendar-done').textContent = `Downloading ${name} (${r.count} ${r.count === 1 ? 'entry' : 'entries'}). Open it with your calendar, or import it on your calendar's website.`;
    } catch (e) {
      $('calendar-done').textContent = 'This browser could not save the file.';
    }
  }

  calDialog.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.name === 'calendar-scope' && t.checked) cal.scope = t.value;
    else if (t.hasAttribute('data-cal-pick')) { if (t.checked) cal.picked.add(t.getAttribute('data-cal-pick')); else cal.picked.delete(t.getAttribute('data-cal-pick')); }
    else if (t.id === 'calendar-span' && Object.prototype.hasOwnProperty.call(Ics.SPANS, t.value)) cal.span = t.value;
    else if (t.id === 'calendar-alarm' && Ics.ALARMS.includes(Number(t.value))) cal.alarm = Number(t.value);
    else return;
    $('calendar-done').textContent = '';
    syncCalendar(true);
  });
  function pickAll(on) {
    cal.picked = new Set(on ? EVENTS.map((e) => e.id) : []);
    for (const b of calDialog.querySelectorAll('[data-cal-pick]')) b.checked = on;
    $('calendar-done').textContent = '';
    syncCalendar(true);
  }
  // Focus goes back to what opened the dialog: the Calendar button, or Add to calendar in an event's details
  // (drawn again by then if the details changed meanwhile).
  calDialog.addEventListener('close', () => {
    const from = cal.opener;
    cal.opener = null; cal.key = '';
    const back = from && (shownEl(from.el) || (from.fkey && shownEl(document.querySelector(`[data-fkey="${CSS.escape(from.fkey)}"]`))));
    if (back) back.focus();
  });

  // ---- Controls ----

  function syncControls() {
    for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === prefs.filter));
    // A chip's name starts with its visible text (what a voice control user says), then the full region name.
    $('region-chips').replaceChildren(...REGIONS.map((r) => h('button', {
      type: 'button', class: 'chip', 'data-region': r.id, 'aria-pressed': String(prefs.regions.includes(r.id)), title: r.name, 'aria-label': `${r.short} (${r.name})`, text: r.short,
    })));
    $('ahead').value = String(prefs.aheadMin);
    $('compact-btn').setAttribute('aria-pressed', String(prefs.compact));
    $('utc-btn').setAttribute('aria-pressed', String(prefs.showUtc));
    $('hidden-btn').textContent = `Hidden (${prefs.hidden.length})`;
    syncReminders();
    // Under the folded filters on a phone: what narrows the lists, so the filters need not be opened to see it.
    $('filters-summary').textContent = [prefs.filter !== 'all' ? `${SHOW_LABEL[prefs.filter]} only` : null,
      prefs.regions.length < REGIONS.length ? `${prefs.regions.length} of ${REGIONS.length} regions` : null,
      prefs.hidden.length ? `${prefs.hidden.length} hidden` : null].filter(Boolean).join(' · ');
    document.body.classList.toggle('compact', prefs.compact);
    const label = { dark: 'Dark', light: 'Light', system: 'System' }[prefs.theme];
    $('theme-btn').textContent = label;
    $('theme-btn').setAttribute('aria-label', `Theme: ${label}. Change theme`);
    applyTheme();
  }

  const systemLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function applyTheme() {
    const t = prefs.theme === 'system' ? (systemLight && systemLight.matches ? 'light' : 'dark') : prefs.theme;
    document.documentElement.setAttribute('data-theme', t);
  }
  if (systemLight && systemLight.addEventListener) systemLight.addEventListener('change', applyTheme);

  function changed() { savePrefs(); syncControls(); render(true); checkReminders(); }
  const toggleIn = (arr, id) => (arr.includes(id) ? arr.filter((x) => x !== id) : arr.concat(id));

  let toastTimer = 0;
  function toast(msg) {
    // With the event details open, the page behind is out of reach (screen readers too): say it in the dialog.
    if (dialog.open) { $('event-dialog-status').textContent = msg; return; }
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 4000);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
    const ta = h('textarea', { class: 'sr-only', readonly: true });
    ta.value = text;
    (document.querySelector('dialog[open]') || document.body).append(ta); // outside an open dialog it could not be selected
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  // Share, as on FFXI Timer: always the canonical address, wherever the page was opened, and nothing of the
  // reader's. The device's share sheet where there is one; otherwise, or when it fails, the address is
  // copied. Closing the sheet does nothing.
  async function sharePage() {
    const url = Link.CANONICAL, data = { title: document.querySelector('meta[property="og:title"]').content, url };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try { await navigator.share(data); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    toast(await copyText(url) ? `Copied the link to GW2 Timer: ${url}` : `Copy did not work here. The link is ${url}`);
  }

  function setOverride(id, offsetMin) {
    overrides[id] = { offsetMin, setAt: Date.now() };
    saveOverrides();
    render(true);
    checkReminders();
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button, [data-close]');
    if (!t) return;
    const a = (name) => t.getAttribute(name);
    if (a('data-mode')) {
      // One history entry per switch, so Back returns to the other mode.
      const next = a('data-mode');
      if (next !== mode) { try { history.pushState({ gw2Mode: next }, '', next === 'market' ? '#market' : location.pathname + location.search); } catch (e) { /* no history here: the switch still works */ } }
      setMode(next);
    } else if (a('data-filter')) { prefs.filter = a('data-filter'); changed(); }
    else if (a('data-region')) { prefs.regions = toggleIn(prefs.regions, a('data-region')); changed(); }
    else if (a('data-star')) { prefs.starred = toggleIn(prefs.starred, a('data-star')); changed(); }
    else if (a('data-hide')) {
      const e = BY_ID.get(a('data-hide'));
      prefs.hidden = toggleIn(prefs.hidden, e.id); changed();
      toast(`${e.name} is hidden. Show it again from Hidden.`);
      $('coming-title').focus();
    } else if (a('data-unhide')) { prefs.hidden = prefs.hidden.filter((x) => x !== a('data-unhide')); changed(); renderHidden(); }
    else if (a('data-copy')) {
      const e = BY_ID.get(a('data-copy'));
      const ok = await copyText(e.waypoint.chat);
      toast(ok ? `Copied ${e.waypoint.chat} (${e.waypoint.name}). Paste it in game chat.` : `Copy did not work here. The code is ${e.waypoint.chat}`);
    } else if (a('data-adjust')) {
      const id = a('data-adjust');
      if (openAdjust.has(id)) openAdjust.delete(id); else openAdjust.add(id);
      render(true);
    } else if (a('data-adj-set')) {
      const id = a('data-adj-set'), e = BY_ID.get(id);
      const input = document.querySelector(`[data-adj-input="${CSS.escape(id)}"]`);
      const m = /^(\d{1,2}):(\d{2})$/.exec(input ? input.value : '');
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) { toast('Enter the time you saw it start, like 4:15 PM.'); return; }
      const r = S.offsetFromSeen(Number(m[1]), Number(m[2]), nowMs(), e.schedule.periodMin);
      setOverride(id, r.offsetMin);
      toast(`${e.name}: now ${S.ruleText(Object.assign({}, e.schedule, { offsetMin: r.offsetMin }))}.`);
    } else if (a('data-adj-nudge')) {
      const [id, d] = a('data-adj-nudge').split(':'), e = BY_ID.get(id);
      const cur = overrides[id] ? overrides[id].offsetMin : e.schedule.offsetMin;
      setOverride(id, S.nudge(cur, Number(d), e.schedule.periodMin));
    } else if (a('data-adj-reset')) {
      const id = a('data-adj-reset');
      delete overrides[id]; saveOverrides(); render(true); checkReminders();
      toast(`${BY_ID.get(id).name} is back on its default time.`);
    } else if (t.id === 'compact-btn') { prefs.compact = !prefs.compact; changed(); }
    else if (t.id === 'utc-btn') { prefs.showUtc = !prefs.showUtc; changed(); }
    else if (t.id === 'theme-btn') { prefs.theme = { dark: 'light', light: 'system', system: 'dark' }[prefs.theme]; changed(); }
    else if (t.id === 'about-btn') $('about').showModal();
    else if (t.id === 'hidden-btn') { renderHidden(); $('hidden-dialog').showModal(); }
    else if (t.id === 'reminders-btn') { syncReminders(); listKey = ''; $('reminders-dialog').showModal(); renderRemindersList(nowMs()); }
    else if (a('data-rm-dismiss')) { live = R.dismiss(live, [a('data-rm-dismiss')]); refreshTray(nowMs()); } // the start stays covered
    else if (t.id === 'reminders-more') { trayOpen = !trayOpen; refreshTray(nowMs()); }
    else if (t.id === 'reminders-dismiss-all') { live = []; refreshTray(nowMs()); }
    else if (t.id === 'news-toggle') { prefs.news = !prefs.news; savePrefs(); renderNews(); if (prefs.news) loadNews(); }
    else if (t.id === 'news-more') { prefs.newsExpanded = !prefs.newsExpanded; savePrefs(); renderNews(); }
    else if (a('data-copy-link')) {
      // Always the canonical address with the event id and nothing else, wherever the page is read from.
      const e = BY_ID.get(a('data-copy-link')), url = Link.make(e.id);
      const ok = await copyText(url);
      $('event-dialog-linkbox').hidden = ok;
      if (ok) toast(`Copied the link to ${e.name}.`);
      else {
        const box = $('event-dialog-link');
        box.value = url; box.focus(); box.select();
        toast('Copy did not work here. The link is selected in the box: copy it from there.');
      }
    } else if (t.id === 'link-notice-dismiss') {
      const r = Link.parse(location.hash, IDS);
      showLinkNotice(null);
      if (r && !r.ok) dropFragment();
    } else if (t.id === 'find-clear') { findNow(''); $('find').focus(); }
    else if (t.id === 'filters-toggle') {
      // Phones only (style.css hides the button on wider screens). Not saved: the filters fold again on the next visit.
      const open = !$('filters').classList.contains('is-open');
      $('filters').classList.toggle('is-open', open);
      t.setAttribute('aria-expanded', String(open));
    } else if (a('data-calendar')) openCalendar(a('data-calendar'));
    else if (t.id === 'calendar-btn') openCalendar(null);
    else if (t.id === 'calendar-download') downloadCalendar();
    else if (t.id === 'calendar-pick-all') pickAll(true);
    else if (t.id === 'calendar-pick-none') pickAll(false);
    else if (a('data-share') !== null) {
      // About's Share closes About first: a toast behind a modal dialog is neither seen nor read.
      const d = t.closest('dialog');
      if (d) d.close();
      sharePage();
    } else if (a('data-close') !== null) t.closest('dialog').close();
  });

  $('ahead').addEventListener('change', (ev) => { prefs.aheadMin = Number(ev.target.value); changed(); });
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); }); // a click on the backdrop closes it
  }

  function renderHidden() {
    const items = prefs.hidden.map((id) => BY_ID.get(id)).filter(Boolean);
    $('hidden-list').replaceChildren(...items.map((e) => h('li', {},
      h('span', { text: `${e.name} (${e.map})` }),
      h('button', { type: 'button', class: 'btn small', 'data-unhide': e.id, 'aria-label': `Show ${e.name} again`, text: 'Show' }))));
    $('hidden-empty').hidden = items.length > 0;
  }

  // ---- Footer and About: the dataset revision and review dates ----

  function renderMeta() {
    const m = DATA.meta;
    $('revision').textContent = `Schedule r${m.datasetRevision} · reviewed ${isoDay(m.reviewedOn)}`;
    const marked = EVENTS.filter((e) => e.status !== 'documented' && e.status !== 'confirmed').length;
    $('about-data').textContent = `Schedule data r${m.datasetRevision}. Checked against ArenaNet's game update notes through ${isoDay(m.reviewedThroughPatch)}, reviewed ${isoDay(m.reviewedOn)}. Times last checked against sources on ${isoDay(m.verifiedOn)}. ${EVENTS.length} events; ${EVENTS.length - marked} agree across sources and ${marked} are marked Unverified.`;
  }

  // ---- Schedule notes: revision, review dates, status counts and the uncertain times ----

  const STATUS_LABEL = { documented: 'Documented', confirmed: 'Confirmed in game', disputed: 'Disputed', unverified: 'Unverified', recheck: 'Recheck' };
  let notesKey = '';
  function renderNotes() {
    // The notes change only with Adjust times or the time zone, not every time the lists do.
    const k = JSON.stringify(overrides) + formats().zone;
    if (k === notesKey) return;
    notesKey = k;
    try {
      const m = DATA.meta, sum = S.statusSummary(EVENTS), n = sum.uncertain.length;
      $('notes-hint').textContent = `r${m.datasetRevision} · reviewed ${isoDay(m.reviewedOn)} · ${n} uncertain ${n === 1 ? 'time' : 'times'}`;
      const fact = (k, v) => [h('dt', { text: k }), h('dd', { text: v })];
      $('notes-facts').replaceChildren(
        ...fact('Schedule revision', `r${m.datasetRevision}`),
        ...fact('Last reviewed', `${isoDay(m.reviewedOn)}, against ArenaNet's game update notes through ${isoDay(m.reviewedThroughPatch)}`),
        ...fact('Last checked against sources', isoDay(m.verifiedOn)));
      const order = ['documented', 'confirmed', 'disputed', 'unverified'];
      for (const s of Object.keys(sum.counts)) if (!order.includes(s) && (s !== 'recheck' || sum.counts[s] > 0)) order.push(s);
      $('notes-counts').replaceChildren(...order.map((s) => h('li', { 'data-status': s },
        h('span', { class: 'count', text: String(sum.counts[s] || 0) }), ' ', STATUS_LABEL[s] || s)));
      $('notes-uncertain').replaceChildren(...sum.uncertain.map((e) => {
        const o = overrides[e.id];
        const why = e.status === 'recheck' && e.flag ? ` after the ${isoDay(e.flag.patch)} game update` : '';
        return h('li', { 'data-id': e.id },
          h('span', { class: 'name', text: e.name }), ' ',
          h('span', { class: 'badge warn', text: (STATUS_LABEL[e.status] || e.status) + why }),
          h('span', { class: 'rule', text: `${e.map}: ${S.ruleText(e.schedule)}, runs about ${e.schedule.windowMin} min.` }),
          o ? h('span', { class: 'rule mine', text: `Yours (Adjust): ${S.ruleText(Object.assign({}, e.schedule, { offsetMin: o.offsetMin }))}.` }) : null);
      }));
      if (!n) $('notes-uncertain').replaceChildren(h('li', { text: 'None right now.' }));
    } catch (e) { /* the notes never break the page */ }
  }

  // ---- News (isolated: nothing here can stop the timer) ----

  let newsState = { items: [], fetchedAt: null, status: 'idle' };
  function renderNews() {
    try {
      const f = formats(), more = $('news-more');
      $('news-toggle').textContent = prefs.news ? 'Turn off news' : 'Turn on news';
      $('news').classList.toggle('is-off', !prefs.news);
      // style.css keeps the headlines' room while the first ones load (status idle or loading).
      $('news').setAttribute('data-status', prefs.news ? newsState.status : 'off');
      if (!prefs.news) {
        $('news-note').textContent = 'News is off. Turning it on loads headlines from guildwars2.com, so ArenaNet sees that request.';
        $('news-list').replaceChildren();
        more.hidden = true;
        return;
      }
      const when = newsState.fetchedAt ? f.stamp.format(newsState.fetchedAt) : '';
      const status = {
        idle: '', loading: 'Loading headlines...',
        ok: `Updated ${when}.`,
        stale: `guildwars2.com did not answer; these are the headlines saved ${when}.`,
        failed: 'News could not load right now. The timer is not affected.',
      }[newsState.status];
      $('news-note').textContent = `${status} Headlines load from guildwars2.com (ArenaNet), so ArenaNet sees this request.`.trim();
      const all = newsState.items, list = prefs.newsExpanded ? all : all.slice(0, News.SHOWN);
      $('news-list').replaceChildren(...list.map((i) => h('li', {},
        i.dateMs ? h('time', { datetime: new Date(i.dateMs).toISOString(), text: f.newsDay.format(i.dateMs) }) : h('span', { class: 'no-date' }),
        h('a', { href: i.link, target: '_blank', rel: 'noopener noreferrer', text: i.title }, h('span', { class: 'sr-only', text: ' (opens a new tab)' })))));
      more.hidden = all.length <= News.SHOWN;
      more.textContent = prefs.newsExpanded ? 'Show fewer' : `Show all ${all.length}`;
      more.setAttribute('aria-expanded', String(prefs.newsExpanded));
    } catch (e) { /* the news panel never breaks the page */ }
  }

  async function loadNews() {
    try {
      const cache = News.sanitizeCache(Store.read(storage, 'news'));
      if (cache) newsState = { items: cache.items, fetchedAt: cache.fetchedAt, status: 'ok' };
      if (cache && News.isFresh(cache, Date.now())) { renderNews(); return; }
      newsState.status = 'loading'; renderNews();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), News.TIMEOUT_MS);
      let items = [];
      try {
        const res = await fetch(News.FEED_URL, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
        if (res.ok) items = News.parseFeed(await res.text());
      } finally { clearTimeout(timer); }
      if (!prefs.news) return;
      if (items.length) {
        const fresh = { fetchedAt: Date.now(), items };
        Store.write(storage, 'news', fresh);
        newsState = { items, fetchedAt: fresh.fetchedAt, status: 'ok' };
      } else newsState.status = newsState.items.length ? 'stale' : 'failed';
    } catch (e) {
      newsState.status = newsState.items.length ? 'stale' : 'failed';
    }
    renderNews();
  }

  // ---- Clock check against this site's own address (skipped when opened from a file) ----

  async function sampleClock() {
    const url = new URL(location.href);
    url.hash = '';
    url.searchParams.set('clock', String(Date.now()));
    const sentMs = Date.now();
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'omit' });
    return { sentMs, receivedMs: Date.now(), date: res.headers.get('Date'), age: res.headers.get('Age') };
  }
  let clockBusy = false, lastCheck = -Infinity;
  // Reminders are not delivered while the clock may be about to move: until the first check has finished
  // (with or without a correction, or failed), and while a check started by a wake or a clock change runs,
  // at most CLOCK_HOLD_MS each time. A reminder given early by a wrong clock would cover the right one.
  // Offline or from a file the check ends at once, and nothing waits.
  const CLOCK_HOLD_MS = 8000;
  let holdUntil = /^https?:$/.test(location.protocol) ? performance.now() + CLOCK_HOLD_MS : 0; // the first check, started below
  const holding = () => holdUntil > 0 && performance.now() < holdUntil;
  async function checkClock(minGapMs, hold) {
    if (!/^https?:$/.test(location.protocol) || clockBusy || performance.now() - lastCheck < (minGapMs || 0)) return;
    clockBusy = true; lastCheck = performance.now();
    if (hold) holdUntil = lastCheck + CLOCK_HOLD_MS;
    const before = clockOffset;
    try {
      const first = await sampleClock();
      await new Promise((ok) => setTimeout(ok, Clock.SAMPLE_GAP_MS));
      const est = Clock.estimateClock([first, await sampleClock()]);
      clockOffset = est ? est.offsetMs : 0;
      const n = $('clock-notice');
      n.hidden = !(est && est.applied);
      if (est && est.applied) n.textContent = `Your device clock is ${S.duration(Math.abs(est.offsetMs))} ${est.offsetMs > 0 ? 'slow' : 'fast'}; the times here are corrected for it.`;
    } catch (e) { /* no correction: the device clock is used as it is */ }
    finally { clockBusy = false; }
    if (clockOffset !== before) render(true);
    if (holdUntil) { holdUntil = 0; checkReminders(); } // settled: deliver what is due now, not on the next tick
  }

  // ---- Ticking: in step with whole seconds; recheck the clock after sleep or a clock change ----

  let timer = 0, lastWall = Date.now(), lastSteady = performance.now();
  function tick() {
    const wall = Date.now(), steady = performance.now();
    const resumed = Clock.detectResume(lastWall, lastSteady, wall, steady);
    if (resumed) checkClock(resumed === 'clock-jump' ? 5000 : 60000, true);
    lastWall = wall; lastSteady = steady;
    render(Boolean(resumed));
    checkReminders();
    timer = setTimeout(tick, 1000 - (nowMs() % 1000) + 5);
  }
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); tick(); });

  $('find').value = ''; // a browser that restores form fields must not bring back an earlier search
  syncControls();
  renderMeta();
  render(true);
  tick();
  readHash(); // a link to one event opens its details over the reader's own page
  renderNews();
  if (prefs.news) loadNews();
  checkClock(0);
  setInterval(() => checkClock(60000), 6 * 3600000);
})();
