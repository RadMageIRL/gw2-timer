// The schedule dataset: loading, the build rules, the revision hash and the generated page file.
// Shared by tools/build-events.mjs, the maintenance tools and the tests. No dependencies.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PATHS = {
  source: join(ROOT, 'data', 'schedule.source.json'),
  patches: join(ROOT, 'data', 'patches.json'),
  lock: join(ROOT, 'data', 'schedule.lock.json'),
  output: join(ROOT, 'events-data.js'),
};

export const STATUSES = ['confirmed', 'documented', 'unverified', 'disputed', 'recheck'];
export const NEEDS_CHECK = new Set(['unverified', 'disputed', 'recheck']);
export const EVIDENCE_KINDS = ['source', 'official', 'in-game'];
export const KINDS = ['world-boss', 'meta'];
/** Two times this close (minutes) count as agreeing: start announcements and pre-events vary by a minute. */
export const AGREE_TOLERANCE_MIN = 2;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

export function loadAll(paths = PATHS) {
  return {
    source: readJson(paths.source),
    patches: readJson(paths.patches),
    lock: existsSync(paths.lock) ? readJson(paths.lock) : null,
  };
}

/** JSON with object keys sorted at every level, so equal data always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
export const sha = (v) => 'sha256:' + createHash('sha256').update(typeof v === 'string' ? v : canonical(v)).digest('hex');

/** A waypoint chat link is base64 of 0x04 then the waypoint id as a 32-bit little-endian number. */
export function decodeChat(chat) {
  const m = /^\[&([A-Za-z0-9+/]+=*)\]$/.exec(chat || '');
  if (!m) return null;
  const b = Buffer.from(m[1], 'base64');
  if (b.length !== 5 || b[0] !== 0x04) return null;
  return b.readUInt32LE(1);
}

// ---- What players see: the revision hash covers exactly this (V0.1_PLAN.md section 11.6) ----

export function meaningful(src) {
  return {
    regions: src.regions,
    resets: src.resets.map((r) => ({ id: r.id, name: r.name, rule: r.rule })),
    cycles: src.cycles.map((c) => ({ id: c.id, name: c.name, maps: c.maps, periodMin: c.periodMin, phases: c.phases, status: c.verification.status })),
    events: src.events.map((e) => ({
      id: e.id, name: e.name, kind: e.kind, region: e.region, map: e.map, apiId: e.apiId,
      waypoint: e.waypoint, wiki: e.wiki, schedule: e.schedule, adjustable: e.adjustable, note: e.note,
      status: e.verification.status, needsInGameCheck: e.verification.needsInGameCheck, flag: e.verification.flag,
    })),
    retired: src.retired,
  };
}

/** Every timed thing, keyed for the lock: its schedule hash and its evidence list. */
export function items(src) {
  const out = [];
  for (const e of src.events) out.push({ key: `event:${e.id}`, schedule: e.schedule, evidence: e.verification.evidence });
  for (const c of src.cycles) out.push({ key: `cycle:${c.id}`, schedule: { periodMin: c.periodMin, phases: c.phases }, evidence: c.verification.evidence });
  for (const r of src.resets) out.push({ key: `reset:${r.id}`, schedule: r.rule, evidence: r.evidence });
  return out;
}

// ---- The build rules (V0.1_PLAN.md section 3.5) ----

function checkEvidence(where, list, sources, errors) {
  if (!Array.isArray(list) || list.length === 0) { errors.push(`${where}: no evidence`); return; }
  list.forEach((ev, i) => {
    const at = `${where}: evidence ${i + 1}`;
    if (!EVIDENCE_KINDS.includes(ev.kind)) errors.push(`${at}: unknown kind ${ev.kind}`);
    if (ev.kind === 'in-game') { if (!/^sighting:[a-z0-9-]+$/.test(ev.ref || '')) errors.push(`${at}: an in-game ref must be sighting:<id>`); }
    else if (!sources[ev.ref]) errors.push(`${at}: unknown source ${ev.ref}`);
    if (!DATE.test(ev.on || '')) errors.push(`${at}: "on" must be a date`);
    if (!DATE.test(ev.checked || '')) errors.push(`${at}: "checked" must be a date`);
    if (typeof ev.agrees !== 'boolean') errors.push(`${at}: "agrees" must be true or false`);
  });
}
const newestChecked = (list) => list.reduce((m, e) => (e.checked > m ? e.checked : m), '');

function checkSchedule(where, s, errors) {
  const int = (n) => Number.isInteger(n);
  if (!s || !['every', 'daily'].includes(s.type)) { errors.push(`${where}: schedule type must be every or daily`); return; }
  if (!int(s.windowMin) || s.windowMin < 1) errors.push(`${where}: windowMin must be a positive whole number`);
  if (s.type === 'every') {
    if (!int(s.periodMin) || s.periodMin < 1 || 1440 % s.periodMin !== 0) errors.push(`${where}: periodMin must divide a day (1440)`);
    if (!int(s.offsetMin) || s.offsetMin < 0 || s.offsetMin >= s.periodMin) errors.push(`${where}: offsetMin must be 0 to periodMin - 1`);
    if (s.windowMin > s.periodMin) errors.push(`${where}: the window is longer than the period`);
  } else {
    const a = s.startsUtc;
    if (!Array.isArray(a) || a.length === 0) errors.push(`${where}: daily needs startsUtc`);
    else {
      if (!a.every((m) => int(m) && m >= 0 && m <= 1439)) errors.push(`${where}: startsUtc values must be 0 to 1439`);
      if (!a.every((m, i) => i === 0 || m > a[i - 1])) errors.push(`${where}: startsUtc must be sorted with no repeats`);
    }
  }
}

function checkStatus(where, v, schedule, adjustable, errors) {
  if (!STATUSES.includes(v.status)) { errors.push(`${where}: unknown status ${v.status}`); return; }
  const ev = v.evidence || [];
  const agreeingRefs = new Set(ev.filter((e) => e.agrees && e.kind !== 'in-game').map((e) => e.ref));
  const needs = NEEDS_CHECK.has(v.status);
  if (v.needsInGameCheck !== needs) errors.push(`${where}: needsInGameCheck must be ${needs} for ${v.status}`);
  if (v.status === 'recheck') {
    if (!v.flag || !DATE.test(v.flag.patch || '') || !v.flag.reason) errors.push(`${where}: recheck needs a flag with a patch and a reason`);
  } else if (v.flag) errors.push(`${where}: only recheck may carry a flag`);
  if (v.status === 'confirmed' && !ev.some((e) => e.kind === 'in-game' && e.agrees)) errors.push(`${where}: confirmed needs an agreeing in-game check`);
  if (v.status === 'documented' && agreeingRefs.size < 2) errors.push(`${where}: documented needs two agreeing sources, has ${agreeingRefs.size}`);
  if (v.status === 'disputed' && !ev.some((e) => !e.agrees)) errors.push(`${where}: disputed needs a disagreeing piece of evidence`);
  if (adjustable && (!needs || schedule.type !== 'every')) errors.push(`${where}: adjustable only on an every schedule that is unverified, disputed or recheck`);
}

/** All the rules; returns a list of problems (empty when the dataset is sound). */
export function validate(src, patches, lock) {
  const errors = [];
  const sources = src.sources || {};
  const m = src.meta || {};
  if (!Number.isInteger(m.datasetRevision) || m.datasetRevision < 1) errors.push('meta.datasetRevision must be a whole number from 1');
  for (const k of ['reviewedOn', 'verifiedOn', 'reviewedThroughPatch']) if (!DATE.test(m[k] || '')) errors.push(`meta.${k} must be a date`);
  for (const r of m.verifiedAgainst || []) if (!sources[r]) errors.push(`meta.verifiedAgainst: unknown source ${r}`);

  const patchIds = new Set();
  for (const p of patches.reviews || []) {
    if (!DATE.test(p.id || '')) errors.push(`patches: id ${p.id} must be a date`);
    if (patchIds.has(p.id)) errors.push(`patches: ${p.id} recorded twice`);
    patchIds.add(p.id);
    if (!DATE.test(p.reviewedOn || '') || !p.title || !/^https:\/\//.test(p.url || '')) errors.push(`patches: ${p.id} needs title, https url and reviewedOn`);
    if (!['full-read', 'keyword-scan'].includes(p.mode)) errors.push(`patches: ${p.id} mode must be full-read or keyword-scan`);
  }
  if (!patchIds.has(m.reviewedThroughPatch)) errors.push(`meta.reviewedThroughPatch ${m.reviewedThroughPatch} is not in data/patches.json`);
  else if ([...patchIds].some((id) => id > m.reviewedThroughPatch)) errors.push('meta.reviewedThroughPatch is older than a recorded review');

  const regionIds = new Set((src.regions || []).map((r) => r.id));
  const ids = new Set();
  for (const e of src.events || []) {
    const where = `event ${e.id}`;
    if (!ID.test(e.id || '')) errors.push(`${where}: id must be lowercase words joined by hyphens`);
    if (ids.has(e.id)) errors.push(`${where}: duplicate id`);
    ids.add(e.id);
    if (!e.name || !e.map) errors.push(`${where}: needs a name and a map`);
    if (!KINDS.includes(e.kind)) errors.push(`${where}: kind must be ${KINDS.join(' or ')}`);
    if (!regionIds.has(e.region)) errors.push(`${where}: unknown region ${e.region}`);
    checkSchedule(where, e.schedule, errors);
    const poi = decodeChat(e.waypoint && e.waypoint.chat);
    if (poi === null) errors.push(`${where}: waypoint chat link does not decode`);
    else if (poi !== e.waypoint.poi) errors.push(`${where}: chat link is waypoint ${poi}, not ${e.waypoint.poi}`);
    if (e.wiki !== null && typeof e.wiki !== 'string') errors.push(`${where}: wiki must be a page title or null`);
    if (typeof e.adjustable !== 'boolean') errors.push(`${where}: adjustable must be true or false`);
    const v = e.verification || {};
    checkEvidence(where, v.evidence, sources, errors);
    if (v.evidence && v.evidence.length && v.lastVerifiedOn !== newestChecked(v.evidence)) errors.push(`${where}: lastVerifiedOn must be the newest evidence date (${newestChecked(v.evidence)})`);
    if (!patchIds.has(v.lastReviewedPatch)) errors.push(`${where}: lastReviewedPatch ${v.lastReviewedPatch} is not a recorded review`);
    checkStatus(where, v, e.schedule || {}, e.adjustable, errors);
  }
  for (const c of src.cycles || []) {
    const sum = (c.phases || []).reduce((a, p) => a + p.durMin, 0);
    if (sum !== c.periodMin) errors.push(`cycle ${c.id}: phases add up to ${sum}, not ${c.periodMin}`);
    checkEvidence(`cycle ${c.id}`, c.verification && c.verification.evidence, sources, errors);
  }
  for (const r of src.resets || []) checkEvidence(`reset ${r.id}`, r.evidence, sources, errors);

  const allEvidence = items(src).flatMap((i) => i.evidence || []);
  if (allEvidence.length && m.verifiedOn !== newestChecked(allEvidence)) errors.push(`meta.verifiedOn must be the newest evidence date (${newestChecked(allEvidence)})`);

  const retired = new Set((src.retired || []).map((r) => r.id));
  if (lock) {
    for (const key of Object.keys(lock.schedules)) {
      const [type, id] = key.split(':');
      if (type === 'event' && !ids.has(id) && !retired.has(id)) errors.push(`event ${id} disappeared; list it under "retired" instead`);
    }
    for (const it of items(src)) {
      const was = lock.evidence[it.key];
      if (was) {
        const kept = (it.evidence || []).slice(0, was.count);
        if (kept.length < was.count || sha(kept) !== was.hash) errors.push(`${it.key}: evidence is append-only; earlier entries were changed or removed`);
      }
      const before = lock.schedules[it.key];
      if (before && before !== sha(it.schedule)) {
        const added = (it.evidence || []).slice(was ? was.count : 0).filter((e) => e.agrees);
        const strong = added.some((e) => e.kind === 'in-game' || e.kind === 'official');
        const sourceRefs = new Set(added.filter((e) => e.kind === 'source').map((e) => e.ref));
        if (!strong && sourceRefs.size < 2) errors.push(`${it.key}: schedule changed without new supporting evidence (an in-game check, an ArenaNet statement, or two sources)`);
      }
    }
  }
  return errors;
}

/** Revision bookkeeping: what changed since the lock and whether the revision number matches. */
export function revisionState(src, lock) {
  const hash = sha(meaningful(src));
  if (!lock) return { hash, changed: true, kind: 'initial', problem: src.meta.datasetRevision === 1 ? null : 'the first dataset must be revision 1' };
  const changed = hash !== lock.revisionHash;
  const schedulesNow = Object.fromEntries(items(src).map((i) => [i.key, sha(i.schedule)]));
  const keys = new Set([...Object.keys(schedulesNow), ...Object.keys(lock.schedules)]);
  const scheduleChanged = [...keys].filter((k) => schedulesNow[k] !== lock.schedules[k]);
  const kind = scheduleChanged.length ? 'schedule' : 'metadata';
  let problem = null;
  if (changed && src.meta.datasetRevision === lock.datasetRevision) problem = `meaningful data changed (${kind}); bump meta.datasetRevision to ${lock.datasetRevision + 1} (node tools/build-events.mjs --bump)`;
  else if (changed && src.meta.datasetRevision !== lock.datasetRevision + 1) problem = `meta.datasetRevision must be ${lock.datasetRevision + 1}`;
  else if (!changed && src.meta.datasetRevision !== lock.datasetRevision) problem = `meta.datasetRevision moved to ${src.meta.datasetRevision} but nothing players see changed; it must stay ${lock.datasetRevision}`;
  return { hash, changed, kind, scheduleChanged, problem };
}

export function nextLock(src, lock, today) {
  const st = revisionState(src, lock);
  const history = lock ? lock.history.slice() : [];
  if (st.changed) history.push({ revision: src.meta.datasetRevision, date: today, kind: st.kind, hash: st.hash, scheduleChanged: st.scheduleChanged || [] });
  return {
    $comment: 'Written by tools/build-events.mjs. Do not edit by hand.',
    datasetRevision: src.meta.datasetRevision,
    revisionHash: st.hash,
    schedules: Object.fromEntries(items(src).map((i) => [i.key, sha(i.schedule)])),
    evidence: Object.fromEntries(items(src).map((i) => [i.key, { count: (i.evidence || []).length, hash: sha(i.evidence || []) }])),
    history,
  };
}

// ---- The file the page loads ----

export function publicData(src, patches) {
  const through = (patches.reviews || []).find((p) => p.id === src.meta.reviewedThroughPatch);
  return {
    meta: {
      datasetRevision: src.meta.datasetRevision,
      reviewedOn: src.meta.reviewedOn,
      reviewedThroughPatch: src.meta.reviewedThroughPatch,
      reviewedThroughTitle: through ? through.title : '',
      verifiedOn: src.meta.verifiedOn,
    },
    regions: src.regions,
    resets: src.resets.map((r) => ({ id: r.id, name: r.name, rule: r.rule })),
    cycles: src.cycles.map((c) => ({ id: c.id, name: c.name, maps: c.maps, periodMin: c.periodMin, phases: c.phases })),
    events: src.events.map((e) => ({
      id: e.id, name: e.name, kind: e.kind, region: e.region, map: e.map,
      waypoint: { name: e.waypoint.name, chat: e.waypoint.chat },
      wiki: e.wiki, schedule: e.schedule, adjustable: e.adjustable, note: e.note,
      status: e.verification.status,
      flag: e.verification.flag ? { patch: e.verification.flag.patch, reason: e.verification.flag.reason } : null,
    })),
  };
}

export function renderOutput(src, patches) {
  return [
    '// Generated by tools/build-events.mjs from data/schedule.source.json. Do not edit.',
    '(function (root) {',
    "  'use strict';",
    '  var data = ' + JSON.stringify(publicData(src, patches), null, 1).replace(/\n/g, '\n  ') + ';',
    "  if (typeof module === 'object' && module.exports) module.exports = data;",
    '  else root.GW2_DATA = data;',
    "})(typeof globalThis !== 'undefined' ? globalThis : this);",
    '',
  ].join('\n');
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
