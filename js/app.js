// GW2 Timer page. Reads the generated dataset (events-data.js) and the pure helpers in schedule.js,
// store.js, news.js and clock.js; everything here is display and input. The DOM is built with
// createElement only: no outside text is ever parsed as HTML.
(function () {
  'use strict';

  const S = window.GW2Schedule, Store = window.GW2Store, News = window.GW2News, Clock = window.GW2Clock, DATA = window.GW2_DATA;
  const $ = (id) => document.getElementById(id);
  const storage = (() => { try { return window.localStorage; } catch (e) { return null; } })();

  const EVENTS = DATA.events;
  const BY_ID = new Map(EVENTS.map((e) => [e.id, e]));
  const REGIONS = DATA.regions;
  const REGION = new Map(REGIONS.map((r) => [r.id, r]));
  const KIND_LABEL = { 'world-boss': 'World boss', meta: 'Meta event' };

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

  const effective = () => EVENTS.map((e) => (overrides[e.id] ? S.applyOverride(e, overrides[e.id].offsetMin) : e));
  function shown(list) {
    const regions = new Set(prefs.regions), hidden = new Set(prefs.hidden), starred = new Set(prefs.starred);
    return list.filter((e) => !hidden.has(e.id) && regions.has(e.region)
      && (prefs.filter === 'all' || (prefs.filter === 'starred' ? starred.has(e.id) : e.kind === prefs.filter)));
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
    if (e.adjustable) out.push(h('button', { type: 'button', class: 'btn small', 'data-adjust': e.id, 'data-fkey': `${key}:adjust`, 'aria-expanded': openAdjust.has(e.id) ? 'true' : 'false', text: 'Adjust' }));
    return h('div', { class: 'actions' }, out);
  }

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
    return h('div', { class: 'adjust-panel', 'data-panel': e.id },
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

  // ---- Happening now (cards) ----

  function card(item) {
    const e = item.event, f = formats(), key = `now:${e.id}`;
    return h('article', { class: 'event is-active', 'data-kind': e.kind, 'data-id': e.id },
      h('div', { class: 'event-head' }, star(e, key), h('h3', { text: e.name }), h('span', { class: 'pill live', text: 'Scheduled now' })),
      h('div', { class: 'badges' }, badges(e)),
      h('p', { class: 'where' }, `${e.map} · ${regionShort(e)}`),
      h('p', { class: 'countdown' },
        h('span', { class: 'big', 'data-until': item.end, 'data-prefix': 'Window closes in ' }, 'Window closes in ' + S.duration(item.end - nowMs())),
        h('span', { class: 'since' }, ` · started ${f.time.format(item.start)}`, utcText(item.start) ? ` (${utcText(item.start)})` : '')),
      e.note ? h('p', { class: 'note', text: e.note }) : null,
      actions(e, key),
      adjustPanel(e));
  }

  // ---- Coming up (rows) ----

  function row(item, now) {
    const e = item.event, f = formats(), key = `next:${e.id}:${item.start}`;
    return h('li', { class: 'row', 'data-kind': e.kind, 'data-id': e.id, 'data-start': item.start },
      h('div', { class: 'when' },
        h('span', { class: 't', text: f.time.format(item.start) }),
        utcText(item.start) ? h('span', { class: 'utc', text: utcText(item.start) }) : null,
        h('span', { class: 'in', 'data-until': item.start, 'data-prefix': 'in ' }, 'in ' + S.duration(item.start - now))),
      h('div', { class: 'what' },
        h('div', { class: 'line1' }, star(e, key), h('span', { class: 'name', text: e.name }), badges(e)),
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
    return [prefs.filter, prefs.regions.join(), prefs.starred.join(), prefs.hidden.join(), prefs.aheadMin, prefs.compact, prefs.showUtc,
      JSON.stringify(overrides), [...openAdjust].join(), formats().zone, S.localDayKey(now),
      nowItems.map((i) => i.event.id + i.start).join(), nextItems.map((i) => i.event.id + i.start).join(),
      DATA.cycles.map((c) => S.cyclePhase(c, now).phase).join(), DATA.resets.map((r) => S.nextReset(r.rule, now)).join()].join('|');
  }

  function render(force) {
    const now = nowMs(), f = formats();
    $('local-time').textContent = f.clock.format(now);
    $('utc-time').textContent = prefs.showUtc ? `${f.utcClock.format(now)} UTC` : f.zone;
    const list = shown(effective());
    const nowItems = S.happening(list, now);
    const nextItems = S.upcoming(list, now, prefs.aheadMin * S.MIN);
    const key = structureKey(now, nowItems, nextItems);
    if (force || key !== lastKey) {
      lastKey = key;
      const focusKey = document.activeElement && document.activeElement.getAttribute('data-fkey');
      const typed = new Map([...document.querySelectorAll('[data-adj-input]')].map((i) => [i.getAttribute('data-fkey'), i.value]));
      panelShown.clear();
      $('strip').replaceChildren(...stripItems(now));
      $('now-list').replaceChildren(...nowItems.map(card));
      $('now-empty').hidden = nowItems.length > 0;
      const starred = new Set(prefs.starred);
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
    }
    for (const el of document.querySelectorAll('[data-until]')) {
      const t = el.getAttribute('data-prefix') + S.duration(Number(el.getAttribute('data-until')) - now);
      if (el.textContent !== t) el.textContent = t;
    }
  }

  // ---- Controls ----

  function syncControls() {
    for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-filter') === prefs.filter));
    $('region-chips').replaceChildren(...REGIONS.map((r) => h('button', {
      type: 'button', class: 'chip', 'data-region': r.id, 'aria-pressed': String(prefs.regions.includes(r.id)), title: r.name, 'aria-label': r.name, text: r.short,
    })));
    $('ahead').value = String(prefs.aheadMin);
    $('compact-btn').setAttribute('aria-pressed', String(prefs.compact));
    $('utc-btn').setAttribute('aria-pressed', String(prefs.showUtc));
    $('hidden-btn').textContent = `Hidden (${prefs.hidden.length})`;
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

  function changed() { savePrefs(); syncControls(); render(true); }
  const toggleIn = (arr, id) => (arr.includes(id) ? arr.filter((x) => x !== id) : arr.concat(id));

  let toastTimer = 0;
  function toast(msg) {
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
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  function setOverride(id, offsetMin) {
    overrides[id] = { offsetMin, setAt: Date.now() };
    saveOverrides();
    render(true);
  }

  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('button, [data-close]');
    if (!t) return;
    const a = (name) => t.getAttribute(name);
    if (a('data-filter')) { prefs.filter = a('data-filter'); changed(); }
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
      delete overrides[id]; saveOverrides(); render(true);
      toast(`${BY_ID.get(id).name} is back on its default time.`);
    } else if (t.id === 'compact-btn') { prefs.compact = !prefs.compact; changed(); }
    else if (t.id === 'utc-btn') { prefs.showUtc = !prefs.showUtc; changed(); }
    else if (t.id === 'theme-btn') { prefs.theme = { dark: 'light', light: 'system', system: 'dark' }[prefs.theme]; changed(); }
    else if (t.id === 'about-btn') $('about').showModal();
    else if (t.id === 'hidden-btn') { renderHidden(); $('hidden-dialog').showModal(); }
    else if (t.id === 'news-toggle') { prefs.news = !prefs.news; savePrefs(); renderNews(); if (prefs.news) loadNews(); }
    else if (a('data-close') !== null) t.closest('dialog').close();
  });

  $('ahead').addEventListener('change', (ev) => { prefs.aheadMin = Number(ev.target.value); changed(); });
  for (const d of document.querySelectorAll('dialog')) {
    d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); }); // a click on the backdrop closes it
  }

  function renderHidden() {
    const items = prefs.hidden.map((id) => BY_ID.get(id)).filter(Boolean);
    $('hidden-list').replaceChildren(...items.map((e) => h('li', {},
      h('span', { text: `${e.name} (${e.map})` }),
      h('button', { type: 'button', class: 'btn small', 'data-unhide': e.id, text: 'Show' }))));
    $('hidden-empty').hidden = items.length > 0;
  }

  // ---- Footer and About: the dataset revision and review dates ----

  function renderMeta() {
    const m = DATA.meta;
    $('revision').textContent = `Schedule r${m.datasetRevision} · reviewed ${isoDay(m.reviewedOn)}`;
    const marked = EVENTS.filter((e) => e.status !== 'documented' && e.status !== 'confirmed').length;
    $('about-data').textContent = `Schedule data r${m.datasetRevision}. Checked against ArenaNet's game update notes through ${isoDay(m.reviewedThroughPatch)}, reviewed ${isoDay(m.reviewedOn)}. Times last checked against sources on ${isoDay(m.verifiedOn)}. ${EVENTS.length} events; ${EVENTS.length - marked} agree across sources and ${marked} are marked Unverified.`;
  }

  // ---- News (isolated: nothing here can stop the timer) ----

  let newsState = { items: [], fetchedAt: null, status: 'idle' };
  function renderNews() {
    try {
      const f = formats();
      $('news-toggle').textContent = prefs.news ? 'Turn off news' : 'Turn on news';
      if (!prefs.news) {
        $('news-note').textContent = 'News is off. Turning it on loads headlines from guildwars2.com, so ArenaNet sees that request.';
        $('news-list').replaceChildren();
        return;
      }
      const when = newsState.fetchedAt ? f.stamp.format(newsState.fetchedAt) : '';
      const status = {
        idle: '', loading: 'Loading headlines...',
        ok: `Updated ${when}.`,
        stale: `guildwars2.com did not answer; these are the headlines saved ${when}.`,
        failed: 'News could not load right now. The timer is not affected.',
      }[newsState.status];
      $('news-note').textContent = `Headlines load from guildwars2.com (ArenaNet), so ArenaNet sees this request. ${status}`.trim();
      $('news-list').replaceChildren(...newsState.items.map((i) => h('li', {},
        h('a', { href: i.link, target: '_blank', rel: 'noopener noreferrer', text: i.title }),
        i.dateMs ? h('time', { datetime: new Date(i.dateMs).toISOString(), text: f.newsDay.format(i.dateMs) }) : null)));
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
  async function checkClock(minGapMs) {
    if (!/^https?:$/.test(location.protocol) || clockBusy || performance.now() - lastCheck < (minGapMs || 0)) return;
    clockBusy = true; lastCheck = performance.now();
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
  }

  // ---- Ticking: in step with whole seconds; recheck the clock after sleep or a clock change ----

  let timer = 0, lastWall = Date.now(), lastSteady = performance.now();
  function tick() {
    const wall = Date.now(), steady = performance.now();
    const resumed = Clock.detectResume(lastWall, lastSteady, wall, steady);
    if (resumed) checkClock(resumed === 'clock-jump' ? 5000 : 60000);
    lastWall = wall; lastSteady = steady;
    render(Boolean(resumed));
    timer = setTimeout(tick, 1000 - (nowMs() % 1000) + 5);
  }
  document.addEventListener('visibilitychange', () => { clearTimeout(timer); tick(); });

  syncControls();
  renderMeta();
  render(true);
  tick();
  renderNews();
  if (prefs.news) loadNews();
  checkClock(0);
  setInterval(() => checkClock(60000), 6 * 3600000);
})();
