# GB Link Launcher

The official web launcher for **GB Link**, bringing the main tools and adapter checks together in one place.

Use it to:
- quickly open supported GB Link web clients,
- check adapter firmware health/version,
- and grab firmware updates when available.

## Links

- Demo: [launcher.gblink.io](https://launcher.gblink.io)
- Original GB Link site: [gblink.io](https://gblink.io)
- Firmware releases: [GBLink-Firmware releases](https://github.com/starlarkus/GBLink-Firmware/releases)

## What This Launcher Does

- Loads GB Link-compatible web tools/games from `data/games.json` (kept up to date)
- Detects connected GB Link adapters through WebUSB, with WebSerial support coming soon
- Identifies known firmware families and versions
- Compares device firmware against `data/firmware.json` (latest known firmware entries)
- Shows update guidance and UF2 download link when an update is available
- Optionally remembers your preferred game/tool and auto-redirects on next visit

## Tech Stack

- Static HTML/CSS/JavaScript
- WebUSB API (best support in Chromium-based browsers)
- No framework or build step required

## Local Development

Because this project loads JSON files with `fetch`, run it through a local HTTP server.

Example:

```bash
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080
```

## Project Structure

- `index.html` - page markup
- `style.css` - styling
- `assets/js/launcher.js` - launcher, browser info, and device health logic
- `data/games.json` - launcher destinations (updated list)
- `data/firmware.json` - firmware catalog and update metadata (latest known releases)

## Browser Notes

- WebUSB is required for device connect/health features.
- Recommended browsers: **Google Chrome** or **Microsoft Edge**.
- If WebUSB is unavailable, launcher links still work, but device health features do not.

## Credits

Project by [Starlark](https://github.com/starlarkus) and [raphaelz](https://github.com/raphaelz).
