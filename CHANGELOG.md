# What's new in wxboard

Shown on the site under **What's new**. Newest day first. One `## YYYY-MM-DD` heading per day, one bullet per change,
in plain language for pilots. Start a bullet with `[!]` when the change affects how a brief reads (what a badge,
color, tag or number means), so it's tagged on the page. Only `**bold**`, `*italic*` and `` `code` `` formatting is shown.

## 2026-11-22
- **What's new:** this list. The button in the header gets a dot when something has changed since you last opened it.
- **NOTAMs:** new **Show: Critical / Caution / Non-critical** buttons pick which levels are listed, in any combination, remembered per browser. The alert strip and the shift outlook still show every NOTAM, and the alert strip's critical-NOTAM link turns Critical back on.
- **NOTAMs:** the text search box was removed.

## 2026-11-21
- [!] **Minimums, terrain is now automatic:** each airport is checked against the designated mountainous areas of 14 CFR Part 95 Subpart B, so the mountainous or non-mountainous row of 135.609(a) is picked per airport. Cards show **MTN** when the mountainous row is used and **MTN edge** within 10 nm of a Part 95 boundary. You can still choose Always non-mountainous or Always mountainous.
- [!] **Minimums, new Part 91 VFR option:** the basic VFR minimums of 14 CFR 91.155 for the airspace at each airport's surface (Class B/C/D/E surface area: 1,000 ft and 3 SM; Class G below 1,200 ft AGL: helicopter ½ SM day / 1 SM night). Cards show the surface class.
- [!] **Part-time surface areas (Part 91 option):** the FAA's published hours for part-time Class B/C/D/E surface areas are used, so the card shows the class in effect now and the next change (e.g. *D →E 2300*), and the shift outlook and TAF rows use the class in effect at each hour. Schedules wxboard can't read are treated as in effect (the stricter case). NOTAMs at the airport about the tower or airspace get a **NOTAM** tag; wxboard doesn't apply them.
- **Minimums dialog redesigned:** folding sections for Color bands, Which minimums, This brief (each airport's terrain or airspace and its limits) and the regulation table with the rows in use highlighted. Hovers cite the regulation behind each limit.
- **Other sites:** SPC convective outlooks and the NHC tropical weather outlook were added to the default links.
- **Jump to:** a row of links in the header, one per panel with its count. Click to scroll to the panel; it opens if it was minimized.
- The **Airports** panel is now called **METAR and TAFs**.

## 2026-11-20
- [!] **Shift outlook:** the shift badge now says where the worst case came from, e.g. *Red 1200–1900L · LAMP*, and its hover says when (or whether) the TAF reaches that level. New setting **Worst case from: TAF + LAMP / TAF only**. The card badge and the outlook summary now use the same calculation; before, they could disagree.
- [!] **Old data is never shown silently:** if a source can't be refreshed and an older copy is used, a red **Old data** chip in the alert strip names the source and its age. The airport card always uses the newest METAR available; before, it could show an older one than the METAR trend.
- [!] **METAR trend:** tiles now run newest to oldest (left to right), with the newest marked **Latest**.
- **Airport card:** the current-conditions row is labeled **Minimums now**, to make clear it's the latest METAR, not the forecast.
- **Map:** two tabs. **AWC GFA** (default) embeds the Aviation Weather Center's Graphical Forecasts for Aviation centered on your area, including its Low Altitude mode. **wxboard map** shows your area, METARs by flight category, PIREPs, TFRs and advisories.
- **Areas of operation:** saved areas follow your account to any device. **Edit areas** renames, reorders and removes them and sets a **Default** area that's briefed when you open wxboard. Without a default, wxboard reopens your last brief.
- **Other sites:** a row of links to other weather sites (AWC GFA, ForeFlight Web, Windy, College of DuPage, 1800wxbrief), each in its site's color. Add, remove and reorder your own under **Edit**.
- **Winds aloft:** fetched again only when a new model run is out (about every 6 hours); the panel shows which GFS run you're looking at.

## 2026-11-19
- **wxboard launched:** airport cards, METAR and TAF, stations in area, SIGMETs/AIRMETs/CWAs/G-AIRMETs, PIREPs, TFRs, NOTAMs, winds aloft, METAR trend, minimums checks against the 14 CFR 135.609(a) table with Green / Amber / Amber Critical / Red bands, shift outlook, NWS area forecast and a map.
- **Sign-ins and accounts:** wxboard can be shared with other pilots, with sign-up by approval, invite code or open sign-up.
