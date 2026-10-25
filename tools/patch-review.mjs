// Patch-note review (docs/MAINTENANCE.md, local). Reviewing notes FLAGS events; it never changes a
// schedule and never counts as verifying one. A review that finds nothing only moves
// lastReviewedPatch; statuses and verification dates stay as they were.
//
//   node tools/patch-review.mjs fetch
//       Saves ArenaNet's update notes, news and dev tracker feeds to local/patches/feeds/<date>/,
//       writes each unreviewed update's text to local/patches/<id>/notes.txt, the news since the
//       last review to local/patches/<id>/news.txt, and records the current /v2/build id.
//   node tools/patch-review.mjs scan <id>
//       Lists every line of local/patches/<id>/*.txt that mentions an event, a map or a schedule word,
//       plus possible new scheduled content, in local/patches/<id>/hits.txt. Hits are leads, not findings.
//   node tools/patch-review.mjs record <id> --title "..." --url <notes url> --posted YYYY-MM-DD
//       [--flag id,id --reason "..."] [--finding "..."]... [--new "..."]... [--mode full-read|keyword-scan]
//       [--read url,url] [--build <id>]
//       Appends the review to data/patches.json; flagged events become "recheck".
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, PATHS, readJson, writeJson, today } from './lib/dataset.mjs';

export const FEEDS = {
  notes: 'https://en-forum.guildwars2.com/forum/6-game-release-notes.xml/',
  news: 'https://www.guildwars2.com/en/feed/',
  devTracker: 'https://en-forum.guildwars2.com/discover/6.xml/',
  build: 'https://api.guildwars2.com/v2/build',
};

/** Words that suggest a schedule change even when no event or map is named. */
export const SCHEDULE_TERMS = [
  'world boss', 'meta-event', 'meta event', 'event timer', 'timer', 'timing', 'start time', 'schedule', 'cycle', 'rotation',
  'every two hours', 'every three hours', 'every hour', 'minutes earlier', 'minutes later', 'hours earlier', 'hours later',
  'day/night', 'day and night', 'convergence', 'new map', 'map-wide', "hero's choice", 'daily reset', 'weekly reset',
  'halloween', 'wintersday', 'lunar new year', 'dragon bash', 'four winds', 'super adventure', 'festival',
];
const NEW_CONTENT = /\b(new (?:open-world )?map|new convergence|new world boss|new meta-event|meta-event|world boss|convergence)\b/i;

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'");
const toText = (html) => decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d|div|ul|ol)>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, ''))
  .replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block); return m ? m[1] : ''; };

export function feedItems(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    out.push({
      title: toText(tag(m[1], 'title')), link: decode(tag(m[1], 'link')).trim(),
      pubMs: Date.parse(toText(tag(m[1], 'pubDate'))),
      body: toText(tag(m[1], 'content:encoded') || tag(m[1], 'description')),
    });
  }
  return out;
}

/** "Game Update Notes: October 13, 2026" -> "2026-10-13" (the update's release date, the patch id). */
export function patchId(title) {
  const m = /Game Update Notes:\s*([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(title || '');
  if (!m) return null;
  const d = new Date(m[1] + ' 12:00 UTC');
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

/** The terms to look for: fixed schedule words plus every name the dataset knows, mapped to event ids. */
export function terms(source) {
  const map = new Map();
  const add = (t, id) => { const k = t.toLowerCase().trim(); if (k.length < 4) return; if (!map.has(k)) map.set(k, new Set()); if (id) map.get(k).add(id); };
  for (const t of SCHEDULE_TERMS) add(t, null);
  for (const e of source.events) {
    add(e.name, e.id);
    add(e.name.replace(/\s*\(.*\)$/, ''), e.id);
    for (const p of (e.name.match(/\(([^)]+)\)/g) || [])) add(p.slice(1, -1), e.id);
    add(e.map.replace(/\s*\(instance\)$/, ''), e.id);
    if (e.apiId) add(e.apiId.replace(/_/g, ' '), e.id);
    if (e.wiki) add(e.wiki, e.id);
  }
  for (const r of source.regions) add(r.name, null);
  for (const c of source.cycles) add(c.name, null);
  return map;
}

/** Every line of text that mentions a term: [{ line, n, terms, ids }], plus new-content candidates. */
export function scanText(text, termMap, knownNames) {
  const hits = [], newContent = [];
  text.split('\n').forEach((line, i) => {
    const low = line.toLowerCase();
    const found = [...termMap.keys()].filter((t) => low.includes(t));
    if (found.length) {
      const ids = new Set(found.flatMap((t) => [...termMap.get(t)]));
      hits.push({ n: i + 1, line: line.trim(), terms: found, ids: [...ids] });
    }
    if (NEW_CONTENT.test(line) && !knownNames.some((k) => low.includes(k))) newContent.push({ n: i + 1, line: line.trim() });
  });
  return { hits, newContent };
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2), v = argv[i + 1]; i++; if (k in out) out[k] = [].concat(out[k], v); else out[k] = v; }
    else out._.push(a);
  }
  return out;
}

/** Records a review: the pure part, so the tests can run it on copies of the data. */
export function recordReview(source, patches, opts) {
  const id = opts.id;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(id || '')) throw new Error('the patch id must be a date like 2026-11-03');
  if (patches.reviews.some((p) => p.id === id)) throw new Error(`${id} is already recorded`);
  if (!opts.title || !/^https:\/\//.test(opts.url || '')) throw new Error('--title and an https --url are required');
  const flagged = (opts.flag || []).filter(Boolean);
  for (const f of flagged) if (!source.events.some((e) => e.id === f)) throw new Error(`unknown event ${f}`);
  if (flagged.length && !opts.reason) throw new Error('--reason is required with --flag');
  const reviewedOn = opts.date || today();
  patches.reviews.push({
    id, title: opts.title, url: opts.url, postedOn: opts.posted || null, reviewedOn, mode: opts.mode || 'full-read',
    buildObserved: opts.build ? { id: Number(opts.build), observedOn: reviewedOn, source: FEEDS.build } : null,
    sourcesRead: opts.read || [opts.url],
    flagged: flagged.map((f) => ({ id: f, reason: opts.reason })),
    findings: opts.findings || [], newContent: opts.newContent || [],
    result: flagged.length ? 'events flagged for recheck' : 'no schedule changes found',
  });
  patches.reviews.sort((a, b) => a.id.localeCompare(b.id));
  const newest = patches.reviews[patches.reviews.length - 1].id;
  for (const e of source.events) {
    const v = e.verification;
    if (id >= v.lastReviewedPatch) v.lastReviewedPatch = id;
    if (flagged.includes(e.id)) {
      v.flag = { patch: id, reason: opts.reason, previousStatus: v.status === 'recheck' ? (v.flag && v.flag.previousStatus) : v.status };
      v.status = 'recheck';
      v.needsInGameCheck = true;
    }
  }
  source.meta.reviewedOn = reviewedOn;
  source.meta.reviewedThroughPatch = newest;
  return { flagged, result: patches.reviews.find((p) => p.id === id).result };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'gw2-timer maintenance (RadMage Labs)' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  const source = readJson(PATHS.source), patches = readJson(PATHS.patches);
  if (cmd === 'fetch') {
    const dir = join(ROOT, 'local', 'patches', 'feeds', today());
    mkdirSync(dir, { recursive: true });
    const got = {};
    for (const [k, url] of Object.entries(FEEDS)) {
      try { got[k] = await fetchText(url); writeFileSync(join(dir, `${k}.${k === 'build' ? 'json' : 'xml'}`), got[k]); }
      catch (e) { console.log(`Could not fetch ${k} (${e.message}). If Cloudflare blocks it, save the page from a browser into ${dir}.`); }
    }
    if (got.build) console.log(`Client build now: ${JSON.parse(got.build).id}`);
    const last = source.meta.reviewedThroughPatch;
    const updates = feedItems(got.notes || '').map((i) => ({ ...i, id: patchId(i.title) })).filter((i) => i.id && i.id > last);
    if (!updates.length) console.log(`No game update notes newer than ${last}.`);
    const sinceMs = Date.parse(last + 'T00:00:00Z');
    const news = feedItems(got.news || '').filter((i) => i.pubMs >= sinceMs);
    for (const u of updates.sort((x, y) => x.id.localeCompare(y.id))) {
      const pdir = join(ROOT, 'local', 'patches', u.id);
      mkdirSync(pdir, { recursive: true });
      writeFileSync(join(pdir, 'notes.txt'), `${u.title}\n${u.link}\n${new Date(u.pubMs).toISOString()}\n\n${u.body}\n`);
      writeFileSync(join(pdir, 'news.txt'), news.map((n) => `## ${n.title}\n${n.link}\n${new Date(n.pubMs).toISOString()}\n\n${n.body}\n`).join('\n'));
      console.log(`${u.id}: ${u.title}\n  notes and ${news.length} news posts saved in local/patches/${u.id}/. Read them in full, then: node tools/patch-review.mjs scan ${u.id}`);
    }
  } else if (cmd === 'scan') {
    const id = a._[1];
    const pdir = join(ROOT, 'local', 'patches', id || '');
    if (!id || !existsSync(pdir)) throw new Error(`no local/patches/${id}/ folder; run fetch first`);
    const termMap = terms(source);
    const known = source.events.flatMap((e) => [e.name.toLowerCase(), e.map.toLowerCase()]);
    const out = [];
    let total = 0;
    for (const f of readdirSync(pdir).filter((x) => x.endsWith('.txt') && x !== 'hits.txt')) {
      const { hits, newContent } = scanText(readFileSync(join(pdir, f), 'utf8'), termMap, known);
      total += hits.length;
      out.push(`# ${f}: ${hits.length} hits`);
      for (const h of hits) out.push(`line ${h.n} [${h.terms.join(', ')}]${h.ids.length ? ' -> ' + h.ids.join(', ') : ''}\n  ${h.line}`);
      if (newContent.length) out.push(`\n## Possible new scheduled content in ${f} (not in the dataset)`, ...newContent.map((c) => `line ${c.n}: ${c.line}`));
      out.push('');
    }
    out.push('Hits are leads to read, not findings. An event that is not mentioned is NOT verified by this review.');
    writeFileSync(join(pdir, 'hits.txt'), out.join('\n') + '\n');
    console.log(`${total} hits written to local/patches/${id}/hits.txt`);
  } else if (cmd === 'record') {
    const list = (v) => [].concat(v || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    const r = recordReview(source, patches, {
      id: a._[1], title: a.title, url: a.url, posted: a.posted, mode: a.mode, build: a.build,
      flag: list(a.flag), reason: a.reason, findings: [].concat(a.finding || []), newContent: [].concat(a.new || []), read: a.read ? list(a.read) : null,
    });
    writeJson(PATHS.patches, patches);
    writeJson(PATHS.source, source);
    console.log(`Recorded ${a._[1]}: ${r.result}.`);
    if (r.flagged.length) console.log(`Flagged for recheck: ${r.flagged.join(', ')}. Their schedules are unchanged. Next: node tools/build-events.mjs --bump`);
    else console.log('No event changed status. Next: node tools/build-events.mjs (the revision stays the same).');
  } else {
    console.log('Usage: node tools/patch-review.mjs fetch | scan <id> | record <id> --title ... --url ... [--flag ids --reason ...]');
    process.exit(cmd ? 1 : 0);
  }
}

if (process.argv[1] && process.argv[1].endsWith('patch-review.mjs')) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
