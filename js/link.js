// Links to one event: the page's address followed by "#event/<event id>", for example
// "#event/tequatl-the-sunless". A link names an event and nothing else: no settings, no stars, no
// adjusted times. Pure, so the page and the Node tests share it.
//
// Reading a link never trusts it. Anything after "#event/" that is not exactly the id of an event
// this page has is refused as a whole, and what comes back is one of the page's own ids, never the
// link's text, so nothing a link contains can reach the page.
(function (root) {
  'use strict';

  /** The one address links are written with, wherever the page is being read from. */
  const CANONICAL = 'https://radmagelabs.com/gw2-timer/';
  /** With the slash: the page has an element whose id begins with "event" ("event-index"). */
  const PREFIX = 'event/';
  /** Longer than any real link; more than this is not read at all. */
  const MAX_CHARS = 80;
  /** Plain ASCII only, checked before lower-casing: some other letters lower-case into ASCII ones. */
  const ASCII_ID = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

  /** The part after the page's address for an event id: "#event/<id>". */
  const fragment = (id) => `#${PREFIX}${id}`;

  /** The full address to share for an event id. */
  const make = (id) => CANONICAL + fragment(id);

  /**
   * What an address's hash asks for, given the event ids this page has:
   *   null                       not an event link ("", "#now-title", "#event-index", "#event")
   *   { ok: false, reason }      an event link that cannot be used: 'unknown' (well formed, but no
   *                              such event here; it may have been renamed or removed) or 'malformed'
   *   { ok: true, id }           id is one of knownIds
   */
  function parse(hash, knownIds) {
    const raw = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
    if (!raw.startsWith(PREFIX)) return null;
    const bad = (reason) => ({ ok: false, reason });
    if (raw.length > MAX_CHARS) return bad('malformed');
    let rest = raw.slice(PREFIX.length);
    if (rest.endsWith('/')) rest = rest.slice(0, -1); // one trailing slash
    let text = '';
    try { text = decodeURIComponent(rest); } catch (e) { return bad('malformed'); }
    if (!ASCII_ID.test(text)) return bad('malformed');
    const wanted = text.toLowerCase();
    const id = (Array.isArray(knownIds) ? knownIds : []).find((k) => typeof k === 'string' && k === wanted);
    return id === undefined ? bad('unknown') : { ok: true, id };
  }

  const Link = { CANONICAL, PREFIX, MAX_CHARS, fragment, make, parse };
  if (typeof module === 'object' && module.exports) module.exports = Link;
  else root.GW2Link = Link;
})(typeof globalThis !== 'undefined' ? globalThis : this);
