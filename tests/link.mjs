// Tests for js/link.js. Run alone with `node tests/link.mjs`, or through tests/run.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Link = require('../js/link.js');
const DATA = require('../events-data.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDS = DATA.events.map((e) => e.id);

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}
const parse = (hash) => Link.parse(hash, IDS);
const MALFORMED = { ok: false, reason: 'malformed' }, UNKNOWN = { ok: false, reason: 'unknown' };

test('the module needs nothing from a page: it loads with no window, document or location, and sets one global', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'link.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['GW2Link']);
});

test('hashes that are not event links are left alone (null), the page\'s own anchors among them', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const pageIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pageIds.includes('event-index') && pageIds.includes('now-title'), 'the page still has these ids');
  for (const id of pageIds) assert.equal(parse(`#${id}`), null, id);
  for (const h of ['', '#', '#now-title', '#coming-title', '#event-index', '#event', '#events/x', '#eventx/y', '#Event/drakkar', '#EVENT/drakkar', '# event/drakkar', '#/event/drakkar', '#x/event/drakkar', 'now-title']) {
    assert.equal(parse(h), null, JSON.stringify(h));
  }
  for (const h of [null, undefined, 42, {}, [], true]) assert.equal(parse(h), null, String(h));
});

test('every event id is accepted, with and without the "#", and with one trailing slash', () => {
  for (const id of IDS) {
    assert.deepEqual(parse(`#event/${id}`), { ok: true, id });
    assert.deepEqual(parse(`event/${id}`), { ok: true, id });
    assert.deepEqual(parse(`#event/${id}/`), { ok: true, id });
  }
  assert.equal(IDS.length, 35);
});

test('capital letters are accepted and percent-encoding is decoded once', () => {
  assert.deepEqual(parse('#event/Tequatl-The-Sunless'), { ok: true, id: 'tequatl-the-sunless' });
  assert.deepEqual(parse('#event/DRAKKAR'), { ok: true, id: 'drakkar' });
  assert.deepEqual(parse('#event/tequatl%2Dthe%2Dsunless'), { ok: true, id: 'tequatl-the-sunless' });
  assert.deepEqual(parse('#event/%64rakkar'), { ok: true, id: 'drakkar' });
  assert.deepEqual(parse('#event/%2564rakkar'), MALFORMED); // encoded twice: decoded once only, leaving "%64rakkar"
});

test('a well-formed id that is not one of ours is "unknown"', () => {
  for (const h of ['#event/tequatl', '#event/tequatl-the-sunless-2', '#event/a', '#event/the-shatterer-x', '#event/retired-event', '#event/0', '#event/toString', '#event/constructor', '#event/hasOwnProperty', '#event/valueOf', '#event/length']) {
    assert.deepEqual(parse(h), UNKNOWN, h);
  }
});

test('anything else after "#event/" is refused as a whole', () => {
  const bad = [
    '#event/', '#event//', '#event/drakkar//', '#event/drakkar/x', '#event/drakkar/drakkar', '#event/x/drakkar',
    '#event/..', '#event/../drakkar', '#event/drakkar/..', '#event/.', '#event/drakkar%2F', '#event/%2Fdrakkar', '#event/drakkar%2Fx',
    '#event/__proto__', '#event/-drakkar', '#event/drakkar-', '#event/tequatl--the-sunless', '#event/drakkar_', '#event/drak kar', '#event/ drakkar', '#event/drakkar ',
    '#event/drakkar%20', '#event/drakkar%00', '#event/drakkar?x=1', '#event/drakkar#x', '#event/drakkar&x', '#event/<script>', '#event/%3Cscript%3E', '#event/"onload="x',
    '#event/%E0%A4%A', '#event/%', '#event/%zz', '#event/drakkar%',
    '#event/draKKar',      // Kelvin signs, which lower-case into "k"
    '#event/drakkаr',            // a Cyrillic letter that looks like "a"
    '#event/ｄrakkar',            // a full-width "d"
    '#event/drakkar​',           // a zero-width space
    '#event/dräkkar', '#event/%D0%B0',
  ];
  for (const h of bad) assert.deepEqual(parse(h), MALFORMED, JSON.stringify(h));
});

test('the length cap is 80 characters after the "#", checked before anything else is read', () => {
  assert.equal(Link.MAX_CHARS, 80);
  const at = (n) => 'event/' + 'a'.repeat(n - 6);
  assert.deepEqual(parse('#' + at(80)), UNKNOWN);   // 80: read, and not one of ours
  assert.deepEqual(parse('#' + at(81)), MALFORMED); // 81: not read
  assert.deepEqual(parse('#event/' + 'a'.repeat(100000)), MALFORMED);
  assert.ok(IDS.every((id) => ('event/' + id).length <= 80));
  // A long link that would otherwise be accepted is still refused.
  assert.deepEqual(parse('#event/' + '%64'.repeat(30)), MALFORMED);
});

test('what parse returns never holds the link\'s own text: an id comes from the list of ids, and a refusal has no text at all', () => {
  const ids = IDS.slice();
  for (const h of ['#event/Tequatl-The-Sunless', '#event/tequatl%2Dthe%2Dsunless', '#event/DRAKKAR/']) {
    const r = parse(h);
    assert.ok(ids.some((k) => k === r.id) && Object.keys(r).join() === 'ok,id');
  }
  for (const h of ['#event/<script>alert(1)</script>', '#event/unknown-thing', '#event/%3Cb%3E']) {
    const r = parse(h);
    assert.deepEqual(Object.keys(r), ['ok', 'reason']);
    assert.ok(['malformed', 'unknown'].includes(r.reason));
  }
});

test('the list of ids is not trusted either: no list, a list of the wrong things, an object', () => {
  assert.deepEqual(Link.parse('#event/drakkar'), UNKNOWN);
  assert.deepEqual(Link.parse('#event/drakkar', null), UNKNOWN);
  assert.deepEqual(Link.parse('#event/drakkar', 'drakkar'), UNKNOWN);
  assert.deepEqual(Link.parse('#event/drakkar', { drakkar: true }), UNKNOWN);
  assert.deepEqual(Link.parse('#event/drakkar', [null, 42, ['drakkar'], { id: 'drakkar' }]), UNKNOWN);
  assert.deepEqual(Link.parse('#event/drakkar', ['drakkar']), { ok: true, id: 'drakkar' });
});

test('make writes the canonical address for every id, and it reads back', () => {
  assert.equal(Link.CANONICAL, 'https://radmagelabs.com/gw2-timer/');
  assert.equal(Link.make('drakkar'), 'https://radmagelabs.com/gw2-timer/#event/drakkar');
  assert.equal(Link.fragment('drakkar'), '#event/drakkar');
  for (const id of IDS) {
    const url = Link.make(id);
    assert.match(url, /^https:\/\/radmagelabs\.com\/gw2-timer\/#event\/[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.deepEqual(parse(new URL(url).hash), { ok: true, id });
    assert.deepEqual(parse(Link.fragment(id)), { ok: true, id });
  }
});

test('the canonical address matches the page\'s own canonical link', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = /<link rel="canonical" href="([^"]+)"/.exec(html);
  assert.ok(m, 'index.html has a canonical link');
  assert.equal(m[1], Link.CANONICAL);
});

console.log(`link: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
