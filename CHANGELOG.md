# Changelog

Every version of GW2 Timer and what changed in it, newest first. Dates are the day I released each one.

The schedule data has its own revision numbers (r1, r2, ...), listed under "Schedule data" below. A revision is either a **schedule change** (a start time, cycle or event added or removed) or **metadata only** (a label, note or verification status changed; no time moved).

## v0.1.0 (2026-10-25)

First public release.

Added
- Happening now: the world bosses and meta-events inside their scheduled window, with the time left in the window. Labeled "Scheduled now", never "live": the game publishes no live event state.
- Coming up: every start in the next 1, 2, 4 or 8 hours in your local time, with UTC alongside, and Today/Tomorrow breaks.
- 15 world bosses (the game's daily world boss list) and 20 meta-events from Heart of Thorns through Visions of Eternity.
- Day and night for Tyria, Cantha and Castora, and countdowns to the daily (00:00 UTC) and weekly (Monday 07:30 UTC) resets.
- Copy waypoint: puts the event's waypoint chat code on the clipboard to paste in game. Every code matches the official API.
- Wiki links for each event.
- Stars (starred events list first without hiding the rest), Hide with a list to bring events back, filters for world bosses, meta events and starred, region chips, compact mode, and dark, light or system theme. All saved in the browser.
- Unverified and Recheck labels on the few times that need them, and Adjust on the four unverified events: enter the time you saw it start and every later start follows.
- Latest news: the five newest posts from ArenaNet's official feed, loaded straight from guildwars2.com (it says so on the page, and it can be turned off). The timer works the same when news cannot load.
- Clock check against this site's own address, which corrects the countdowns when the device clock is off.
- Schedule maintenance tools: patch-note review that flags events without changing them, evidence recording, a verification report, and build rules that refuse a schedule edit without supporting evidence.

## Schedule data

- r1 (2026-10-25), first dataset: 35 events, 3 day/night cycles and 2 resets, checked against ArenaNet's game update notes through October 13, 2026. Four events start Unverified: Secrets of the Weald and Shackles of the Ancients (sources disagree), Depths of Cruelty and Convergence: Nexus of Eternity (new).
