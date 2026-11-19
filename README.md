# wxboard

Personal preflight weather board. Enter one or more airports and get, for that area:

- **Airport cards:** flight category, ceiling, visibility, wind, altimeter, observation age, and the worst TAF category in the next 6 hours
- **METAR and TAF:** raw text, plus a TAF table split into periods with a flight category for each (TEMPO/PROB shown separately)
- **Stations in area:** every reporting station inside the radius or route corridor
- **Advisories:** SIGMETs/AIRMETs, Center Weather Advisories and G-AIRMETs that touch the area
- **PIREPs** from the last 3 hours, with urgent reports flagged
- **TFRs** that overlap or come within the radius
- **NOTAMs,** split into Active and Upcoming (needs FAA NMS access, see below)
- **Winds aloft** over each airport, now and +3/6/12/24 hr, with a **max altitude** cutoff (3,000–39,000 ft, remembered per browser). 1,000-ft steps when the cutoff is 12,000 ft or lower.
- **METAR trend:** the last 6 hours of observations for each airport as colored tiles, with ceiling/visibility trend arrows
- **Minimums:** current conditions, TAF periods and the trend are checked against the 14 CFR 135.609(a) HAA table (day / night unaided / night NVG), with Green / Amber / Amber Critical / Red bands. Day vs night is worked out per airport from civil twilight (14 CFR 1.1). Set terrain, local vs cross-country, NVG vs unaided and band widths under **Minimums**. A reading aid, not a flight release.
- **Shift outlook:** hour-by-hour timeline for your shift (start time, 6–24 h): TAF and LAMP conditions colored by your minimums, winds at a chosen altitude, precip chance, day/night, and bars for SIGMETs, CWAs, G-AIRMETs, TFRs and red/amber NOTAMs, with a one-line summary on top
- **NWS area forecast** in plain English
- **Map** with stations colored by flight category, plus hazard and TFR outlines

Areas: a single airport gives a circle around it. Several airports give a circle around each one. Tick **Route** to get a corridor along the airports in order. Save areas as quick-pick chips. The URL updates as you go, so bookmarks work too. The page refreshes every 5 minutes.

## Run it

Needs **Node.js 18 or newer** (https://nodejs.org). There's nothing to install beyond that, since it has no dependencies.

```
cd wxboard
copy config.example.json config.json     (Mac/Linux: cp config.example.json config.json)
   → edit config.json and put your email in "contact"
node server.js
```

Then open **http://localhost:8080**. Example: http://localhost:8080/?ids=KDFW%20KAUS&radius=50

`node server.js --demo` runs with offline sample data, so you can see every panel populated. The sample data covers Arkansas and nearby airports (KLIT, KXNA, KFSM, KTUL, KMEM, KSGF, KHRO, KRUE…), so try http://localhost:8080/?ids=KLIT%20KXNA&radius=50. Other IDs show as not found. The demo data is not real weather, and the page shows a banner saying so.

To use it from your phone on the same Wi-Fi, set `"host": "0.0.0.0"` in config.json, then browse to `http://<your-computer's-IP>:8080`. Opening it by IP address, `localhost` or the computer's own name works. To use another name (for example a local DNS name), add it to `"allowedHosts"` in config.json; other names are refused, which blocks DNS-rebinding attacks from web pages. There's no login, so don't expose it to the internet as-is. Each client is limited to 30 briefs a minute.

## Data sources

| Data | Source | Key? | Cache |
|---|---|---|---|
| METAR, TAF, PIREP, SIGMET/AIRMET, G-AIRMET, CWA, station info | aviationweather.gov/api/data (NOAA AWC) | No | 2–10 min |
| Winds aloft (NOAA GFS model) | api.open-meteo.com (free, non-commercial, CC BY 4.0) | No | 30 min |
| Area + hourly forecast | api.weather.gov (NWS) | No | 15 min |
| LAMP guidance (airports without a TAF) | mesonet.agron.iastate.edu/api/1/mos.json (Iowa Environmental Mesonet, NOAA GFS LAMP) | No | 15 min |
| TFR list + shapes | tfr.faa.gov (`tfrapi/exportTfrList` + geoserver WFS) | No | 10 min |
| NOTAMs | FAA NMS-API | **Yes, by request** | 10 min |

AWC limits are 100 requests per minute and no direct browser access, which is why this runs as a small server. CONUS-wide products (SIGMETs, G-AIRMETs, CWAs, TFRs) are fetched once and shared across areas. If a feed fails, the last good copy is served until it comes back. One failing source never blanks the rest of the page.

## Turning on NOTAMs

The FAA onboarding email includes a password-protected spreadsheet (the password comes in a separate email). Its **KEY** is your client ID and its **SECRET** is your client secret.

1. In `config.json`, set `nmsClientId` to the KEY and `nmsClientSecret` to the SECRET.
2. Set `nmsEnv` to `"prod"` for production credentials (or `"staging"` for test ones).
3. Check them with `node tools/nms-test.js`. It only logs in and pings, so it doesn't use up a data pull.
4. Start the server. The first run downloads every US NOTAM, which can take a few minutes.

### How NOTAMs are fetched (FAA production limits)

The FAA allows **one data pull every 3 minutes** (more gets HTTP 429) and **one full download per 24 hours**. Pulling the DOMESTIC, FDC and MILITARY categories once counts as one full download. So wxboard never asks the FAA per search. Instead it:

- keeps a **local copy of all US NOTAMs** (domestic, FDC and military) in `data/`;
- re-downloads the full set **once every 24 hours**;
- pulls **changes every 3 min 10 s** (new, updated, cancelled, replaced), with the 1-minute overlap the FAA recommends;
- **survives restarts**: the copy is saved to disk, restarts don't trigger another full download, and the first update after a restart waits out the 3-minute spacing;
- on a 429 it waits twice as long before trying again; a failed category download is retried after an hour.

Searches read the local copy, so they're instant and use no API calls. The area search covers any radius you choose; it's no longer capped at 100 nm.

Expired NOTAMs aren't sent in updates, so wxboard drops them by end time. NOTAMs with an **estimated (EST)** end are kept after that time, tagged "PAST EST END", until they're cancelled or replaced. International NOTAMs aren't downloaded; the FAA notes NMS isn't the authoritative source for non-US NOTAMs.

Keep `config.json` private (it's in `.gitignore`, along with `data/`).

## Notes and limits

- Not an FAA-approved briefing source. Use it alongside an official briefing.
- Flight categories use the standard thresholds: LIFR <500 ft / <1 SM, IFR <1000 / <3, MVFR 1000–3000 / 3–5, VFR above that. Station categories come from AWC when provided.
- In route mode, hazard and station checks use the true corridor. The map draws a line plus circles at each airport as an approximation.
- Max 12 airports per brief and 40 stations listed. Radius is limited to 5–300 nm.
- LAMP gives ceiling and visibility as category ranges (e.g. 500–900 ft). The outlook judges both ends against your minimums and stripes the cell when they disagree. LAMP is statistical guidance, not a TAF.
- NOTAM bars in the outlook show a NOTAM's overall validity; a daily schedule (e.g. 1400–2000 DLY) is in the tooltip, not drawn hour by hour.
- Winds aloft: NOAA's FB winds/temps aloft tables were discontinued 2026-11-03 with the NAM model retirement (NWS SCN 26-47). wxboard now uses NOAA GFS model winds at pressure levels via Open-Meteo, interpolated to each altitude. These are model output, not an official NWS winds aloft forecast. Check them with `node tools/winds-test.js`.
- NOTAM sync was tested against a simulated NMS server (login, compressed bulk files, updates, cancellations, 429s, restarts). The format of the FAA's real bulk files isn't documented, so the reader accepts gzip or plain JSON in several layouts. If the first download fails, check the server log.
- METAR and TAF field names were checked against live AWC responses on 2026-11-19. CWA field names weren't (none were active), so CWA text uses fallbacks.

## UI conventions (apply to every new feature)

- **Everything is foldable.** Every panel minimizes (▾ in its header) and can be dragged by ⠿. Long panels also fold per item (each airport, each NOTAM airport and category, METAR / raw TAF / TAF table, outlook summary, outlook airport blocks, outlook Area block), with Minimize all / Expand all buttons where there are several items.
- **A folded item still shows what matters:** counts, flight category, minimums badge, critical/caution tags, or worst condition for the shift. Folding never hides that a problem exists.
- **Choices are remembered** per browser (localStorage) across reloads and new briefs.
- **The alert strip at the top is never filtered or folded away by other settings.**

## Files

```
server.js              web server + API (/api/brief, /api/status)
lib/brief.js           builds one brief from all sources
lib/sources/*.js       AWC, NWS, TFR, NMS clients
lib/flightcat.js       flight category / TAF period logic
lib/geo.js             distance, corridor and polygon-overlap math
public/                the page (HTML/CSS/JS, Leaflet bundled)
fixtures/              demo data; tools/make-fixtures.js rebuilds it
lib/notamStore.js      local NOTAM copy + sync scheduler
tools/nms-test.js      checks your NMS-API credentials (no data pulled)
tools/winds-test.js    checks the winds aloft feed
test/                  unit tests (npm test, no network)
```
