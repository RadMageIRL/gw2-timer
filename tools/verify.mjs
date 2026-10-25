// Records verification evidence for one event (docs/MAINTENANCE.md, local). It never changes a
// schedule. A disagreeing sighting marks the event disputed and prints the schedule it implies; a
// schedule edit stays a hand edit, which the build accepts only with supporting evidence.
//
//   node tools/verify.mjs <id> --method in-game --seen 2026-10-26T21:15Z [--note "..."]
//   node tools/verify.mjs <id> --method official --ref <source id> --on YYYY-MM-DD --agrees yes|no [--note "..."]
//   node tools/verify.mjs <id> --method sources  --ref <source id> --on YYYY-MM-DD --agrees yes|no [--note "..."]
//
// In-game details (the exact time seen, notes) go to local/sightings/ and are never published; the
// dataset records only that an in-game check happened, on which day, and whether it agreed.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, PATHS, AGREE_TOLERANCE_MIN, readJson, writeJson, today } from './lib/dataset.mjs';

const S = createRequire(import.meta.url)('../js/schedule.js');

/** How far a seen start is from the nearest scheduled start, in whole minutes (negative = early). */
export function deltaMinutes(schedule, seenMs) {
  const next = S.nextStart(schedule, seenMs - 1); // at or after the sighting
  // The latest start at or before the sighting, even if its window has already closed.
  let prev = S.nextStart(schedule, seenMs - S.DAY - 1);
  for (let s = prev; s <= seenMs; s = S.nextStart(schedule, s)) prev = s;
  const nearest = Math.abs(next - seenMs) < Math.abs(seenMs - prev) ? next : prev;
  return Math.round((seenMs - nearest) / S.MIN);
}

/** The pure part: adds the evidence and moves the status as the procedure says. Returns a summary. */
export function recordEvidence(source, opts) {
  const e = source.events.find((x) => x.id === opts.id);
  if (!e) throw new Error(`unknown event ${opts.id}`);
  const v = e.verification;
  const checked = opts.date || today();
  let entry, implied = null, agrees;
  if (opts.method === 'in-game') {
    const seenMs = Date.parse(opts.seen || '');
    if (!Number.isFinite(seenMs)) throw new Error('--seen must be a UTC time like 2026-10-26T21:15Z');
    const delta = deltaMinutes(e.schedule, seenMs);
    agrees = Math.abs(delta) <= AGREE_TOLERANCE_MIN;
    if (!agrees && e.schedule.type === 'every') {
      implied = Object.assign({}, e.schedule, { offsetMin: ((Math.floor(seenMs / S.MIN) % e.schedule.periodMin) + e.schedule.periodMin) % e.schedule.periodMin });
    }
    const sightingId = `${new Date(seenMs).toISOString().slice(0, 10)}-${e.id}-${String(new Date(seenMs).getUTCHours()).padStart(2, '0')}${String(new Date(seenMs).getUTCMinutes()).padStart(2, '0')}`;
    entry = { kind: 'in-game', ref: `sighting:${sightingId}`, on: new Date(seenMs).toISOString().slice(0, 10), checked, agrees };
    if (opts.sightingsDir !== null) {
      const dir = opts.sightingsDir || join(ROOT, 'local', 'sightings');
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${sightingId}.json`);
      if (existsSync(file)) throw new Error(`sighting ${sightingId} is already recorded`);
      writeFileSync(file, JSON.stringify({ id: sightingId, event: e.id, seenUtc: new Date(seenMs).toISOString(), deltaMin: delta, agrees, scheduleAtTheTime: e.schedule, note: opts.note || '', recordedOn: checked }, null, 2) + '\n');
    }
  } else if (opts.method === 'official' || opts.method === 'sources') {
    if (!source.sources[opts.ref]) throw new Error(`unknown source ${opts.ref}; add it to "sources" first`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.on || '')) throw new Error('--on must be the date of the source');
    if (!['yes', 'no'].includes(opts.agrees)) throw new Error('--agrees must be yes or no');
    agrees = opts.agrees === 'yes';
    entry = { kind: opts.method === 'official' ? 'official' : 'source', ref: opts.ref, on: opts.on, checked, agrees };
  } else throw new Error('--method must be in-game, official or sources');
  if (opts.note && opts.method !== 'in-game') entry.note = opts.note;
  v.evidence.push(entry);
  v.lastVerifiedOn = checked;
  v.method = opts.method;
  if (checked > source.meta.verifiedOn) source.meta.verifiedOn = checked;

  const before = v.status;
  if (opts.method === 'in-game' && agrees) {
    v.status = 'confirmed'; v.needsInGameCheck = false; v.flag = null;
    if (e.adjustable) e.adjustable = false; // a confirmed time needs no override
  } else if (!agrees) {
    v.status = 'disputed'; v.needsInGameCheck = true; v.flag = null;
  } else if (v.status === 'recheck') {
    const refs = new Set(v.evidence.filter((x) => x.agrees && x.kind !== 'in-game' && x.checked >= v.flag.patch).map((x) => x.ref));
    if (refs.size >= 2) { v.status = 'documented'; v.needsInGameCheck = false; v.flag = null; }
  }
  return { id: e.id, before, after: v.status, agrees, implied };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i++; } else out._.push(argv[i]); }
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('verify.mjs')) {
  try {
    const a = args(process.argv.slice(2));
    const source = readJson(PATHS.source);
    const r = recordEvidence(source, { id: a._[0], method: a.method, seen: a.seen, ref: a.ref, on: a.on, agrees: a.agrees, note: a.note });
    writeJson(PATHS.source, source);
    console.log(`${r.id}: evidence recorded (${r.agrees ? 'agrees' : 'disagrees'}); status ${r.before} -> ${r.after}.`);
    if (r.implied) console.log(`The sighting implies ${S.ruleText(r.implied)}. The schedule was NOT changed; edit it by hand if the evidence supports it.`);
    console.log('Next: node tools/build-events.mjs --bump, then node tools/verification-report.mjs');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
