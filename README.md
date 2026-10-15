# City Eyes — Almaty 2.0

A responsive, English-language student project for exploring essential city places with accessible text results, community-sourced accessibility details, voice controls and walking-route previews.

## Quick start

1. Keep `index.html`, `style.css` and `script.js` in the same folder.
2. Open the folder in VS Code and start **Live Server**. Alternatively, from a terminal run `python -m http.server 8000` in this folder and visit `http://localhost:8000`.
3. Allow optional microphone and location permissions only if you want to use those controls.
4. An internet connection is required for real OpenStreetMap places, map tiles and routing. The text interface, settings and error messages still load if those services are temporarily unavailable.

## How to demonstrate

- Search for a place or filter by category. Choose **Show more places** to continue browsing.
- Choose **Place details** to inspect OpenStreetMap accessibility tags and copy an issue report.
- Choose **Plan route**, then select **Central Almaty (demonstration start)** to preview a route without sharing your actual location.
- Open **Accessibility settings** to adjust contrast and text size.
- In a compatible browser, use **Voice assistant** or press **Space** while focus is outside interactive controls. Try English commands such as `show pharmacies`, `show accessible`, `show all`, `increase text`, `read route` and `help`.

## Data sources & limitations

- Places: live OpenStreetMap data via public Overpass API servers. Search currently covers approximately 5 km around central Almaty, with a limit of 350 fetched records. The on-page search searches only these loaded records.
- Map: Leaflet 1.9.4 (CDN) with OpenStreetMap tiles.
- Walking routes: public FOSSGIS/OSRM pedestrian routing service; responses depend on availability and usage limits.
- Accessibility tags are community submissions. Unknown is **not** the same as accessible. Map data can be missing or out of date.
- Routes are general planning previews: they are **not live navigation** and are **not verified for pedestrian or blind-traveler safety**. Never use them as the sole mobility aid.
- Browser-dependent speech recognition may use the browser provider's online processing. The app itself does not store voice recordings.
- The only persistent user settings are contrast and text size, stored locally in the browser. Live geolocation is requested only on user action.

## Quality checks

The JavaScript was syntax-checked with Node.js. HTML IDs, cross-references and CSS structure were checked programmatically. Chromium browser smoke tests with mocked mapping/routing responses covered search, filters, pagination, accessibility dialogs, voice commands, routes, settings, mobile layouts and API failure/recovery. **The real public APIs, actual microphone permissions and live screen-reader behavior still require testing on your device and network.**
