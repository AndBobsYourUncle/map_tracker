# Map Tracker

A fully self-hosted, interactive completion tracker for video-game maps — the
kind of "check off every collectible on a zoomable map" tool you've seen
elsewhere, but running entirely on your own machine with **zero external
requests at serve time**.

Built with Next.js (standalone) + MapLibre GL. Markers, categories, groups, and
regions are checkable; per-marker progress is stored in your browser's
`localStorage`; completion counts and "mark all" toggles operate only on the
markers you've chosen to track.

> ## ⚠️ Bring your own map data
>
> **This repository contains code only — no map data.** It does not include or
> redistribute any game maps, marker coordinates, descriptions, or tile
> imagery. Those are *not* part of this project and are *not* covered by its
> license.
>
> To use the tracker you point its ingester at a source map URL; it downloads
> that map's tiles and marker data into a local data directory on your machine.
> Whatever you ingest is your responsibility — make sure you have the right to
> use it (e.g. a game you own, content you're permitted to copy). The result is
> served only locally and is not redistributed by this software.

## How it works

- **Tiles, media, and `data.json`** live in a runtime data directory
  (`MAP_TRACKER_DATA_DIR`, default `./data`) — *outside* the build. They are
  served by API routes (`/api/tiles/...`, `/api/asset/...`) that read from disk,
  so nothing is fetched from any source site once a map is ingested.
- **Ingesting a map** fetches a source page, extracts its embedded map data,
  downloads the full tile pyramid + marker images, strips any source URLs out of
  descriptions, and writes a transformed `data.json`. It writes `data.json`
  last, so partially-ingested maps stay hidden and re-running resumes cheaply.

## Quick start (development)

```bash
npm install
npm run dev          # http://localhost:3000  (data dir = ./data)
```

With an empty data dir the index shows "no maps yet." Add one:

**From the UI:** paste a source map URL into the "Add a map" box on the home
page and watch the progress bar. The new map appears when it finishes.

**From the CLI:**

```bash
npm run ingest -- <mapUrl> [--max-zoom N] [--concurrency N]
# e.g. node scripts/ingest.mjs https://example.com/some-game/maps/some-map
```

Ingested maps land in `./data/maps/<game>/<map>/`.

## Deploying to a server (Docker + Compose)

The app ships as a Next.js standalone image. Map data is **not** baked into the
image — it lives on a mounted volume, so it survives re-deploys.

```bash
cp deploy.env.example deploy.env   # fill in your VM host/user/paths
scripts/deploy.sh                  # cross-build amd64, ship over SSH, compose up
scripts/sync-data.sh               # one-time: rsync your local maps onto the VM
```

After that, new maps can be ingested directly from the UI on the server. See
`deploy.env.example` for all options (data dir path, sudo, target platform).

## Multi-device sync

By default, your progress lives only in the browser (`localStorage`) under the
**"Local (this device)"** profile — nothing leaves the machine. To sync across
devices (e.g. phone + desktop), pick a **named profile** from the dropdown in the
sidebar (or on the home page) and use the same profile on each device:

- Progress, marker visibility, "exclude from count" stars, and the "hide
  completed" toggle all sync. A device's changes appear on the others **live**,
  pushed over [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events)
  — no refresh needed. A small dot shows the connection state (Synced /
  Reconnecting… / Offline).
- The first time you switch a device to a fresh profile, it offers to **import**
  that device's existing local progress.
- Profiles are open (no password) — fitting for a LAN-only deploy. Profile state
  is stored as JSON under the data volume (`<DATA_DIR>/profiles/`), so it persists
  across redeploys just like map data.

There's **no auth**, so keep this behind your trusted network (don't expose the
sync endpoints to the public internet without adding your own auth layer).

### Behind a reverse proxy

SSE is a long-lived response, so the only proxy requirement is **generous idle
timeouts** on the route (a 15s heartbeat keeps the connection warm) and **no
response compression** on the stream. For HAProxy: set the backend's *Server
Timeout* and the frontend's *Client Timeout* to something like `1h`. The app
already sends `Cache-Control: no-cache` and `X-Accel-Buffering: no` (the latter
disables nginx buffering; harmless to HAProxy).

## Project layout

```
app/                     Next.js App Router (UI + API routes)
  api/tiles/             serves map tiles from the data dir
  api/asset/             serves marker media from the data dir
  api/maps/ingest/       start/poll a UI-triggered ingest
  api/profiles/          sync: profile registry + per-map state + SSE stream
  ProfileSwitcher.tsx    sync profile dropdown (sidebar + home page)
lib/
  paths.ts               resolves the data dir (MAP_TRACKER_DATA_DIR)
  ingest.mjs             the scraper core (also importable by the API)
  ingestJobs.ts          in-memory ingest job registry
  profileStore.ts        server-side synced state (durable JSON + cache)
  syncBus.ts             in-memory SSE pub/sub (broadcasts ops to devices)
  syncTypes.ts           shared op/snapshot types (server + client)
  profile.ts             client-side selected-profile helper
scripts/
  ingest.mjs             CLI wrapper around lib/ingest.mjs
  deploy.sh              build + ship + run on a VM
  sync-data.sh           seed existing maps onto the VM's volume
```

## License

Source-available under the
[PolyForm Noncommercial License 1.0.0](./LICENSE) — you may use, modify, and
share the code for any **noncommercial** purpose. Note this is *not* an
OSI-approved open-source license; commercial use is not granted.

The license covers this software only, not any map data you ingest with it.

## Credits

- Marker glyphs are [Lucide](https://lucide.dev) icons, used under the ISC
  License.
- Map rendering by [MapLibre GL](https://maplibre.org).
