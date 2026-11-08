// "Events this timer covers": the list in index.html of every world boss and meta-event the timer
// follows, made from the same data the page loads (the object written to events-data.js), so the
// names in the page's own HTML always match what the timer tracks. tools/build-events.mjs writes it
// between the build:event-index markers, and its --check refuses a copy that no longer matches.
// No dependencies.

export const START = '<!-- build:event-index -->';
export const END = '<!-- /build:event-index -->';

const KINDS = [
  { id: 'world-boss', title: 'World bosses', one: 'world boss', many: 'world bosses' },
  { id: 'meta', title: 'Meta events', one: 'meta event', many: 'meta events' },
];

// Everything generated here is element text (no attribute holds data), so &, < and > are enough.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ESC[c]);

/** How often an event starts, from its schedule: "every 2 hours", "6 times a day". */
export function cadence(schedule) {
  if (schedule.type === 'every') {
    const p = schedule.periodMin;
    if (p % 60 === 0) return p === 60 ? 'every hour' : `every ${p / 60} hours`;
    return `every ${p} minutes`;
  }
  if (schedule.type === 'daily') {
    const n = schedule.startsUtc.length;
    return n === 1 ? 'once a day' : `${n} times a day`;
  }
  throw new Error(`event index: unknown schedule type ${schedule.type}`);
}

const count = (n, kind) => `${n} ${n === 1 ? kind.one : kind.many}`;

/**
 * The index as HTML, from the page data: one group per kind, then one per region in the data's
 * region order, each event in the data's own order with its map and how often it starts.
 */
export function renderEventIndex(data) {
  const known = new Set(KINDS.map((k) => k.id));
  for (const e of data.events) if (!known.has(e.kind)) throw new Error(`event index: ${e.id} has unknown kind ${e.kind}`);
  const regionIds = new Set(data.regions.map((r) => r.id));
  for (const e of data.events) if (!regionIds.has(e.region)) throw new Error(`event index: ${e.id} has unknown region ${e.region}`);

  const kinds = KINDS.map((k) => ({ ...k, events: data.events.filter((e) => e.kind === k.id) })).filter((k) => k.events.length);
  const total = kinds.map((k) => count(k.events.length, k)).join(' and ');
  const out = [
    START,
    '    <details class="notes panel index" id="event-index">',
    `      <summary><h2 id="index-title">Events this timer covers</h2> <span class="hint">${escapeHtml(total)}</span></summary>`,
    '      <div class="notes-body">',
    '        <p class="index-intro">Every Guild Wars 2 world boss and meta event the timer follows, by region, with its map and how often it starts. Their next starts are in Coming up.</p>',
  ];
  for (const k of kinds) {
    out.push(`        <h3 id="index-${k.id}">${escapeHtml(k.title)} (${k.events.length})</h3>`);
    out.push('        <div class="index-regions">');
    for (const r of data.regions) {
      const list = k.events.filter((e) => e.region === r.id);
      if (!list.length) continue;
      out.push('          <div class="index-region">');
      out.push(`            <h4>${escapeHtml(r.name)}</h4>`);
      out.push('            <ul>');
      for (const e of list) {
        out.push(`              <li><span class="index-name">${escapeHtml(e.name)}</span> <span class="index-where">${escapeHtml(e.map)} · ${escapeHtml(cadence(e.schedule))}</span></li>`);
      }
      out.push('            </ul>');
      out.push('          </div>');
    }
    out.push('        </div>');
  }
  out.push('      </div>', '    </details>', `    ${END}`);
  return out.join('\n');
}

/** The page with its event index replaced by one made from `data`. Refuses a page without exactly one marker pair. */
export function applyEventIndex(html, data) {
  const a = html.indexOf(START), b = html.indexOf(END);
  if (a < 0 || b < a || html.indexOf(START, a + 1) >= 0 || html.indexOf(END, b + 1) >= 0) {
    throw new Error('index.html needs exactly one build:event-index marker pair');
  }
  return html.slice(0, a) + renderEventIndex(data) + html.slice(b + END.length);
}

/** The event index currently in the page, markers included (null when there is none). */
export function currentEventIndex(html) {
  const a = html.indexOf(START), b = html.indexOf(END);
  return a < 0 || b < a ? null : html.slice(a, b + END.length);
}
