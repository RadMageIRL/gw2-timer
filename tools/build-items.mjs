// The Trading Post item list: every item with a Trading Post price, as data/tp-items.json (what the page
// searches) and data/tp-items.lock.json (its record: when, which game build, how many, and a SHA-256).
//
// A refresh is a maintainer's job, done by hand during a schedule review and committed only after review,
// like a schedule revision (docs/MAINTENANCE.md). Nothing runs it on a schedule and nothing commits it.
//
//   node tools/build-items.mjs --check                 the list and its lock agree, and the page can read it
//   node tools/build-items.mjs --fetch [--save <dir>]  read the API now and rewrite both files (about 142 requests)
//   node tools/build-items.mjs --from <dir> --as-of <ISO time> --build <id>
//                                                      rebuild from saved pages (items-*.json and prices-ids.json)
//
// The same answers always give the same bytes: rows in id order, types sorted, rarities in the game's order.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const Catalog = createRequire(import.meta.url)('../js/catalog.js');
export const PATHS = { list: join(ROOT, 'data', 'tp-items.json'), lock: join(ROOT, 'data', 'tp-items.lock.json') };
/** The game's own order, lowest first. A rarity the API adds later goes after these, by name. */
export const RARITY_ORDER = ['Junk', 'Basic', 'Fine', 'Masterwork', 'Rare', 'Exotic', 'Ascended', 'Legendary'];
const API = 'https://api.guildwars2.com';
const SCHEMA = '2025-08-29T01:00:00Z';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
// Built from code points so that no dash character sits in this file.
const EM_DASH = String.fromCharCode(0x2014), EN_DASH = String.fromCharCode(0x2013);
/**
 * A name as one clean line: control characters (tabs and line breaks too) become spaces, runs of spaces one.
 * Dashes become hyphens, as the news headlines do (js/news.js): an em dash with spaces around it, so
 * "Light of Deldrimor Plate" + em dash + "Bottom Half" reads "... Plate - Bottom Half", an en dash without.
 * No project file holds a dash character.
 */
export const cleanName = (s) => String(s || '').split(EM_DASH).join(' - ').split(EN_DASH).join('-')
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The list and its lock from item records and the ids that have a price.
 * Returns { text, lock, skipped: { noRecord, emptyName } }. Throws on records that are not items.
 */
export function buildIndex({ items, priceIds, asOf, build }) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(asOf || '')) throw new Error('asOf must be an ISO time in whole seconds, UTC');
  if (!Number.isSafeInteger(build) || build <= 0) throw new Error('build must be the game build id');
  const priced = new Set(priceIds.filter((x) => Number.isSafeInteger(x) && x > 0));
  const byId = new Map();
  for (const it of items) {
    if (!it || !Number.isSafeInteger(it.id) || typeof it.name !== 'string' || typeof it.type !== 'string' || typeof it.rarity !== 'string') throw new Error(`not an item record: ${JSON.stringify(it).slice(0, 80)}`);
    if (priced.has(it.id)) byId.set(it.id, it);
  }
  const ids = [...byId.keys()].sort((a, b) => a - b);
  let emptyName = 0;
  const kept = [];
  for (const id of ids) {
    const it = byId.get(id), name = cleanName(it.name);
    if (!name) { emptyName++; continue; }
    kept.push({ id, name, type: it.type, rarity: it.rarity, level: Number.isInteger(it.level) && it.level >= 0 && it.level <= 80 ? it.level : 0 });
  }
  const types = [...new Set(kept.map((r) => r.type))].sort();
  const seen = new Set(kept.map((r) => r.rarity));
  const rarities = RARITY_ORDER.filter((r) => seen.has(r)).concat([...seen].filter((r) => !RARITY_ORDER.includes(r)).sort());
  let prev = 0;
  const rows = kept.map((r) => { const line = `${r.id - prev}\t${r.name}\t${types.indexOf(r.type)}\t${rarities.indexOf(r.rarity)}\t${r.level}`; prev = r.id; return line; }).join('\n');
  const text = JSON.stringify({ format: Catalog.FORMAT, asOf, build, lang: 'en', count: kept.length, types, rarities, rows }) + '\n';
  const lock = {
    format: Catalog.FORMAT, asOf, build, lang: 'en',
    source: 'api.guildwars2.com: the ids in /v2/commerce/prices, named by /v2/items (English)',
    count: kept.length, pricedIds: priced.size, noItemRecord: priced.size - ids.length, emptyName,
    bytes: Buffer.byteLength(text), sha256: sha256(text),
  };
  return { text, lock, skipped: { noRecord: lock.noItemRecord, emptyName } };
}

/** The list on disk agrees with its lock and reads as a list: { ok, errors, catalog }. */
export function checkIndex(paths = PATHS) {
  const errors = [];
  if (!existsSync(paths.list) || !existsSync(paths.lock)) return { ok: false, errors: ['data/tp-items.json or its lock is missing'] };
  const text = readFileSync(paths.list, 'utf8'), lock = JSON.parse(readFileSync(paths.lock, 'utf8'));
  if (sha256(text) !== lock.sha256) errors.push(`sha256 ${sha256(text)} is not the lock's ${lock.sha256}`);
  if (Buffer.byteLength(text) !== lock.bytes) errors.push(`${Buffer.byteLength(text)} bytes, the lock says ${lock.bytes}`);
  const r = Catalog.parse(text);
  if (!r.ok) errors.push(`the page cannot read it: ${r.error}`);
  else {
    if (r.catalog.count !== lock.count) errors.push(`${r.catalog.count} items, the lock says ${lock.count}`);
    if (r.catalog.asOf !== lock.asOf || r.catalog.build !== lock.build) errors.push('asOf or build differ from the lock');
  }
  return { ok: !errors.length, errors, catalog: r.ok ? r.catalog : null, lock };
}

/** Items pages and the priced ids saved in a folder (Phase A's research layout). */
export function readSaved(dir) {
  const items = readdirSync(dir).filter((f) => /^items-\d+\.json$/.test(f)).sort().flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  const priceIds = JSON.parse(readFileSync(join(dir, 'prices-ids.json'), 'utf8'));
  return { items, priceIds };
}

// ---- Reading the API (maintainer only): 2 requests in flight, at least 400 ms apart, 429 and 5xx tried again ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastStart = 0;
async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = Math.max(0, lastStart + 400 - Date.now());
    lastStart = Date.now() + wait;
    await sleep(wait);
    let res;
    try { res = await fetch(url); } catch (e) { await sleep(2000 * (attempt + 1)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
    if (res.status !== 200 && res.status !== 206) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`gave up on ${url}`);
}
async function fetchLive(saveDir) {
  const at = new Date();
  const priceIds = await getJson(`${API}/v2/commerce/prices?v=${SCHEMA}`);
  const { id: build } = await getJson(`${API}/v2/build`);
  const parts = [];
  const sorted = [...priceIds].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 200) parts.push(sorted.slice(i, i + 200));
  const pages = [];
  let k = 0;
  await Promise.all([0, 1].map(async () => { while (k < parts.length) { const n = k++; pages[n] = await getJson(`${API}/v2/items?ids=${parts[n].join(',')}&lang=en&v=${SCHEMA}`); } }));
  if (saveDir) {
    mkdirSync(saveDir, { recursive: true });
    writeFileSync(join(saveDir, 'prices-ids.json'), JSON.stringify(priceIds));
    pages.forEach((p, n) => writeFileSync(join(saveDir, `items-${String(n).padStart(3, '0')}.json`), JSON.stringify(p)));
    writeFileSync(join(saveDir, 'meta.json'), JSON.stringify({ asOf: at.toISOString(), build, requests: parts.length + 2 }, null, 1));
  }
  return { items: pages.flat(), priceIds, build, asOf: at.toISOString().replace(/\.\d{3}Z$/, 'Z'), requests: parts.length + 2 };
}

function write(r) {
  mkdirSync(dirname(PATHS.list), { recursive: true });
  const before = existsSync(PATHS.list) ? Catalog.parse(readFileSync(PATHS.list, 'utf8')) : null;
  writeFileSync(PATHS.list, r.text);
  writeFileSync(PATHS.lock, JSON.stringify(r.lock, null, 2) + '\n');
  const now = Catalog.parse(r.text).catalog;
  if (before && before.ok) {
    const old = new Set(before.catalog.ids), cur = new Set(now.ids);
    console.log(`Compared with the list before: ${now.ids.filter((x) => !old.has(x)).length} added, ${before.catalog.ids.filter((x) => !cur.has(x)).length} removed.`);
  }
  console.log(`Wrote data/tp-items.json: ${r.lock.count} items, ${r.lock.bytes} bytes, sha256 ${r.lock.sha256}`);
  console.log(`Left out: ${r.skipped.noRecord} priced ids with no item record, ${r.skipped.emptyName} with an empty name.`);
}

if (process.argv[1] && process.argv[1].endsWith('build-items.mjs')) {
  const argv = process.argv.slice(2), opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  try {
    if (argv.includes('--check')) {
      const c = checkIndex();
      if (!c.ok) { console.error('Trading Post item list refused:\n  ' + c.errors.join('\n  ')); process.exit(1); }
      console.log(`Trading Post item list: ${c.lock.count} items as of ${c.lock.asOf} (build ${c.lock.build}); the lock and the file agree.`);
    } else if (argv.includes('--fetch')) {
      const live = await fetchLive(opt('save'));
      console.log(`Read the API: ${live.requests} requests.`);
      write(buildIndex(live));
    } else if (opt('from')) {
      const saved = readSaved(opt('from'));
      write(buildIndex({ ...saved, asOf: opt('as-of'), build: Number(opt('build')) }));
    } else {
      console.log('Usage: node tools/build-items.mjs --check | --fetch [--save <dir>] | --from <dir> --as-of <ISO> --build <id>');
      process.exit(2);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
