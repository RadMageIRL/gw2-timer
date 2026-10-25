// Writes the human-readable maintenance report: local/reports/verification-<date>.md (never committed).
//   node tools/verification-report.mjs [--out <file>]
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, PATHS, readJson, today } from './lib/dataset.mjs';

const S = createRequire(import.meta.url)('../js/schedule.js');
const SECTIONS = [
  ['confirmed', 'Confirmed (seen in game)'],
  ['disputed', 'Disputed (sources disagree)'],
  ['recheck', 'Recheck pending (flagged by a patch review)'],
  ['unverified', 'Unverified'],
  ['documented', 'Documented (two or more sources agree; not yet seen in game)'],
];

export function report(source, patches, lock, appVersion, date = today()) {
  const ev = (list) => list.flatMap((e) => e.verification.evidence);
  const all = ev(source.events);
  const lastInGame = all.filter((x) => x.kind === 'in-game').map((x) => x.checked).sort().pop();
  const through = patches.reviews.find((p) => p.id === source.meta.reviewedThroughPatch);
  const count = (s) => source.events.filter((e) => e.verification.status === s).length;
  const L = [];
  L.push(`# GW2 Timer verification report, ${date}`, '');
  L.push(`- App version: v${appVersion}`);
  L.push(`- Schedule dataset: r${source.meta.datasetRevision}`);
  L.push(`- Latest patch review: ${source.meta.reviewedThroughPatch}${through ? ` (${through.title}, ${through.mode})` : ''}, reviewed ${source.meta.reviewedOn}`);
  L.push(`- Last direct or independently sourced verification: ${source.meta.verifiedOn} (against ${source.meta.verifiedAgainst.join(', ')})`);
  L.push(`- Last in-game verification: ${lastInGame || 'none yet'}`);
  L.push(`- Events: ${source.events.length}. ${SECTIONS.map(([s]) => `${s} ${count(s)}`).join(', ')}.`);
  const buildSeen = patches.reviews.map((p) => p.buildObserved).filter(Boolean).pop();
  if (buildSeen) L.push(`- Client build at the last review: ${buildSeen.id} (observed ${buildSeen.observedOn})`);
  L.push('');
  for (const [status, title] of SECTIONS) {
    const list = source.events.filter((e) => e.verification.status === status);
    L.push(`## ${title}: ${list.length}`, '');
    if (!list.length) { L.push('None.', ''); continue; }
    L.push('| Event | Schedule (UTC) | Last reviewed patch | Last verified | Method | In-game check needed | Evidence |', '|---|---|---|---|---|---|---|');
    for (const e of list) {
      const v = e.verification;
      const evidence = v.evidence.map((x) => `${x.agrees ? 'agrees' : 'DISAGREES'}: ${x.ref} (${x.on})${x.note ? ` - ${x.note}` : ''}`).join('<br>');
      const flag = v.flag ? `<br>Flag: ${v.flag.patch}, ${v.flag.reason}` : '';
      L.push(`| ${e.name}${e.adjustable ? ' (adjustable)' : ''} | ${S.ruleText(e.schedule)} | ${v.lastReviewedPatch} | ${v.lastVerifiedOn} | ${v.method} | ${v.needsInGameCheck ? 'yes' : 'no'} | ${evidence}${flag} |`);
    }
    L.push('');
  }
  L.push('## Day/night cycles and resets', '');
  for (const c of source.cycles) L.push(`- ${c.name}: ${c.phases.map((p) => `${p.name} ${p.durMin} min`).join(', ')} (${c.verification.status}, verified ${c.verification.lastVerifiedOn})`);
  for (const r of source.resets) L.push(`- ${r.name}: ${r.rule.type === 'weekly' ? 'Monday 07:30 UTC' : 'daily 00:00 UTC'} (${r.evidence.map((x) => x.ref).join(', ')})`);
  L.push('', '## Patch reviews, newest first', '');
  for (const p of patches.reviews.slice().reverse()) {
    L.push(`### ${p.id}: ${p.title} (${p.mode}, reviewed ${p.reviewedOn})`, '', `Result: ${p.result}.`);
    if (p.flagged.length) L.push(`Flagged: ${p.flagged.map((f) => `${f.id} (${f.reason})`).join('; ')}`);
    for (const f of p.findings) L.push(`- ${f}`);
    if (p.newContent.length) L.push(`- New content noted: ${p.newContent.join('; ')}`);
    L.push('');
  }
  if (patches.upcoming && patches.upcoming.length) {
    L.push('## Coming up (review after these)', '');
    for (const u of patches.upcoming) L.push(`- ${u.date}: ${u.what}`);
    L.push('');
  }
  if (lock) {
    L.push('## Dataset revisions', '');
    for (const h of lock.history) L.push(`- r${h.revision} (${h.date}): ${h.kind === 'initial' ? 'first dataset' : h.kind === 'schedule' ? 'schedule change' : 'metadata only'}${h.scheduleChanged && h.scheduleChanged.length ? `: ${h.scheduleChanged.join(', ')}` : ''}`);
    L.push('');
  }
  L.push('A patch review that does not mention an event is not a verification of it. Only an in-game check, an ArenaNet statement, or agreeing independent sources verify a time.', '');
  return L.join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('verification-report.mjs')) {
  const source = readJson(PATHS.source), patches = readJson(PATHS.patches), lock = readJson(PATHS.lock);
  const version = /^## v(\d+\.\d+\.\d+)/m.exec(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'))[1];
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : join(ROOT, 'local', 'reports', `verification-${today()}.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, report(source, patches, lock, version));
  console.log(`Wrote ${out}`);
}
