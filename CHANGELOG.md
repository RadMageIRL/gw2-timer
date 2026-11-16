# Changelog

Every version of GW2 Timer and what changed in it, newest first. Dates are the day I released each one.

The schedule data has its own revision numbers (r1, r2, ...), listed under "Schedule data" below. A revision is either a **schedule change** (a start time, cycle or event added or removed) or **metadata only** (a label, note or verification status changed; no time moved).

## v0.4.1 (unreleased)

A home for the Trading Post. Settings and favorites saved by earlier versions carry over unchanged, and the schedule data is still r1.

Added
- Trading Post home: with nothing typed and no filter, the Trading Post opens on Market Watch and Browse by type instead of an empty list. Market Watch is a fixed set of eight familiar items used in crafting, chosen by hand, with their highest buy order and lowest sell listing asked for from ArenaNet's API when the home is shown (one request for the prices, one for the icons), each with when it was fetched. It is not a ranking. Browse by type shows the item list's 16 types with their item counts; choosing one opens its results at once, and Trading Post home returns.
- Your favorites on the Trading Post home: your newest 8 favorites with their prices, asked for in the same request as Market Watch's, and Show all for every favorite. With none, it says how to add one; a saved favorite the item list no longer has is counted and said.
- Gem exchange on the Trading Post home: what 100 gold buys in gems and what 400 gems sell for, from ArenaNet's exchange when the home is shown (one request each), with when. Each direction is its own price and the rate changes with the amount, so neither line is presented as the other reversed. When the API does not answer, no rate is shown.
- Break-even listing price in item details: the lowest price at which listing one unit would give back at least the highest buy order after both fees, with where a gain of 1 copper starts and how the lowest sell listing compares. An estimate, as every result after fees is.
- Sort by potential margin %: the potential margin as a share of the highest buy order. Items with no buy orders have no such share and come after the ranked ones; over 1,000 matches it ranks only the prices loaded, as the other price sorts do.

Changed
- Item details lead with the highest buy order, the lowest sell listing and the potential margin, large, then when they were fetched; the arithmetic and the caveats follow, smaller.
- The Trading Post's notes (the item list's date, fees and margin, what is saved) are behind three pills under the results, so they take one line until opened.
- The item search is larger, as the Trading Post's first control.
- The page title is "GW2 Timer | Unofficial Guild Wars 2 Fansite", as ArenaNet's Content Use Policy asks of fan sites ("including in the browser title bar"). The description is unchanged.
- Item details name the margin's denominator: a percentage of the highest buy order.

## v0.4.0 (2026-11-16)

A Trading Post explorer beside the timer, and Add to calendar. Settings saved by earlier versions carry over unchanged, and the schedule data is still r1.

Added
- Trading Post: a second mode beside Event Timers, chosen with the switch at the top of the page. Switching does not reload the page; each mode keeps its search, filters, sort and place, and the timer and its reminders keep running while the Trading Post is shown. `#market` links straight to it. Event Timers is still what opens by default.
- Search the 27,983 items that had a Trading Post price on November 15, 2026, by name or id, and filter by type, rarity or favorites. The list is updated by hand, so items added to the game since then cannot be found until the next update; the page says when the list was made.
- Prices from ArenaNet's public API, asked for when you search: the highest buy order and lowest sell listing with their quantities, the spread, and a potential margin after the 5% listing fee and 10% exchange fee. Every price says when it was fetched, and stale and old prices are marked in their rows. A row with no price says why: not on the Trading Post, still loading, waiting because the API asked for fewer requests, or not loaded with the API's error. No price is ever estimated.
- Price sorts say which items they rank. Over 1,000 matches they rank only the prices loaded so far. Load whole market, only when you choose it, asks for every price (140 requests) with progress and Cancel, and says whether the load was complete or partial; only a complete one is called the whole market.
- Item details: both prices, what selling now or listing at the lowest price would give you after fees, the potential margin, the order book, the chat code, and a link to the item (`#market/item/<id>`). Results after fees are estimates: how a fraction of a copper is rounded is not published.
- Favorites: star items to keep them at hand, saved in this browser as item ids.
- Add to calendar: a calendar file (.ics) of scheduled starts, from an event's details (its next start) or from the new Calendar button by the filters (starred or chosen events, for the next start or the next 24 hours, 3, 7 or 30 days), with an optional alarm 5, 10 or 15 minutes before. Every start is its own entry in UTC from the timer's own schedule, so daylight saving cannot move it; unverified times and times set with Adjust are marked in the entry's title. The file does not update itself, and whether its alarm is used, or what importing it again does, depends on the calendar app; the dialog says so.

Accessibility
- The mode switch is a labeled group of two buttons that say which one is pressed. Back and Forward follow each switch, and a skip link goes to the item search when the Trading Post is shown.
- Prices, quantities and losses are read out in words ("17 silver 10 copper", "a loss of 87 copper"), and a row's price state is said in words, not only by color.
- Item details are a dialog named by the item; Escape and Back close it and return focus.

Security and privacy
- The Trading Post asks ArenaNet's API (api.guildwars2.com) for prices and item details, and loads icons from render.guildwars2.com, only after you open it. The timer makes neither request. The page's content security policy adds exactly those two addresses.
- No account, no API key, no cookies: the Trading Post's requests carry nothing of yours. Prices are kept only while the page is open and are never saved. A calendar file is made in this browser; nothing about it is sent anywhere.

## v0.3.0 (2026-11-14)

Reminders for starred events, a Find field, a details view and link for every event, and Share. Settings saved by earlier versions carry over unchanged, and the schedule data is still r1.

Added
- Reminders: a notice on the page, with a count in the tab's title, 5, 10 or 15 minutes before a starred event starts. They are off until you turn them on with the Reminders button in the filters. A notice shows the start in your time with a countdown, has Copy waypoint and Dismiss, and says when a time is unverified or is your own adjusted time. Several events due together make one announcement. On a phone the notices show one at a time, with "+3 more" and Dismiss all beside the notice's buttons where there is room.
- What reminders cannot do, said in the Reminders dialog, in About and in the README: they work only while the page is open; they are not notifications from your browser or your computer; a background tab can be about a minute late and a sleeping tab cannot remind you; a reminder is never shown after its event has started; with several tabs open one of them gives each reminder; and the page's two addresses keep separate settings.
- Find: type part of an event, map or region name to narrow Scheduled now and Coming up. A match that is not in your lists is named, with the reason (hidden, filtered out, or starting later than the span shown) and its next start. A search is never saved.
- Event details: every event's name opens a small view with where it is, its next start or how long its window stays open, how often it runs, how sure its time is, and why it is not in your lists when it is not.
- Links to one event: Copy link in the details gives an address such as `#event/tequatl-the-sunless`. A link names the event and nothing else, and opening one changes none of your settings. Back closes the details.
- Share and Buy me a coffee, as on FFXI Timer: in a line under the header's tagline, in the footer, and in a Share and support section in About. Share always passes https://radmagelabs.com/gw2-timer/, whichever address the page was opened at, and nothing of yours. Where the device has a share sheet it opens that; otherwise, or if the sheet fails, it copies the link. Closing the sheet does nothing, and Share in About closes About so you see that the link was copied. Buy me a coffee opens buymeacoffee.com in a new tab, so reminders keep running in this one.

Changed
- On a phone the filters fold under one Filters button beside Find, so the events start higher on the screen. A line under it says what is narrowing the lists.
- The names in Events this timer covers are links to each event's details.
- With Show set to Starred and nothing starred, both lists say how to star an event.
- The weekly reset countdown no longer breaks across two lines on narrow screens.

Accessibility
- A reminder is announced once, politely, and never takes focus; the notice area is a named region that is not read out as it counts down. When a notice is dismissed, focus moves to the next one, or to Coming up.
- The page keeps room below its footer for the reminder notices, and a control that takes focus is scrolled clear of them.
- The Find status speaks once per pause in typing, not per letter. The event details are a modal dialog named by the event, and closing them returns focus to the name that opened them.

Security and privacy
- Nothing new leaves the browser: reminders, Find and links make no request, and the page's content security policy is unchanged. A link's own text is never written into the page.
- Reminder settings and the record of reminders already given are saved in this browser only, apart from your other settings, so going back to an earlier version loses nothing.

## v0.2.1 (2026-11-08)

The page no longer jumps as it loads, its title says Guild Wars 2, and it lists every event it covers. Nothing about the schedule or your settings changes.

Changed
- The page title is "GW2 Timer: Guild Wars 2 World Boss and Meta Event Timers", and the tagline reads "Guild Wars 2 Boss & Meta Timers".
- The scripts load together and the page appears already filled in, instead of drawing an empty frame and then moving everything down. While the first headlines load, the news panel keeps their room.
- The page's search and link-preview details now describe it the same way as the other RadMage Labs apps.

Added
- Events this timer covers: a closed section at the bottom that lists every world boss and meta-event by region, with its map and how often it starts. It is part of the page itself, so it reads without JavaScript, and the build makes it from the same data as the timer.
- A line in the footer with links to FFXI Timer, FFXIV Timer and D4 Tracker.

Accessibility
- Region chips are named by what they show, then the full region name ("HoT (Heart of Thorns)").
- The RadMage Labs link in the tagline is underlined.

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
