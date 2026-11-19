# GW2 Timer v0.5.0

Guild Wars 2 Boss & Meta Timers. A Guild Wars 2 timer that shows what is inside its scheduled window right now, what starts next, and when, in your local time, with a Trading Post explorer beside it. It is an unofficial fansite, made by [RadMage Labs](https://radmagelabs.com/).

**Use it: [radmagelabs.com/gw2-timer](https://radmagelabs.com/gw2-timer/)** (also at [radmageirl.github.io/gw2-timer](https://radmageirl.github.io/gw2-timer/))

![GW2 Timer in the dark theme: the Event Timers and Trading Post switch, the day and night strip for Tyria, Cantha and Castora with the daily and weekly reset countdowns, the three newest headlines from ArenaNet, the filters with Find, Reminders and Calendar, and Scheduled now cards for the events inside their scheduled windows](screenshots/gw2-timer.png)

It is a plain HTML page with no build step and no server. Every time is worked out in the browser from a schedule kept in this repository. Settings, stars, adjustments, reminder choices and Trading Post favorites stay in that browser's local storage. Two requests leave the timer: a clock check to its own address, and the news panel's headlines from guildwars2.com, which can be turned off. The Trading Post, only once you open it, also asks ArenaNet's public API (api.guildwars2.com) for prices, item details and gem exchange rates and loads item icons from render.guildwars2.com. No key, account or cookie is sent. A calendar file you download is made in the page itself; it is not fetched from anywhere.

## What it shows

The switch at the top of the page has two modes, **Event Timers** (the default) and **Trading Post**. Switching does not reload the page: each mode keeps its place, and the timer and its reminders keep running while the Trading Post is shown.

Event Timers, from the top of the page down:

**Clocks and resets**
- Your local time and UTC, day and night for Tyria, Cantha and Castora, and countdowns to the daily reset (00:00 UTC) and the weekly reset (Monday 07:30 UTC)

**Latest news**
- The three newest posts from ArenaNet's official feed, with their dates, and Show all 5 for the rest. They load straight from guildwars2.com; the page says so, and news can be turned off

**Now and next**
- Scheduled now: the world bosses and meta-events inside their scheduled window, with the time left in the window
- Coming up: every start in the next 1, 2, 4 or 8 hours, in your time zone with UTC alongside, with Today and Tomorrow breaks. Starts less than 10 minutes away are highlighted

**Events**
- **15 world bosses**: the game's daily world boss list, including Drakkar and Of Mists and Monsters
- **20 meta-events**: Heart of Thorns, Path of Fire, End of Dragons, Secrets of the Obscure, Janthir Wilds and Visions of Eternity
- Copy waypoint puts the chat code on your clipboard to paste in game; every code matches the official API
- A wiki link for each event

**Your view**
- Stars (starred events are tinted and list first without hiding the rest), Hide with a list to bring events back
- Filters for world bosses, meta events or starred, region chips, a compact mode with one line per start, and dark, light or system themes. On a phone the filters fold under one button, so the events start higher on the screen
- Find: type part of an event, map or region name to narrow both lists. When a match is not in your lists, the page names it, says why (hidden, filtered out, or starting later than the span shown) and when it next starts. The search is never saved

**One event**
- Every event's name opens its details: where it is, its next start or how long its window stays open, how often it runs, how sure the time is, and why it is not in your lists when it is not
- Copy link gives an address for that one event (`.../gw2-timer/#event/tequatl-the-sunless`). A link names the event and nothing else: it carries none of your settings, and opening one changes none

**Reminders**
- Off until you turn them on. Then a notice appears at the bottom of the page, with a count in the tab's title, 5, 10 or 15 minutes before a starred event starts
- See [Reminders and their limits](#reminders-and-their-limits) below for what they cannot do

**Add to calendar**
- Download a calendar file (.ics) for Google Calendar, Outlook, Apple Calendar and others: one event's next start from its details, or your starred events or events you choose, for the next start or the next 24 hours, 3, 7 or 30 days, with an optional alarm 5, 10 or 15 minutes before
- Each start is its own entry in UTC, so your calendar shows your local time on both sides of a daylight-saving change. Unverified and adjusted times say so in the entry's title. The file is made in your browser and never updates itself: download a new one after a schedule change. Whether an alarm is used, and what importing a file again does, depends on your calendar app

**Schedule notes**
- A closed section at the bottom with the schedule revision, the review dates, how many times are documented, confirmed in game, disputed or unverified, and which events have uncertain times

**Events this timer covers**
- A closed section under Schedule notes that lists every world boss and meta-event the timer follows, by region, with its map and how often it starts. It is part of the page itself, so it reads without JavaScript

**Share and support**
- Share, under the header's tagline, in the footer and in About, passes https://radmagelabs.com/gw2-timer/ to your device's share sheet, or copies it where there is none. It carries nothing of yours
- Buy me a coffee opens [buymeacoffee.com/radmageirl](https://buymeacoffee.com/radmageirl) in a new tab, so reminders keep running in this one

## Trading Post

The Trading Post mode (`#market` links straight to it) searches the items on the game's Trading Post and shows what ArenaNet's public API says about their prices. It needs no account and no API key.

- **Home**: with nothing typed and no filter, the Trading Post opens on **Market Watch** and **Browse by type**. Market Watch is a fixed set of eight familiar items used in crafting, chosen by hand (Mystic Coin, Glob of Ectoplasm, Amalgamated Gemstone, Pile of Crystalline Dust, Vial of Powerful Blood, Orichalcum Ore, Ancient Wood Log and Bolt of Gossamer), with their highest buy order and lowest sell listing asked for when the home is shown: one request for their prices and one for their icons. It is not a ranking of the market. **Your favorites** shows your newest 8 favorites priced the same way, in the same request, with Show all for the rest. **Gem exchange** shows what 100 gold buys in gems and what 400 gems sell for, as ArenaNet's exchange quotes them when the home is shown (one request each); each direction is its own price, and the rate changes with the amount, so neither line is the other reversed. Browse by type shows the item list's 16 types with how many items each has; choosing one opens its results, and **Trading Post home** returns.
- **Search** by name (every word, any order, accents ignored) or item id, and filter by type, rarity or your favorites. The list holds the 27,983 items that had a Trading Post price on November 15, 2026. It is updated by hand, so items added to the game since then cannot be found until the next update; the page says when the list was made.
- **Prices** come from the API when you search (and Market Watch's when the home is shown): the highest buy order and the lowest sell listing, with how many units are wanted and listed, the spread between them, and a potential margin after fees. Every price says when this page received it; prices received over 5 minutes ago are marked stale, and over an hour ago, old. That time is the only one known: ArenaNet's answers carry none, so when ArenaNet last updated a price is not known, and ArenaNet lets a prices answer be reused for up to 2 minutes, so a price can date from before the time shown. When the API does not answer, or answers with something the page cannot read, the row says so and no price is shown in its place. Nothing is ever estimated from a missing price.
- **Sorting** by a price says which items it ranks. Potential margin % ranks by the potential margin as a share of the highest buy order (what buying one costs); an item with no buy orders has no such share and comes after the ranked ones. Up to 1,000 matches, it loads every match's price first; over 1,000, it ranks only the prices loaded so far and says so. **Load whole market** asks for every price (140 requests, paced to stay inside the API's limits) only when you choose it, with progress and Cancel, and says whether the load was complete or partial. Only a complete load is called the whole market.
- **Price filters** (the Price filters button): the highest buy order from and to, the lowest sell listing from and to, the potential margin at least (in coins and as a percentage of the highest buy order), and the total queued units wanted and listed, at least. Type amounts as coins: 2g 50s 10c, 75s, 40c. A filter is checked only against a price that is loaded, so there are three answers: an item passes, it does not, or it is not checked. Items that are not checked are listed after the ones that pass and marked as such, with why their price is missing (not loaded, on its way, or the API did not answer); they are never dropped and never counted as passing. The line under the sort gives the three counts. Up to 1,000 matches, every match's price is loaded first (at most 5 requests) and prices that are no longer current are asked for again; over 1,000, only the rows shown are priced and the page says so, until you narrow the search or choose **Load whole market**. The two quantity filters are on the totals ArenaNet reports for all buy orders and all sell listings, at any price: they do not say how much can be bought or sold near the best price (the order book in an item's details does). The filters are kept only while the page is open: not saved, not in the address.
- **Item details** (`#market/item/<id>`): the highest buy order, the lowest sell listing, the potential margin (and its percentage of the highest buy order) and the break-even listing price first, then what selling now to the highest buy order or listing at the lowest sell listing would give you after fees, the potential margin, the order book, the chat code and a link to the item.
- **Quantity calculator** (in item details, after you ask for the order book): 1, 5, 10, 50, 100 or any whole number up to 250 units, one Trading Post transaction. It walks the order book price by price for what buying or selling that many now would cost or bring, with the average price and the units taken at each price, and compares that with placing a buy order or a listing instead. Buying or selling now depends only on the order book still being as ArenaNet reported it; an order or a listing only might fill, and the page keeps the two apart. When the book holds fewer units than you ask for, it says so and works out nothing for the rest. When a sale crosses several prices, fees on the whole sale and fees on each price are both shown if they differ: ArenaNet does not publish which applies. **Return on cost** is the profit or loss divided by the cost, for the amount and the two ways chosen; the page shows the two numbers it is made of, both results when the two fee estimates differ, and for a buy order or a listing that it holds only if the order fills or the listing sells. The order book says when this page received it (ArenaNet lets an answer be reused for up to 20 minutes, and when ArenaNet last updated it is not known), is marked stale 5 minutes after that, and is asked for only when you press its button or Refresh; changing the amount asks for nothing. Repeated or unreadable rows in ArenaNet's answer are counted once or left out, said, and figures that reach them, or are worked out from them, are marked uncertain.
- **Observed book depth near the best price** (with the order book): the units the order book shows within 5% of its own highest buy order and of its own lowest sell listing, both ends included, with how many prices that is and the side's whole depth beside it. It is what was queued when the page received the book, not a promise that this many can be bought or sold, and it is marked uncertain where ArenaNet's answer repeats a price within that range or has rows that cannot be read.
- **Favorites**: star items to keep them at hand. They are saved in your browser as item ids; prices are never saved.

### Fees and margins are estimates

The Trading Post takes a 5% listing fee and a 10% exchange fee, each at least 1 copper, as the Guild Wars 2 Wiki documents them. How a fraction of a copper is rounded is not published, so the page rounds to the nearest copper and calls every result after fees an estimate. A margin is potential, not profit: it assumes your buy order fills at the highest buy order and your listing sells at the lowest sell listing, before anyone undercuts you, and neither is certain. At a price of a few copper the two 1 copper minimums can take all of it, and the page says so. The break-even listing price is the lowest price at which listing one unit would give back at least the highest buy order after both fees, worked out with the same fees and rounding; it is an estimate for the same reasons.

## Scheduled, not live

Every time is a scheduled start. Guild Wars 2 has no public live event feed, so a map can run early, run late, fail or close. "Scheduled now" means the scheduled window is open, not that the fight is on in your map.

## Reminders and their limits

Reminders are a convenience for a page you keep open while you play. They are not a notification service, and nothing here promises that a reminder will reach you.

- **Off by default.** Turn them on with the Reminders button in the filters, and pick 5, 10 or 15 minutes. They follow the events you have starred, unless you have hidden them.
- **Only while the page is open.** Nothing can remind you when the page or the browser is closed, or while your device sleeps.
- **Not an operating-system notification.** A reminder is a notice on the page and a count in the tab's title. Your browser and your computer show nothing outside the page, so you have to be able to see the tab.
- **Sleeping and throttled tabs.** Browsers slow down tabs in the background: a reminder there, or in a window covered by your game, can be up to about a minute late. Browsers also put tabs they think are unused to sleep (Edge's sleeping tabs, Chrome's Memory Saver), and a sleeping tab cannot remind you at all. A browser window you can see, for example on a second monitor, stays on time; your browser's "always keep these sites active" list keeps the tab awake.
- **Never late.** A reminder that would arrive after its event has started is not shown, and missed reminders are not replayed after a sleep.
- **Several tabs.** With the page open in more than one tab, each reminder is given once, by one of them. The notice may be in a tab you are not looking at.
- **Two addresses, two sets of settings.** radmagelabs.com/gw2-timer and radmageirl.github.io/gw2-timer are separate sites to your browser, each with its own saved settings. Reminders turned on at one are not on at the other, and with both open each gives its own reminder.
- **Scheduled times.** A reminder follows the times the page shows. For an event marked Unverified, or one you have adjusted, the reminder says so.

## Accuracy

Schedule data is checked against ArenaNet's game update notes after major releases and about every two weeks. Each time has its sources recorded. Most agree across at least two independent sources.

A few times carry a label:

- **Unverified**: the time is new, or the sources disagree. You can **Adjust** these four events by entering the time you saw them start:
  - Secrets of the Weald
  - Shackles of the Ancients
  - Depths of Cruelty
  - Convergence: Nexus of Eternity
- **Recheck**: a game update may have changed the time.

The footer shows the schedule data revision and the last review date. Schedule notes, at the bottom of the page, has the counts for each label and lists the events that carry one.

"Documented" means at least two independent written sources agree. That is a documentation check, not an in-game check: an event is "confirmed in game" only when its start was seen in game.

## Changes

See [CHANGELOG.md](CHANGELOG.md). The schedule data has its own revision numbers, listed there too.

## Run it locally

Open `index.html` in a browser, or serve the folder. Opened as a file, the timer works, but most browsers do not let the page load the Trading Post's item list, so the Trading Post says the site must be served over HTTP or HTTPS. Serve the folder to use it:

```
node tools/serve.mjs . 8080
```

## Tests

Node 22 or newer, no dependencies:

```
node tests/run.mjs           # unit tests, data rules and house checks
node tools/build.mjs         # builds dist/ (the files the site serves)
node tests/smoke.mjs         # browser tests on dist/ (needs Chrome)
node tools/build-items.mjs --check   # the Trading Post item list and its lock agree
```

The browser tests answer every request to ArenaNet's API themselves, from fixed data; no test needs the live API.

## Data

`data/schedule.source.json` is the schedule. `data/patches.json` records which game updates were reviewed. `node tools/build-events.mjs` turns them into `events-data.js`, the file the page loads.

The build refuses a schedule change that has no supporting evidence. It also requires the schedule data revision to move when anything players see changes.

The same command writes the Events this timer covers list in `index.html` from that data, so the list always matches what the timer tracks. `node tools/build-events.mjs --check` (run by the tests and the release build) fails when either file is out of date.

`data/tp-items.json` is the Trading Post item list (id, name, type, rarity and level; no prices), and `data/tp-items.lock.json` records when it was made, from which game build, how many items, and its SHA-256. `node tools/build-items.mjs` makes it from ArenaNet's API. It is refreshed by hand and committed after review, never by a workflow (see `docs/MAINTENANCE.md`).

## Sources

- Schedule facts were checked against the [Guild Wars 2 Wiki](https://wiki.guildwars2.com/)'s event timer data and World boss page. Nothing was copied; the times are restated in my own format.
- They were also compared with [qjv/event-timers](https://github.com/qjv/event-timers).
- Waypoint codes come from the official [Guild Wars 2 API](https://wiki.guildwars2.com/wiki/API:Main).
- Item names, ids and icons, and every price, come from the same API. Item names, ids and icons are ArenaNet's.
- The Trading Post fees are as the Guild Wars 2 Wiki's Trading Post page documents them.
- Schedule changes come from ArenaNet's game update notes and news.

## Notice

Guild Wars Games © ArenaNet LLC. All rights reserved. NCSOFT, ArenaNet, Guild Wars, Guild Wars 2, GW2, Heart of Thorns, Path of Fire, End of Dragons, Secrets of the Obscure, Janthir Wilds, Visions of Eternity, and all associated logos, designs, and composite marks are trademarks or registered trademarks of NCSOFT Corporation. All other trademarks are the property of their respective owners.

GW2 Timer is an unofficial fansite, not affiliated with or endorsed by ArenaNet or NCSOFT. See [NOTICE](NOTICE).

## License

The code is MIT licensed ([LICENSE](LICENSE)). Event names, item names and icons, and other game content belong to ArenaNet.
