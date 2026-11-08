# Changelog

Every version of GW2 Timer and what changed in it, newest first. Dates are the day I released each one.

The schedule data has its own revision numbers (r1, r2, ...), listed under "Schedule data" below. A revision is either a **schedule change** (a start time, cycle or event added or removed) or **metadata only** (a label, note or verification status changed; no time moved).

## v0.2.0 (2026-11-08)

Latest news moves to the top, a new Schedule notes section, and usability fixes across the event lists. Settings saved by v0.1.0 carry over unchanged.

Changed
- Latest news now sits under the clocks and resets, above the filters and the event lists. It shows the three newest headlines with their dates, and Show all 5 lists the rest; the page remembers which you chose. The panel names ArenaNet as the source, and news can still be turned off.
- "Happening now" is renamed "Scheduled now", to match what it shows: events inside their scheduled window. The "Scheduled now" pill on each card is gone, since the heading says it.
- Coming up shows the countdown right under each start time, in bold, and a start less than 10 minutes away turns green. UTC moves below the countdown.
- Starred events are tinted, and they list first in Scheduled now as well as in Coming up.
- The filters have visible Show and Regions labels. Region chips show a check mark when on and a dashed outline when off, instead of strike-through text.
- The buttons in Coming up line up in columns whether or not a row has Adjust.
- Compact mode fits each Coming up row on one line and tightens the cards.
- On phones and touch screens every button is at least 36 px tall.

Added
- Schedule notes, a closed section at the bottom: the schedule revision, the review and source-check dates, how many events are documented, confirmed in game, disputed and unverified, what each of those means, and the events whose times are uncertain, with your own time when you have used Adjust.

Fixed
- A headline with a dash typed straight into ArenaNet's feed (rather than written as an entity) showed that dash as is. Every dash in a headline now shows as a plain hyphen, including headlines saved in the browser by v0.1.0.

Accessibility
- Adjust, Show (in Hidden) and the news links name their event or say they open a new tab. A start after midnight says its day ("Tomorrow") to screen readers. The clock has a name, and a second skip link goes to Scheduled now.

Security
- News titles drop direction-override and control characters, and the feed reader ignores items inside comments.
- The build refuses a daily schedule whose windows overlap.

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
