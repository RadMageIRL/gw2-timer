// Checks every waypoint in the dataset against the official API: the id exists, it is a waypoint,
// the name and map match, and the API's own chat link is the one we copy. Maintainer tool (network).
//   node tools/check-waypoints.mjs [--cache local/cache]   (reuses floor files saved there)
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, PATHS, readJson } from './lib/dataset.mjs';

const FLOORS = [1, 49];

async function floor(n, cacheDir) {
  const file = cacheDir && join(cacheDir, `floor${n}.json`);
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(`https://api.guildwars2.com/v2/continents/1/floors/${n}`);
  if (!res.ok) throw new Error(`floor ${n}: HTTP ${res.status}`);
  const text = await res.text();
  if (file) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, text); }
  return JSON.parse(text);
}

export function indexFloors(floors) {
  const idx = new Map();
  for (const fl of floors) for (const reg of Object.values(fl.regions)) for (const m of Object.values(reg.maps)) {
    for (const p of Object.values(m.points_of_interest || {})) if (!idx.has(p.id)) idx.set(p.id, { name: p.name, type: p.type, chat: p.chat_link, map: m.name });
  }
  return idx;
}

export function checkWaypoints(source, idx) {
  return source.events.map((e) => {
    const w = e.waypoint, api = idx.get(w.poi);
    const problems = [];
    if (!api) problems.push('not in the API floors');
    else {
      if (api.type !== 'waypoint') problems.push(`API type is ${api.type}`);
      if (api.chat !== w.chat) problems.push(`API chat link is ${api.chat}`);
      if (api.name !== w.name) problems.push(`API name is ${api.name}`);
      if (api.map !== w.map) problems.push(`API map is ${api.map}`);
    }
    return { id: e.id, chat: w.chat, problems };
  });
}

if (process.argv[1] && process.argv[1].endsWith('check-waypoints.mjs')) {
  const i = process.argv.indexOf('--cache');
  const cache = i > 0 ? join(ROOT, process.argv[i + 1]) : null;
  const floors = [];
  for (const n of FLOORS) floors.push(await floor(n, cache));
  const results = checkWaypoints(readJson(PATHS.source), indexFloors(floors));
  const bad = results.filter((r) => r.problems.length);
  for (const r of bad) console.log(`${r.id} ${r.chat}: ${r.problems.join('; ')}`);
  console.log(`${results.length - bad.length} of ${results.length} waypoints match the official API${cache ? ' (cached floors)' : ''}.`);
  process.exit(bad.length ? 1 : 0);
}
