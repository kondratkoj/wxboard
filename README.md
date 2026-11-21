# wxboard

Personal preflight weather board. Enter one or more airports and get, for that area:

- **Airport cards:** flight category, ceiling, visibility, wind, altimeter, observation age, and the worst TAF category in the next 6 hours
- **METAR and TAF:** raw text, plus a TAF table split into periods with a flight category for each (TEMPO/PROB shown separately)
- **Stations in area:** every reporting station inside the radius or route corridor
- **Advisories:** SIGMETs/AIRMETs, Center Weather Advisories and G-AIRMETs that touch the area
- **PIREPs** from the last 3 hours, with urgent reports flagged
- **TFRs** that overlap or come within the radius
- **NOTAMs,** split into Active and Upcoming (needs FAA NMS access, see below)
- **Winds aloft** over each airport, now and +3/6/12/24 hr, with a **max altitude** cutoff (3,000–39,000 ft, remembered per browser). 1,000-ft steps when the cutoff is 12,000 ft or lower. Winds come from the NOAA GFS / RRFS models via Open-Meteo and are only fetched again when Open-Meteo reports a new model run (every 6 h, plus a 10-minute settle time), using its free metadata files; the panel shows which GFS run you're looking at. Requests to Open-Meteo are limited to 2 at a time server-wide.
- **METAR trend:** the last 6 hours of observations for each airport as colored tiles, with ceiling/visibility trend arrows
- **Minimums:** current conditions, TAF periods and the trend are checked against the 14 CFR 135.609(a) HAA table (day / night unaided / night NVG), with Green / Amber / Amber Critical / Red bands. Day vs night is worked out per airport from civil twilight (14 CFR 1.1). Set terrain, local vs cross-country, NVG vs unaided and band widths under **Minimums**. A reading aid, not a flight release.
- **Shift outlook:** hour-by-hour timeline for your shift (start time, 6–24 h): TAF and LAMP conditions colored by your minimums, winds at a chosen altitude, precip chance, day/night, and bars for SIGMETs, CWAs, G-AIRMETs, TFRs and red/amber NOTAMs, with a one-line summary on top. **Worst case from: TAF + LAMP / TAF only** (remembered per browser) sets what the worst case is built from; the current METAR always counts for the current hour. Each airport card's **Shift** badge shows the worst level, its hours and which source first showed it (e.g. *Red 1200–1900L · LAMP*), and the hover says when (or whether) the TAF reaches it. LAMP is NWS automated guidance; the FAA treats it as supplementary to the TAF (InFO 17006).
- **NWS area forecast** in plain English
- **Map** with two tabs, remembered per browser: **AWC GFA** (default) embeds the Aviation Weather Center Graphical Forecasts for Aviation, centered on your area: observations, radar, satellite, gridded clouds / flight category / icing / turbulence / winds, advisories and the Low Altitude (former HEMS Tool) mode via its helicopter button. It only re-centers when you brief a different area, so your own pan, zoom, layers and time survive refreshes; its settings are kept by the GFA itself, and **Open in new tab** opens the same view on aviationweather.gov. Embedding isn't a documented AWC feature, so if the AWC ever blocks it, use that link or the other tab. **wxboard map** draws your radius circle or route corridor, METARs colored by flight category, PIREPs, TFRs and advisory outlines (following the hazard filter). Switching tabs doesn't reset either map.
- **Areas of operation:** type airports and click **Save** to keep them as a named chip under the header; **Edit areas** renames them, changes airports / radius / route, reorders, removes and picks a **Default** (★) that is briefed when you open wxboard. With sign-ins on they are saved with the account (`/api/areas`), so they follow the pilot to any device; with sign-ins off they stay in the browser. Areas saved in a browser before sign-ins are imported into the account once. Without a default, wxboard reopens the last brief you ran in that browser.
- **Other sites:** a row of links on the left of the layout toolbar, each in its site's color (AWC GFA, ForeFlight Web, Windy, College of DuPage satellite/radar, 1800wxbrief). Each pilot can add (with a color), remove and reorder their own under **Edit** (saved per browser); `{lat}`, `{lon}` and `{id}` in an address are filled in from the first airport of the current brief. The row folds like everything else.

Areas: a single airport gives a circle around it. Several airports give a circle around each one. Tick **Route** to get a corridor along the airports in order. Save areas as quick-pick chips. The URL updates as you go, so bookmarks work too. The page refreshes every 5 minutes.

### How NOTAMs are fetched (FAA production limits)

The FAA allows **one data pull every 3 minutes** (more gets HTTP 429) and **one full download per 24 hours**. Pulling the DOMESTIC, FDC and MILITARY categories once counts as one full download. So wxboard never asks the FAA per search. Instead it:

- keeps a **local copy of all US NOTAMs** (domestic, FDC and military) in `data/`;
- re-downloads the full set **once every 24 hours**;
- pulls **changes every 3 min 10 s** (new, updated, cancelled, replaced), with the 1-minute overlap the FAA recommends;
- **survives restarts**: the copy is saved to disk, restarts don't trigger another full download, and the first update after a restart waits out the 3-minute spacing;
- on a 429 it waits twice as long before trying again; a failed category download is retried after an hour.

## Notes and limits

- If a weather source can't be refreshed, wxboard keeps using its last good copy (up to 3 hours) instead of blanking the panel, but it always says so: a red **Old data** chip in the alert strip names the source and the copy's age, and the server log prints `Source problem:` when a source starts failing and `Source OK again:` when it recovers. The airport cards always use the newest METAR any request returned, so a card can't show an older report than the METAR trend.
- Not an FAA-approved briefing source. Use it alongside an official briefing.
- Flight categories use the standard thresholds: LIFR <500 ft / <1 SM, IFR <1000 / <3, MVFR 1000–3000 / 3–5, VFR above that. Station categories come from AWC when provided.
- In route mode, hazard and station checks use the true corridor. The wxboard map draws a line plus circles at each airport as an approximation; the GFA is centered on the whole route but doesn't draw it.
- Max 12 airports per brief and 40 stations listed. Radius is limited to 5–300 nm.
- LAMP gives ceiling and visibility as category ranges (e.g. 500–900 ft). The outlook judges both ends against your minimums and stripes the cell when they disagree. LAMP is statistical guidance, not a TAF.
- NOTAM bars in the outlook show a NOTAM's overall validity; a daily schedule (e.g. 1400–2000 DLY) is in the tooltip, not drawn hour by hour.
- Winds aloft: NOAA's FB winds/temps aloft tables were discontinued 2026-11-03 with the NAM model retirement (NWS SCN 26-47). wxboard now uses NOAA GFS model winds at pressure levels via Open-Meteo, interpolated to each altitude. These are model output, not an official NWS winds aloft forecast. Check them with `node tools/winds-test.js`.
- NOTAM sync was tested against a simulated NMS server (login, compressed bulk files, updates, cancellations, 429s, restarts). The format of the FAA's real bulk files isn't documented, so the reader accepts gzip or plain JSON in several layouts. If the first download fails, check the server log.
- METAR and TAF field names were checked against live AWC responses on 2026-11-19. CWA field names weren't (none were active), so CWA text uses fallbacks.