# GW2 Timer v0.1.0

World Bosses, Meta Events & More. A Guild Wars 2 timer that shows what is inside its scheduled window right now, what starts next, and when, in your local time. It is an unofficial fansite, made by [RadMage Labs](https://radmagelabs.com/).

**Use it: [radmagelabs.com/gw2-timer](https://radmagelabs.com/gw2-timer/)** (also at [radmageirl.github.io/gw2-timer](https://radmageirl.github.io/gw2-timer/))

![GW2 Timer in the dark theme: the day and night strip for Tyria, Cantha and Castora with the daily and weekly reset countdowns, the filters, Happening now cards for the events inside their scheduled windows, and the start of the Coming up list in local time with UTC alongside](screenshots/gw2-timer.png)

It is a plain HTML page with no build step and no server. Every time is worked out in the browser from a schedule kept in this repository. Settings, stars and adjustments stay in that browser's local storage. Two requests leave the page: a clock check to its own address, and the news panel's headlines from guildwars2.com, which can be turned off.

## What it shows

**Now and next**
- Happening now: the world bosses and meta-events inside their scheduled window, with the time left in the window
- Coming up: every start in the next 1, 2, 4 or 8 hours, in your time zone with UTC alongside, with Today and Tomorrow breaks
- Day and night for Tyria, Cantha and Castora, and countdowns to the daily reset (00:00 UTC) and the weekly reset (Monday 07:30 UTC)

**Events**
- **15 world bosses**: the game's daily world boss list, including Drakkar and Of Mists and Monsters
- **20 meta-events**: Heart of Thorns, Path of Fire, End of Dragons, Secrets of the Obscure, Janthir Wilds and Visions of Eternity
- Copy waypoint puts the chat code on your clipboard to paste in game; every code matches the official API
- A wiki link for each event

**Your view**
- Stars (starred events list first without hiding the rest), Hide with a list to bring events back
- Filters for world bosses, meta events or starred, region chips, a compact mode, and dark, light or system themes

**Latest news**
- The five newest posts from ArenaNet's official feed, loaded straight from guildwars2.com; the page says so, and news can be turned off

## Scheduled, not live

Every time is a scheduled start. Guild Wars 2 has no public live event feed, so a map can run early, run late, fail or close. "Happening now" means the scheduled window is open, not that the fight is on in your map.

## Accuracy

Schedule data is checked against ArenaNet's game update notes after major releases and about every two weeks. Each time has its sources recorded. Most agree across at least two independent sources.

A few times carry a label:

- **Unverified**: the time is new, or the sources disagree. You can **Adjust** these four events by entering the time you saw them start:
  - Secrets of the Weald
  - Shackles of the Ancients
  - Depths of Cruelty
  - Convergence: Nexus of Eternity
- **Recheck**: a game update may have changed the time.

The footer shows the schedule data revision and the last review date.

## Changes

See [CHANGELOG.md](CHANGELOG.md). The schedule data has its own revision numbers, listed there too.

## Run it locally

Open `index.html` in a browser, or serve the folder:

```
node tools/serve.mjs . 8080
```

## Tests

Node 22 or newer, no dependencies:

```
node tests/run.mjs           # unit tests, data rules and house checks
node tools/build.mjs         # builds dist/ (the files the site serves)
node tests/smoke.mjs         # browser tests on dist/ (needs Chrome)
```

## Data

`data/schedule.source.json` is the schedule. `data/patches.json` records which game updates were reviewed. `node tools/build-events.mjs` turns them into `events-data.js`, the file the page loads.

The build refuses a schedule change that has no supporting evidence. It also requires the schedule data revision to move when anything players see changes.

## Sources

- Schedule facts were checked against the [Guild Wars 2 Wiki](https://wiki.guildwars2.com/)'s event timer data and World boss page. Nothing was copied; the times are restated in my own format.
- They were also compared with [qjv/event-timers](https://github.com/qjv/event-timers).
- Waypoint codes come from the official [Guild Wars 2 API](https://wiki.guildwars2.com/wiki/API:Main).
- Schedule changes come from ArenaNet's game update notes and news.

## Notice

Guild Wars Games © ArenaNet LLC. All rights reserved. NCSOFT, ArenaNet, Guild Wars, Guild Wars 2, GW2, Heart of Thorns, Path of Fire, End of Dragons, Secrets of the Obscure, Janthir Wilds, Visions of Eternity, and all associated logos, designs, and composite marks are trademarks or registered trademarks of NCSOFT Corporation. All other trademarks are the property of their respective owners.

GW2 Timer is an unofficial fansite, not affiliated with or endorsed by ArenaNet or NCSOFT. See [NOTICE](NOTICE).

## License

The code is MIT licensed ([LICENSE](LICENSE)). Event names and other game content belong to ArenaNet.
