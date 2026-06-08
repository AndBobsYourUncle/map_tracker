// Core map-ingest logic, shared by the CLI (scripts/ingest.mjs) and the
// UI-triggered API route (app/api/maps/ingest). Plain ESM JS (no TS build step)
// so both a .mjs script and a TS route can import it directly.
//
// Given a source map page URL, this fetches the page, extracts its embedded
// map data, downloads the full tile pyramid + marker media into the data dir,
// and writes a transformed data.json. After it runs the app serves everything
// locally — no external requests at serve time.
//
// Writes go straight into <mapsRoot>/<game>/<map>, with data.json written LAST.
// That preserves two properties: incomplete ingests stay hidden (the index and
// map page both require a valid data.json), and re-running resumes cheaply
// (already-downloaded tiles are skipped).

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const PAD = 0.2; // match the app's view padding

// ---------- helpers ----------

function parseUrl(rawUrl) {
  const PAGE_URL = (() => {
    const u = new URL(rawUrl);
    u.search = "";
    u.hash = "";
    return u.href.replace(/\/$/, "");
  })();
  const segs = new URL(PAGE_URL).pathname.split("/").filter(Boolean);
  const mapsIdx = segs.indexOf("maps");
  if (mapsIdx < 1 || !segs[mapsIdx + 1]) {
    throw new Error(`Could not parse <game>/maps/<map> from URL path: ${PAGE_URL}`);
  }
  return { PAGE_URL, game: segs[mapsIdx - 1], mapSlug: segs[mapsIdx + 1] };
}

function makeFetch(PAGE_URL, signal) {
  return async function fetchWithRetry(url, opts = {}, tries = 4) {
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        return await fetch(url, {
          signal,
          ...opts,
          headers: { "User-Agent": UA, Referer: PAGE_URL, ...(opts.headers || {}) },
        });
      } catch (err) {
        if (signal?.aborted || attempt === tries) throw err;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  };
}

// Extract `window.<name> = <value>;` where value is a JSON object/array or string.
function extractWindowVar(html, name) {
  const marker = `window.${name} = `;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let i = start + marker.length;
  while (html[i] === " ") i++;
  const open = html[i];
  if (open === "{" || open === "[") {
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let k = i; k < html.length; k++) {
      const c = html[k];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return JSON.parse(html.slice(i, k + 1));
      }
    }
    return null;
  }
  // scalar (string / null)
  const end = html.indexOf(";", i);
  return JSON.parse(html.slice(i, end));
}

// Run an async worker over items with bounded concurrency + throttled progress.
async function pool(items, worker, concurrency, onTick, signal) {
  let next = 0;
  let done = 0;
  const total = items.length;
  let lastTick = 0;
  async function run() {
    while (next < items.length) {
      if (signal?.aborted) throw new Error("aborted");
      const idx = next++;
      await worker(items[idx], idx);
      done++;
      const now = Date.now();
      if (now - lastTick > 500 || done === total) {
        lastTick = now;
        onTick?.(done, total);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
}

// Web Mercator tile math.
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) =>
  Math.floor(
    ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z,
  );

// Descriptions link to other markers via full absolute URLs carrying
// ?locationIds=<id>. Strip the host (and trailing #L fragment) down to a real
// relative link so the data holds no source domain yet links stay valid.
const normalizeDesc = (text) =>
  text == null
    ? null
    : text.replace(/\]\(([^)]+)\)/g, (full, url) => {
        const m = url.match(/locationIds=(\d+)/);
        return m ? `](?locationIds=${m[1]})` : full;
      });

// ---------- main entry point ----------

/**
 * Ingest a source map into <mapsRoot>/<game>/<map>.
 *
 * @param {string} mapUrl  Full source page URL: https://<host>/<game>/maps/<map>
 * @param {object} opts
 * @param {string} opts.mapsRoot     Absolute path to the data maps root.
 * @param {number} [opts.maxZoom]    Override the declared max zoom.
 * @param {number} [opts.concurrency=24]
 * @param {AbortSignal} [opts.signal]
 * @param {(p: {phase: string, done: number, total: number, message?: string}) => void} [opts.onProgress]
 * @returns {Promise<{game: string, map: string, counts: {saved: number, holes: number, skipped: number, locations: number, regions: number, groups: number}}>}
 */
export async function ingestMap(mapUrl, opts = {}) {
  const {
    mapsRoot,
    maxZoom: maxZoomOverride = null,
    concurrency = 24,
    signal,
    onProgress = () => {},
  } = opts;
  if (!mapsRoot) throw new Error("ingestMap: opts.mapsRoot is required");

  const { PAGE_URL, game, mapSlug } = parseUrl(mapUrl);
  const OUT_DIR = path.join(mapsRoot, game, mapSlug);
  const fetchWithRetry = makeFetch(PAGE_URL, signal);
  const emit = (phase, done, total, message) =>
    onProgress({ phase, done, total, message });

  emit("page", 0, 1, "fetching map page");
  const res = await fetchWithRetry(PAGE_URL);
  if (!res.ok) throw new Error(`page fetch failed: HTTP ${res.status}`);
  const html = await res.text();

  const mapData = extractWindowVar(html, "mapData");
  const gameMeta = extractWindowVar(html, "game");
  const tilesCdnUrl = extractWindowVar(html, "tilesCdnUrl");
  if (!mapData) throw new Error("could not find window.mapData on the page");
  emit("page", 1, 1, "parsed map data");

  const tileSet = mapData.mapConfig.tile_sets[0];
  const ext = tileSet.extension || "jpg";
  const minZoom = tileSet.min_zoom;
  const maxZoom = maxZoomOverride ? Number(maxZoomOverride) : tileSet.max_zoom;
  const tileUrl = (z, y, x) => `${tilesCdnUrl}${tileSet.path}/${z}/${y}/${x}.${ext}`;

  // --- transform data ---
  const groups = mapData.groups.map((g) => ({
    id: g.id,
    title: g.title,
    color: "#" + (g.color || "888888"),
    order: g.order ?? 0,
    categories: (g.categories || []).map((c) => ({
      id: c.id,
      title: c.title,
      icon: c.icon ?? null,
      order: c.order ?? 0,
    })),
  }));

  const mediaDir = path.join(OUT_DIR, "media");
  await fs.mkdir(mediaDir, { recursive: true });

  const mediaJobs = [];
  const locations = mapData.locations.map((l) => {
    const media = l.media || [];
    let img = null;
    if (media.length && media[0].url) {
      const file = media[0].file_name || `${media[0].id}.jpg`;
      img = `/api/asset/${game}/${mapSlug}/media/${file}`;
      mediaJobs.push({ url: media[0].url, file });
    }
    return {
      id: l.id,
      cat: l.category_id,
      region: l.region_id ?? null,
      lat: Number(l.latitude),
      lng: Number(l.longitude),
      title: l.title || "",
      desc: normalizeDesc(l.description ?? null),
      img,
    };
  });

  // --- regions (named areas with polygon boundaries) ---
  const regionCounts = {};
  for (const l of locations) {
    if (l.region != null) regionCounts[l.region] = (regionCounts[l.region] || 0) + 1;
  }
  const regions = (mapData.regions || []).map((r) => ({
    id: r.id,
    title: r.title,
    subtitle: r.subtitle ?? null,
    parent: r.parent_region_id ?? null,
    order: r.order ?? 0,
    count: regionCounts[r.id] || 0,
    geometry: r.features?.[0]?.geometry ?? null,
  }));

  // --- bounds (padded) ---
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const l of locations) {
    if (l.lng < west) west = l.lng;
    if (l.lng > east) east = l.lng;
    if (l.lat < south) south = l.lat;
    if (l.lat > north) north = l.lat;
  }
  const padX = (east - west) * PAD;
  const padY = (north - south) * PAD;
  const bounds = [west - padX, south - padY, east + padX, north + padY];

  await fs.mkdir(OUT_DIR, { recursive: true });

  // --- download media ---
  if (mediaJobs.length) {
    emit("media", 0, mediaJobs.length, "downloading marker images");
    await pool(
      mediaJobs,
      async ({ url, file }) => {
        const dest = path.join(mediaDir, file);
        if (existsSync(dest)) return;
        const r = await fetchWithRetry(url);
        if (r && r.ok) await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
      },
      8,
      (done, total) => emit("media", done, total, "marker images"),
      signal,
    );
  }

  // --- download tiles, one zoom level at a time within the padded bounds ---
  // The source sometimes declares a max_zoom one level deeper than it serves;
  // a fully-empty level means the declared max overshoots, so we stop and
  // record the real max so the app overzooms instead of requesting 403s.
  let saved = 0, holes = 0, skipped = 0;
  let realMaxZoom = minZoom;
  for (let z = minZoom; z <= maxZoom; z++) {
    const x0 = lon2x(bounds[0], z), x1 = lon2x(bounds[2], z);
    const y0 = lat2y(bounds[3], z), y1 = lat2y(bounds[1], z); // north→smaller y
    const levelTiles = [];
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        levelTiles.push({ z, x, y });
      }
    }

    let levelSaved = 0, levelSkipped = 0;
    await pool(
      levelTiles,
      async ({ z, x, y }) => {
        const dir = path.join(OUT_DIR, "tiles", String(z), String(y));
        const dest = path.join(dir, `${x}.${ext}`);
        if (existsSync(dest)) { skipped++; levelSkipped++; return; }
        const r = await fetchWithRetry(tileUrl(z, y, x));
        if (r && r.ok) {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
          saved++; levelSaved++;
        } else {
          holes++; // tile doesn't exist (outside island); route serves blank
        }
      },
      concurrency,
      (done, total) => emit("tiles", done, total, `z${z}`),
      signal,
    );

    if (levelSaved + levelSkipped === 0) break; // declared max overshoots
    realMaxZoom = z;
  }

  // --- write data.json LAST (records the *real* max zoom) ---
  emit("write", 0, 1, "writing data.json");
  const out = {
    game: { slug: game, title: gameMeta?.title ?? mapData.map.title },
    map: mapData.map,
    mapConfig: {
      initial_zoom: mapData.mapConfig.initial_zoom,
      start_lat: mapData.mapConfig.start_lat,
      start_lng: mapData.mapConfig.start_lng,
      min_zoom: minZoom,
      max_zoom: realMaxZoom,
      tile_ext: ext,
      bounds,
    },
    groups,
    regions,
    locations,
  };
  await fs.writeFile(path.join(OUT_DIR, "data.json"), JSON.stringify(out));
  emit("write", 1, 1, "done");

  return {
    game,
    map: mapSlug,
    counts: {
      saved, holes, skipped,
      locations: locations.length,
      regions: regions.length,
      groups: groups.length,
    },
  };
}
