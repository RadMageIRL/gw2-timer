// Checks data/schedule.source.json against every rule and writes events-data.js (what the page loads),
// data/schedule.lock.json (the revision record) and the event index in index.html ("Events this
// timer covers", made from the same data as events-data.js; see tools/lib/event-index.mjs).
//
//   node tools/build-events.mjs           check, then write all three
//   node tools/build-events.mjs --bump    as above, raising the dataset revision first if meaningful data changed
//   node tools/build-events.mjs --check   write nothing; fail if a file would change (tests and the release build)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PATHS, loadAll, validate, revisionState, nextLock, renderOutput, publicData, writeJson, today } from './lib/dataset.mjs';
import { applyEventIndex } from './lib/event-index.mjs';

export function buildEvents({ check = false, bump = false, paths = PATHS, date = today(), log = console.log } = {}) {
  const { source, patches, lock } = loadAll(paths);
  const errors = validate(source, patches, lock);
  if (errors.length) return { ok: false, errors };

  let st = revisionState(source, lock);
  if (bump && st.changed && lock && source.meta.datasetRevision === lock.datasetRevision) {
    if (check) return { ok: false, errors: ['--bump cannot be combined with --check'] };
    source.meta.datasetRevision = lock.datasetRevision + 1;
    writeJson(paths.source, source);
    log(`Raised the dataset revision to r${source.meta.datasetRevision} (${st.kind}).`);
    st = revisionState(source, lock);
  }
  if (st.problem) return { ok: false, errors: [st.problem] };

  const output = renderOutput(source, patches);
  const newLock = nextLock(source, lock, date);
  // The page's event index, from the same object that events-data.js holds.
  const page = paths.page && existsSync(paths.page) ? readFileSync(paths.page, 'utf8') : null;
  let newPage = page;
  if (page !== null) {
    try { newPage = applyEventIndex(page, publicData(source, patches)); } catch (e) { return { ok: false, errors: [e.message] }; }
  }
  if (check) {
    const problems = [];
    if (!existsSync(paths.output) || readFileSync(paths.output, 'utf8') !== output) problems.push('events-data.js is out of date: run node tools/build-events.mjs');
    if (newPage !== page) problems.push('the event index in index.html is out of date: run node tools/build-events.mjs');
    if (st.changed) problems.push(`data changed since the lock (r${lock ? lock.datasetRevision : 0}): run node tools/build-events.mjs`);
    else if (JSON.stringify(newLock) !== JSON.stringify(lock)) problems.push('schedule.lock.json is out of date: run node tools/build-events.mjs');
    return problems.length ? { ok: false, errors: problems } : { ok: true, revision: source.meta.datasetRevision, changed: false };
  }
  writeFileSync(paths.output, output);
  writeJson(paths.lock, newLock);
  if (newPage !== page) writeFileSync(paths.page, newPage);
  return { ok: true, revision: source.meta.datasetRevision, changed: st.changed, kind: st.kind };
}

if (process.argv[1] && process.argv[1].endsWith('build-events.mjs')) {
  const args = process.argv.slice(2);
  const r = buildEvents({ check: args.includes('--check'), bump: args.includes('--bump') });
  if (!r.ok) {
    console.error('Schedule data refused:\n  ' + r.errors.join('\n  '));
    process.exit(1);
  }
  console.log(args.includes('--check')
    ? `Schedule data r${r.revision}: every rule passes and the generated files are current.`
    : `Schedule data r${r.revision}${r.changed ? ` (${r.kind})` : ''}: wrote events-data.js, data/schedule.lock.json and the event index in index.html.`);
}
