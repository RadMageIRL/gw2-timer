// Tests for js/search.js. Run alone with `node tests/search.mjs`, or through tests/run.mjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Search = require('../js/search.js');
const DATA = require('../events-data.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { failed++; console.error(`FAIL ${name}\n  ${String(e.message).split('\n').join('\n  ')}`); }
}

const REGION = new Map(DATA.regions.map((r) => [r.id, r]));
const INDEX = new Map(DATA.events.map((e) => [e.id, Search.forEvent(e, REGION.get(e.region))]));
/** The ids of the events a query finds, in dataset order. */
const find = (q) => DATA.events.filter((e) => Search.matches(INDEX.get(e.id), q)).map((e) => e.id);

test('the module needs nothing from a page: it loads with no window, document or storage, and sets one global', () => {
  const ctx = {};
  vm.runInNewContext(readFileSync(join(ROOT, 'js', 'search.js'), 'utf8'), ctx);
  assert.deepEqual(Object.keys(ctx), ['GW2Search']);
  assert.equal(typeof ctx.GW2Search.matches, 'function');
});

test('normalize lowercases, strips accents, drops apostrophes and turns other punctuation into spaces', () => {
  assert.equal(Search.normalize("  Serpents' Ire "), 'serpents ire');
  assert.equal(Search.normalize('Dragon’s Stand'), 'dragons stand');
  assert.equal(Search.normalize('Dragon`s Stand'), 'dragons stand');
  assert.equal(Search.normalize('Hammerhart Rumble!'), 'hammerhart rumble');
  assert.equal(Search.normalize('Battle in Tarir (Octovine)'), 'battle in tarir octovine');
  assert.equal(Search.normalize('Convergence: Nexus of Eternity'), 'convergence nexus of eternity');
  assert.equal(Search.normalize('Café MÜNCHEN'), 'cafe munchen');
  assert.equal(Search.normalize(null), '');
  assert.equal(Search.normalize(undefined), '');
  assert.equal(Search.normalize(42), '42');
  assert.equal(Search.normalize('<script>alert(1)</script>'), 'script alert 1 script');
});

test('every event is found by its full name, by its map, and by each word of its name typed in part', () => {
  for (const e of DATA.events) {
    assert.ok(find(e.name).includes(e.id), `${e.id} by name`);
    assert.ok(find(e.name.toUpperCase()).includes(e.id), `${e.id} by NAME`);
    assert.ok(find(e.map).includes(e.id), `${e.id} by map`);
    for (const w of Search.words(e.name)) {
      assert.ok(find(w).includes(e.id), `${e.id} by "${w}"`);
      if (w.length >= 3) assert.ok(find(w.slice(0, 3)).includes(e.id), `${e.id} by "${w.slice(0, 3)}"`);
    }
  }
});

test('a full name finds only that event, for every event whose name is not part of another', () => {
  for (const e of DATA.events) {
    const got = find(e.name);
    assert.ok(got.includes(e.id));
    // Others may match only if they hold every word too (Dragon's Stand the event and the map of the same name).
    for (const other of got) {
      if (other === e.id) continue;
      const theirs = INDEX.get(other);
      assert.ok(Search.words(e.name).every((w) => theirs.some((x) => Search.wordMatches(w, x))), `${e.name} also found ${other}`);
    }
  }
  assert.deepEqual(find('tequatl the sunless'), ['tequatl-the-sunless']);
  assert.deepEqual(find('great jungle wurm'), ['great-jungle-wurm']);
});

test('names with punctuation are found as people type them', () => {
  assert.deepEqual(find('dragons stand'), ['dragons-stand']);
  assert.deepEqual(find("dragon's stand"), ['dragons-stand']);
  assert.deepEqual(find('serpents ire'), ['serpents-ire']);
  assert.deepEqual(find('wizards tower'), ['unlocking-the-wizards-tower']);
  assert.deepEqual(find('wizardstower'), ['unlocking-the-wizards-tower']);
  assert.deepEqual(find('eternitys garden'), ['shackles-of-the-ancients']);
  assert.deepEqual(find('hammerhart rumble'), ['hammerhart-rumble']);
  assert.deepEqual(find('convergence nexus'), ['nexus-of-eternity']);
  assert.deepEqual(find('nexus of eternity'), ['nexus-of-eternity']);
});

test('the name in brackets finds the event', () => {
  assert.deepEqual(find('octovine'), ['octovine']);
  assert.deepEqual(find('chak'), ['chak-gerent']);
  assert.deepEqual(find('chak gerent'), ['chak-gerent']);
});

test('region and kind words find their events, and combine with a name', () => {
  const ofRegion = (id) => DATA.events.filter((e) => e.region === id).map((e) => e.id);
  assert.deepEqual(find('voe'), ofRegion('voe'));
  assert.deepEqual(find('visions of eternity'), ofRegion('voe'));
  assert.deepEqual(find('heart of thorns'), ofRegion('hot'));
  for (const id of ofRegion('jw')) assert.ok(find('janthir').includes(id), id);
  assert.deepEqual(find('world boss'), DATA.events.filter((e) => e.kind === 'world-boss').map((e) => e.id));
  assert.deepEqual(find('meta event'), DATA.events.filter((e) => e.kind === 'meta').map((e) => e.id));
  for (const e of DATA.events.filter((x) => x.kind === 'meta')) assert.ok(find('meta').includes(e.id), e.id);
  assert.deepEqual(find('core wurm'), ['great-jungle-wurm']);
  assert.deepEqual(find('boss mount maelstrom'), ['megadestroyer', 'inquest-golem-mark-ii']);
});

test('one typo is forgiven in a word of four letters or more, none in a shorter word', () => {
  assert.deepEqual(find('tequatel'), ['tequatl-the-sunless']);   // an extra letter
  assert.deepEqual(find('shaterer'), ['the-shatterer']);          // a missing letter
  assert.deepEqual(find('tequalt'), ['tequatl-the-sunless']);     // two letters swapped
  assert.deepEqual(find('drakkor'), ['drakkar']);                 // a wrong letter
  assert.deepEqual(find('tequattel'), []);                        // two typos
  assert.equal(Search.wordMatches('wurn', 'wurm'), true);
  // A word is matched from its beginning, not from the middle.
  for (const q of ['kka', 'uat', 'vin', 'tte']) assert.deepEqual(find(q), [], q);
  assert.equal(Search.wordMatches('urm', 'wurm'), false);
  assert.equal(Search.wordMatches('wur', 'wurm'), true);          // a prefix
  assert.equal(Search.wordMatches('wun', 'wurm'), false);         // three letters: no typo allowed
  assert.equal(Search.wordMatches('xurm', 'wurm'), true);
  assert.equal(Search.wordMatches('xuxm', 'wurm'), false);
});

test('distance counts one for a wrong, missing, extra or swapped letter', () => {
  assert.deepEqual([['abc', 'abc'], ['abc', 'abd'], ['abc', 'ab'], ['abc', 'abcd'], ['abcd', 'abdc'], ['abcd', 'badc'], ['', 'abc']].map(([a, b]) => Search.distance(a, b)), [0, 1, 1, 1, 1, 2, 3]);
});

test('every typed word must match; an empty query matches everything', () => {
  assert.deepEqual(find('tequatl wurm'), []);
  assert.deepEqual(find('claw jormag frostgorge'), ['claw-of-jormag']);
  for (const q of ['', '   ', null, undefined, '!!!', "'", String.fromCharCode(0, 1)]) assert.equal(find(q).length, DATA.events.length, JSON.stringify(q));
});

test('nonsense and markup find nothing', () => {
  for (const q of ['zzzz', 'qqqq xxxx', '<script>', '<img src=x onerror=alert(1)>', '__proto__', 'constructor']) assert.deepEqual(find(q), [], q);
});

test('a query is read up to 60 characters and no further', () => {
  assert.equal(Search.MAX_QUERY, 60);
  const long = 'tequatl' + ' '.repeat(53) + 'zzzz'; // the nonsense word starts after character 60
  assert.equal(long.indexOf('zzzz'), 60);
  assert.deepEqual(find(long), ['tequatl-the-sunless']);
  assert.deepEqual(find('tequatl' + ' '.repeat(49) + 'zzzz'), []); // wholly inside the 60, it counts
  assert.deepEqual(find('z'.repeat(100000)), []); // and a huge one costs nothing
});

test('an index holds each word once, pairs of neighbours joined, and a long name as one word', () => {
  const ix = Search.index(['Unlocking the Wizard\'s Tower', 'Skywatch Archipelago', 'Skywatch']);
  for (const w of ['unlocking', 'the', 'wizards', 'tower', 'skywatch', 'archipelago', 'wizardstower', 'unlockingthewizardstower', 'skywatcharchipelago']) assert.ok(ix.includes(w), w);
  assert.equal(new Set(ix).size, ix.length);
  assert.deepEqual(Search.index([]), []);
  assert.deepEqual(Search.index(['', null, undefined]), []);
});

// ---- find(): what the page uses ----

const ENTRIES = DATA.events.map((e) => ({ id: e.id, index: INDEX.get(e.id) }));
const ids = (q) => Search.find(ENTRIES, q);
const ofKind = (k) => DATA.events.filter((e) => e.kind === k).map((e) => e.id);
const ALL_WORDS = [...new Set(ENTRIES.flatMap((e) => e.index))];
const beginsAWord = (t) => ALL_WORDS.some((w) => w.startsWith(t));

test('find: a real word never also finds look-alikes (the confusing matches of the first version)', () => {
  assert.deepEqual(ids('mega'), ['megadestroyer']);              // not every meta event
  assert.deepEqual(ids('cove'), ['karka-queen']);                // Southsun Cove, not every Core Tyria event
  assert.deepEqual(ids('meta'), ofKind('meta'));                 // not Fire Elemental (Metrica Province)
  assert.deepEqual(ids('worm'), ['great-jungle-wurm']);          // not every world boss (by "worl")
  assert.deepEqual(ids('stand'), ['dragons-stand']);
  // These two find more with matches() alone, which has no view of the other events. ("worm" was fixed
  // by looking for typos against whole words only, which matches() does too.)
  for (const q of ['mega', 'cove']) assert.ok(DATA.events.filter((e) => Search.matches(INDEX.get(e.id), q)).length > ids(q).length, q);
});

test('find: every word an event can be found by finds only events that have a word beginning with it', () => {
  for (const w of ALL_WORDS) {
    for (const id of ids(w)) assert.ok(INDEX.get(id).some((x) => x.startsWith(w)), `"${w}" found ${id}`);
  }
});

test('find: every event by its full name, its map and the first three letters of each word of its name', () => {
  for (const e of DATA.events) {
    assert.ok(ids(e.name).includes(e.id), `${e.id} by name`);
    assert.ok(ids(e.map).includes(e.id), `${e.id} by map`);
    for (const w of Search.words(e.name)) assert.ok(ids(w.slice(0, 3)).includes(e.id), `${e.id} by "${w.slice(0, 3)}"`);
    // Nothing found by its whole name is unrelated: the others hold every word too (the map Dragon's Stand).
    for (const other of ids(e.name)) assert.ok(Search.words(e.name).every((w) => INDEX.get(other).some((x) => x.startsWith(w))), `${e.name} found ${other}`);
  }
});

test('find: one typo in a whole word of four letters or more finds the event', () => {
  assert.deepEqual(ids('tequatel'), ['tequatl-the-sunless']);    // an extra letter
  assert.deepEqual(ids('shaterer'), ['the-shatterer']);           // a missing letter
  assert.deepEqual(ids('tequalt'), ['tequatl-the-sunless']);      // two letters swapped
  assert.deepEqual(ids('drakkor'), ['drakkar']);                  // a wrong letter
  assert.deepEqual(ids('wizardtower'), ['unlocking-the-wizards-tower']);
  assert.deepEqual(ids('janthri'), DATA.events.filter((e) => e.region === 'jw').map((e) => e.id));
  assert.deepEqual(ids('wrold boss'), ofKind('world-boss'));
  // Every one-letter slip in every word of four letters or more of a name or map (a letter dropped,
  // doubled, swapped with the next, or replaced) still finds its event, unless the slip is itself the
  // beginning of a real word.
  let tried = 0;
  for (const e of DATA.events) {
    for (const w of Search.words(`${e.name} ${e.map}`).filter((x) => x.length >= 4)) {
      const slips = new Set();
      for (let i = 0; i < w.length; i++) {
        slips.add(w.slice(0, i) + w.slice(i + 1));
        slips.add(w.slice(0, i) + w[i] + w.slice(i));
        slips.add(w.slice(0, i) + (w[i] === 'x' ? 'q' : 'x') + w.slice(i + 1));
        if (i < w.length - 1) slips.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
      }
      for (const q of slips) {
        if (q === w || q.length < 4 || beginsAWord(q)) continue;
        tried++;
        assert.ok(ids(q).includes(e.id), `"${q}" (for "${w}") finds ${e.id}`);
      }
    }
  }
  assert.ok(tried > 2000, `${tried} slips tried`);
});

test('find: where typos stop being forgiven', () => {
  assert.deepEqual(ids('tequattel'), []);                         // two typos
  assert.deepEqual(ids('tequt'), []);                             // a typo in a word typed in part
  assert.deepEqual(ids('shatere'), []);
  assert.deepEqual(ids('wun'), []);                               // three letters typed: no typo allowed
  assert.deepEqual(ids('seas'), []);                              // against a three-letter word ("sea"): none either
  assert.equal(Search.typoMatches('seas', 'sea'), false);
  assert.equal(Search.typoMatches('wurn', 'wurm'), true);
  assert.equal(Search.typoMatches('wurmm', 'wurm'), true);
  assert.equal(Search.typoMatches('wum', 'wurm'), false);
  assert.equal(Search.typoMatches('worm', 'world'), false);       // close to its beginning, not to the word
});

test('find: words typed apart that make one word together ("mega destroyer")', () => {
  assert.deepEqual(ids('mega destroyer'), ['megadestroyer']);
  assert.deepEqual(ids('wizards tower'), ['unlocking-the-wizards-tower']);
  assert.deepEqual(ids('tequatl wurm'), []);
});

test('find: an empty query finds every event in order; nonsense, markup and bad input find nothing', () => {
  for (const q of ['', '   ', null, undefined, '!!!']) assert.deepEqual(ids(q), DATA.events.map((e) => e.id), JSON.stringify(q));
  for (const q of ['zzzz', '<script>', '__proto__', 'constructor', 'z'.repeat(100000)]) assert.deepEqual(ids(q), [], q);
  assert.deepEqual(Search.find(null, 'wurm'), []);
  assert.deepEqual(Search.find('wurm', 'wurm'), []);
  assert.deepEqual(ids('tequatl' + ' '.repeat(53) + 'zzzz'), ['tequatl-the-sunless'], 'read up to 60 characters');
  const reversed = ENTRIES.slice().reverse();
  assert.deepEqual(Search.find(reversed, 'core'), ids('core').reverse(), 'in the order given');
});

test('forEvent works without a region and with a kind it does not know', () => {
  const ix = Search.forEvent({ name: 'Test Event', map: 'Somewhere', kind: 'other' }, undefined);
  assert.ok(Search.matches(ix, 'test') && Search.matches(ix, 'somewhere') && !Search.matches(ix, 'boss'));
});

console.log(`search: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
