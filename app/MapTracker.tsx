"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { installDecodeDebug, attachMapErrorLogger } from "./mapDebug";
import type { MapData, MapLocation } from "@/lib/types";
import markerIcons from "@/lib/marker-icons.json";
import styles from "./MapTracker.module.css";

const SOURCE_ID = "locations";
const LAYER_ID = "location-markers";
// Lines drawn from the open marker to the markers its description references.
const CONN_SOURCE = "connections";
const CONN_LAYER = "connection-lines";

// Pull the location ids a description links to via `?locationIds=<id>`.
function referencedIds(desc?: string | null): number[] {
  if (!desc) return [];
  const ids = [...desc.matchAll(/locationIds=(\d+)/g)].map((m) => Number(m[1]));
  return [...new Set(ids)];
}

const ICONS: Record<string, string> = markerIcons;

// Rasterize a Lucide SVG string to an ImageBitmap for canvas compositing.
async function svgToBitmap(svg: string, size: number): Promise<ImageBitmap> {
  const url = `data:image/svg+xml;base64,${btoa(svg)}`;
  const img = new Image(size, size);
  img.decoding = "sync";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("icon decode failed"));
    img.src = url;
  });
  return createImageBitmap(img, { resizeWidth: size, resizeHeight: size });
}

// Compose a teardrop pin (colored body + white icon in the head) into an
// ImageData for map.addImage(). One pin is baked per category. Drawn at 2x so
// it stays crisp; the pin tip sits on the marker coordinate (icon-anchor
// "bottom"). White outline keeps it legible over any tile color.
const PIN_W = 32;
const PIN_H = 40;
const PIN_RATIO = 2;
async function buildPinImage(color: string, iconSvg: string | null): Promise<ImageData> {
  const canvas = document.createElement("canvas");
  canvas.width = PIN_W * PIN_RATIO;
  canvas.height = PIN_H * PIN_RATIO;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(PIN_RATIO, PIN_RATIO);

  const cx = 16, cy = 14, r = 12, tipY = 38;
  const d2r = (d: number) => (d * Math.PI) / 180;

  // Soft drop shadow for separation from the map.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 3;
  ctx.shadowOffsetY = 1.5;
  // Single continuous balloon path: tip -> left tangent -> arc over top -> tip.
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx + r * Math.cos(d2r(150)), cy + r * Math.sin(d2r(150)));
  ctx.arc(cx, cy, r, d2r(150), d2r(30), false);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  if (iconSvg) {
    const s = 17;
    const bmp = await svgToBitmap(iconSvg, s * PIN_RATIO);
    ctx.drawImage(bmp, cx - s / 2, cy - s / 2, s, s);
  } else {
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }

  return ctx.getImageData(0, 0, PIN_W * PIN_RATIO, PIN_H * PIN_RATIO);
}

// Rendered pin height in CSS px at a given zoom — mirrors the symbol layer's
// icon-size interpolation. Used to offset popups so their tip clears the pin
// and points at the head rather than the middle.
const ICON_SIZE_STOPS: [number, number][] = [
  [8, 0.6],
  [12, 0.9],
  [15, 1.25],
];
function pinPixelHeight(zoom: number): number {
  let size: number;
  if (zoom <= ICON_SIZE_STOPS[0][0]) size = ICON_SIZE_STOPS[0][1];
  else if (zoom >= ICON_SIZE_STOPS[ICON_SIZE_STOPS.length - 1][0])
    size = ICON_SIZE_STOPS[ICON_SIZE_STOPS.length - 1][1];
  else {
    for (let i = 1; i < ICON_SIZE_STOPS.length; i++) {
      const [z0, s0] = ICON_SIZE_STOPS[i - 1];
      const [z1, s1] = ICON_SIZE_STOPS[i];
      if (zoom <= z1) {
        size = s0 + ((s1 - s0) * (zoom - z0)) / (z1 - z0);
        break;
      }
    }
  }
  return PIN_H * size!;
}

function loadIdSet(key: string): Set<number> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    return new Set<number>(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

function saveIdSet(key: string, checked: Set<number>) {
  window.localStorage.setItem(key, JSON.stringify([...checked]));
}

export default function MapTracker({
  data,
  game,
  map: mapSlug,
}: {
  data: MapData;
  game: string;
  map: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const checkedRef = useRef<Set<number>>(new Set());
  // Set during map load so the sidebar can reuse the fly-to + open-popup logic.
  const jumpToRef = useRef<((id: number) => void) | null>(null);
  // The currently-open popup's location id + a callback to repaint its
  // "found" button, so checked-state changes from anywhere (sidebar toggles,
  // "mark all") keep the open popup in sync.
  const popupSyncRef = useRef<{ id: number; render: (checked: boolean) => void } | null>(null);

  const [ready, setReady] = useState(false);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // Visibility and tracking are stored per-marker; category/group/region
  // controls are bulk actions over their markers, and their displayed state
  // (all/partial/none) is derived from these sets.
  const [hiddenLocs, setHiddenLocs] = useState<Set<number>>(new Set());
  // When on, found markers are hidden on the map even if their category/region
  // is visible. A ref mirrors it so the map's click handler can ignore clicks on
  // (invisible) completed markers.
  const [hideCompleted, setHideCompleted] = useState(false);
  const hideCompletedRef = useRef(false);
  // Markers the user has EXCLUDED from progress. Empty = everything counts.
  const [untrackedLocs, setUntrackedLocs] = useState<Set<number>>(new Set());
  // Which region rows are expanded, and which region+category sub-rows within
  // them (key `${regionId}:${catId}`). UI-only, not persisted.
  const [expandedRegions, setExpandedRegions] = useState<Set<number>>(new Set());
  const [expandedRegionCats, setExpandedRegionCats] = useState<Set<string>>(new Set());
  // Which category rows in the group list are expanded to show their markers.
  const [expandedCats, setExpandedCats] = useState<Set<number>>(new Set());
  // Groups are expanded by default; this holds the ones collapsed (manually or
  // automatically when their whole group is hidden from the map).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number>>(new Set());
  // The Regions section starts collapsed on every load.
  const [regionsExpanded, setRegionsExpanded] = useState(false);
  // Free-text marker filter; when set, category lists show only matching
  // markers and auto-expand.
  const [search, setSearch] = useState("");
  // Source of the fullscreen image lightbox, or null when closed.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  // Close the lightbox on Escape while it's open.
  useEffect(() => {
    if (!lightboxSrc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightboxSrc(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxSrc]);

  // Lookups derived from data.
  const {
    catToGroupColor,
    locationsByCat,
    locationsByRegion,
    markersByRegionCat,
    catTitle,
    catOrder,
    regionTitle,
    regionOrder,
    locById,
    catToIcon,
  } = useMemo(() => {
    const color = new Map<number, string>();
    const title = new Map<number, string>();
    const order = new Map<number, number>();
    const icon = new Map<number, string>();
    for (const g of data.groups) {
      for (const c of g.categories) {
        color.set(c.id, g.color);
        title.set(c.id, c.title);
        order.set(c.id, c.order);
        // Only map to an icon if we baked one for this slug; otherwise the
        // marker stays a plain colored dot.
        if (c.icon && ICONS[c.icon]) icon.set(c.id, c.icon);
      }
    }
    const rTitle = new Map<number, string>();
    const rOrder = new Map<number, number>();
    for (const r of data.regions ?? []) {
      rTitle.set(r.id, r.title);
      rOrder.set(r.id, r.order);
    }

    const byCat = new Map<number, MapLocation[]>();
    const byRegion = new Map<number, MapLocation[]>();
    const byRegionCat = new Map<number, Map<number, MapLocation[]>>();
    const byId = new Map<number, MapLocation>();
    for (const l of data.locations) {
      byId.set(l.id, l);
      (byCat.get(l.cat) ?? byCat.set(l.cat, []).get(l.cat)!).push(l);
      if (l.region != null) {
        (byRegion.get(l.region) ?? byRegion.set(l.region, []).get(l.region)!).push(l);
        let cm = byRegionCat.get(l.region);
        if (!cm) byRegionCat.set(l.region, (cm = new Map()));
        (cm.get(l.cat) ?? cm.set(l.cat, []).get(l.cat)!).push(l);
      }
    }
    // Stable ordering of the individual markers within each region+category.
    for (const cm of byRegionCat.values())
      for (const arr of cm.values())
        arr.sort((a, b) => (a.title || "").localeCompare(b.title || "") || a.id - b.id);

    return {
      catToGroupColor: color,
      locationsByCat: byCat,
      locationsByRegion: byRegion,
      markersByRegionCat: byRegionCat,
      catTitle: title,
      catOrder: order,
      regionTitle: rTitle,
      regionOrder: rOrder,
      locById: byId,
      catToIcon: icon,
    };
  }, [data]);

  const storageKey = `map-tracker:${game}:${mapSlug}:checked`;
  const hiddenLocsKey = `map-tracker:${game}:${mapSlug}:hiddenLocs`;
  const untrackedLocsKey = `map-tracker:${game}:${mapSlug}:untrackedLocs`;
  const hideCompletedKey = `map-tracker:${game}:${mapSlug}:hideCompleted`;

  // Load persisted preferences (client-only to avoid a hydration mismatch).
  useEffect(() => {
    const hidden = loadIdSet(hiddenLocsKey);
    setHiddenLocs(hidden);
    setUntrackedLocs(loadIdSet(untrackedLocsKey));
    const hc = window.localStorage.getItem(hideCompletedKey) === "1";
    setHideCompleted(hc);
    hideCompletedRef.current = hc;
    // Start any group whose markers are entirely hidden collapsed.
    const collapsed = new Set<number>();
    for (const g of data.groups) {
      const ids = g.categories.flatMap((c) =>
        (locationsByCat.get(c.id) ?? []).map((l) => l.id),
      );
      if (ids.length > 0 && ids.every((id) => hidden.has(id))) collapsed.add(g.id);
    }
    setCollapsedGroups(collapsed);
  }, [hiddenLocsKey, untrackedLocsKey, hideCompletedKey, data, locationsByCat]);

  function updateHideCompleted(value: boolean) {
    setHideCompleted(value);
    hideCompletedRef.current = value;
    window.localStorage.setItem(hideCompletedKey, value ? "1" : "0");
  }

  // setState wrappers that persist the result to localStorage.
  function updateHiddenLocs(updater: (prev: Set<number>) => Set<number>) {
    setHiddenLocs((prev) => {
      const next = updater(new Set(prev));
      saveIdSet(hiddenLocsKey, next);
      return next;
    });
  }

  function updateUntrackedLocs(updater: (prev: Set<number>) => Set<number>) {
    setUntrackedLocs((prev) => {
      const next = updater(new Set(prev));
      saveIdSet(untrackedLocsKey, next);
      return next;
    });
  }

  // Per-marker toggles + bulk helpers (category/group/region act over many ids).
  function toggleLocHidden(id: number) {
    updateHiddenLocs((next) => {
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function setManyHidden(ids: number[], hidden: boolean) {
    updateHiddenLocs((next) => {
      ids.forEach((id) => (hidden ? next.add(id) : next.delete(id)));
      return next;
    });
  }
  function toggleLocTracked(id: number) {
    updateUntrackedLocs((next) => {
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
  function setManyTracked(ids: number[], tracked: boolean) {
    updateUntrackedLocs((next) => {
      ids.forEach((id) => (tracked ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  // Membership coverage of `ids` within `set`, expressed for visibility/tracking
  // as all / partial / none (after inverting, since the sets store the
  // hidden / untracked members).
  function visibilityState(ids: number[]): "all" | "partial" | "none" {
    if (ids.length === 0) return "all";
    let hidden = 0;
    for (const id of ids) if (hiddenLocs.has(id)) hidden++;
    return hidden === 0 ? "all" : hidden === ids.length ? "none" : "partial";
  }
  function trackingState(ids: number[]): "all" | "partial" | "none" {
    if (ids.length === 0) return "all";
    let untracked = 0;
    for (const id of ids) if (untrackedLocs.has(id)) untracked++;
    return untracked === 0 ? "all" : untracked === ids.length ? "none" : "partial";
  }

  // Toggle a single location's checked state.
  const toggleChecked = useRef((id: number) => {
    const next = new Set(checkedRef.current);
    const nowChecked = !next.has(id);
    if (nowChecked) next.add(id);
    else next.delete(id);
    checkedRef.current = next;
    setChecked(next);
    saveIdSet(storageKey, next);
    mapRef.current?.setFeatureState(
      { source: SOURCE_ID, id },
      { checked: nowChecked },
    );
    const sync = popupSyncRef.current;
    if (sync && sync.id === id) sync.render(nowChecked);
    return nowChecked;
  });

  // Mark a batch of locations checked/unchecked at once (the "all" toggles on
  // region and category rows).
  const setManyChecked = useRef((ids: number[], value: boolean) => {
    const next = new Set(checkedRef.current);
    for (const id of ids) {
      if (value) next.add(id);
      else next.delete(id);
      mapRef.current?.setFeatureState(
        { source: SOURCE_ID, id },
        { checked: value },
      );
    }
    checkedRef.current = next;
    setChecked(next);
    saveIdSet(storageKey, next);
    const sync = popupSyncRef.current;
    if (sync && ids.includes(sync.id)) sync.render(value);
  });

  // Initialize the map once.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    installDecodeDebug(); // diagnostic: trace intermittent tile decode failures

    checkedRef.current = loadIdSet(storageKey);
    setChecked(checkedRef.current);

    const { mapConfig } = data;
    // Padded bounds were computed at ingest time and keep the camera (and tile
    // requests) over the island instead of the empty void around it.
    const bounds = mapConfig.bounds;

    const map = new maplibregl.Map({
      container: containerRef.current,
      center: [mapConfig.start_lng, mapConfig.start_lat],
      zoom: mapConfig.initial_zoom,
      minZoom: mapConfig.min_zoom,
      // Cap at the deepest real tile level — overzooming just upscales tiles
      // into blurry pixels, which is worse UX than a crisp hard stop.
      maxZoom: mapConfig.max_zoom,
      maxBounds: bounds,
      hash: true, // sync camera to the URL hash (#zoom/lat/lng)
      attributionControl: false,
      // This is a flat top-down game map — lock out rotation and tilt so the
      // map can't be knocked askew by a right-click/ctrl drag.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      rollEnabled: false,
      style: {
        version: 8,
        sources: {
          tiles: {
            type: "raster",
            // Local tiles, preserving the source's {z}/{y}/{x} ordering.
            tiles: [`/api/tiles/${game}/${mapSlug}/{z}/{y}/{x}.${mapConfig.tile_ext}`],
            tileSize: 256,
            bounds, // don't request tiles outside the island
            minzoom: mapConfig.min_zoom,
            maxzoom: mapConfig.max_zoom,
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#0c0a12" } },
          { id: "tiles", type: "raster", source: "tiles" },
        ],
      },
    });
    mapRef.current = map;
    // diagnostic: log which tile a decode failure relates to
    attachMapErrorLogger(map, (z, x, y) =>
      `/api/tiles/${game}/${mapSlug}/${z}/${y}/${x}.${mapConfig.tile_ext}`,
    );
    // Also kill the two-finger rotate gesture (not covered by dragRotate).
    map.touchZoomRotate.disableRotation();

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", async () => {
      const features = data.locations.map((l) => ({
        type: "Feature" as const,
        id: l.id,
        geometry: { type: "Point" as const, coordinates: [l.lng, l.lat] },
        properties: {
          id: l.id,
          cat: l.cat,
          region: l.region,
          pin: `pin-${l.cat}`,
        },
      }));

      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features },
      });

      // Bake one pin image per category that has markers (color from its group,
      // white icon in the head when we have one), then draw them all from a
      // single symbol layer keyed by the feature's "pin" property.
      await Promise.all(
        [...locationsByCat.keys()].map(async (cat) => {
          const imgId = `pin-${cat}`;
          if (map.hasImage(imgId)) return;
          const color = catToGroupColor.get(cat) ?? "#888888";
          const slug = catToIcon.get(cat);
          try {
            const img = await buildPinImage(color, slug ? ICONS[slug] : null);
            if (!map.hasImage(imgId)) map.addImage(imgId, img, { pixelRatio: PIN_RATIO });
          } catch {
            // skip; the feature just renders without an image
          }
        }),
      );

      map.addLayer({
        id: LAYER_ID,
        type: "symbol",
        source: SOURCE_ID,
        layout: {
          "icon-image": ["get", "pin"],
          "icon-anchor": "bottom", // pin tip sits on the marker coordinate
          "icon-size": ["interpolate", ["linear"], ["zoom"], 8, 0.6, 12, 0.9, 15, 1.25],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
        paint: {
          // Fade checked markers without hiding them.
          "icon-opacity": [
            "case",
            ["boolean", ["feature-state", "checked"], false],
            0.4,
            1,
          ],
        },
      });

      // Connection lines live in their own source, drawn beneath the pins so
      // markers stay on top. Populated only while a popup is open.
      map.addSource(CONN_SOURCE, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer(
        {
          id: CONN_LAYER,
          type: "line",
          source: CONN_SOURCE,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            // Dashed bright purple distinguishes these from the solid lines
            // baked into the map art.
            "line-color": "#a99bff",
            "line-width": ["interpolate", ["linear"], ["zoom"], 8, 1.5, 15, 3],
            "line-opacity": 0.9,
            "line-dasharray": [2, 1.5],
          },
        },
        LAYER_ID,
      );

      // Apply persisted checked state.
      for (const id of checkedRef.current) {
        map.setFeatureState({ source: SOURCE_ID, id }, { checked: true });
      }

      map.on("mouseenter", LAYER_ID, () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", LAYER_ID, () => {
        map.getCanvas().style.cursor = "";
      });

      let activePopup: maplibregl.Popup | null = null;

      // Draw lines from `loc` to each marker its description references (or clear
      // them when loc is null). Targets that don't exist are skipped.
      function setConnections(loc: MapLocation | null) {
        const features = [];
        if (loc) {
          for (const id of referencedIds(loc.desc)) {
            const target = locById.get(id);
            if (!target || target.id === loc.id) continue;
            features.push({
              type: "Feature" as const,
              geometry: {
                type: "LineString" as const,
                coordinates: [
                  [loc.lng, loc.lat],
                  [target.lng, target.lat],
                ],
              },
              properties: {},
            });
          }
        }
        (map.getSource(CONN_SOURCE) as maplibregl.GeoJSONSource)?.setData({
          type: "FeatureCollection",
          features,
        });
      }

      // The pin's pixel height changes with zoom, so keep an open popup's offset
      // in sync so its tip stays pinned to the top of the marker while zooming.
      map.on("zoom", () => {
        activePopup?.setOffset(pinPixelHeight(map.getZoom()));
      });

      // Reflect the open marker in the URL (?locationIds=<id>) so it can be
      // shared/bookmarked as deep links. The camera state lives
      // in the hash, which we preserve, so the two don't clobber each other.
      function setMarkerInUrl(id: number | null) {
        const u = new URL(window.location.href);
        if (id == null) u.searchParams.delete("locationIds");
        else u.searchParams.set("locationIds", String(id));
        window.history.replaceState(null, "", u.pathname + u.search + u.hash);
      }

      // Fly to a linked marker and open its popup (function declarations so the
      // two helpers can reference each other regardless of order).
      function jumpTo(id: number) {
        const target = locById.get(id);
        if (!target) return;
        const targetZoom = Math.max(map.getZoom(), 15);
        map.flyTo({
          center: [target.lng, target.lat],
          zoom: targetZoom,
          speed: 1.2,
        });
        openLocationPopup(target, targetZoom);
      }
      jumpToRef.current = jumpTo; // let the sidebar trigger the same jump

      function openLocationPopup(loc: MapLocation, atZoom = map.getZoom()) {
        const cat = loc.cat;
        const isChecked = checkedRef.current.has(loc.id);
        const el = document.createElement("div");

        // Header: the category's pin icon (color + white glyph) beside the title.
        const header = document.createElement("div");
        header.className = styles.popupHeader;
        const slug = catToIcon.get(cat);
        if (slug && ICONS[slug]) {
          const chip = document.createElement("span");
          chip.className = styles.popupIcon;
          chip.style.background = catToGroupColor.get(cat) ?? "#888888";
          chip.innerHTML = ICONS[slug];
          header.appendChild(chip);
        }
        const titleEl = document.createElement("div");
        titleEl.className = styles.popupTitle;
        titleEl.textContent = loc.title || catTitle.get(cat) || "Marker";
        header.appendChild(titleEl);
        el.appendChild(header);

        const catEl = document.createElement("div");
        catEl.className = styles.popupCat;
        catEl.textContent = catTitle.get(cat) ?? "";
        const region = regionTitle.get(loc.region);
        if (region) {
          const rEl = document.createElement("button");
          rEl.type = "button";
          rEl.className = styles.popupRegion;
          rEl.textContent = region;
          rEl.title = "Fly to region";
          rEl.addEventListener("click", () => flyToRegion(loc.region));
          catEl.appendChild(rEl);
        }
        el.appendChild(catEl);

        if (loc.img) {
          const imgBtn = document.createElement("button");
          imgBtn.type = "button";
          imgBtn.className = styles.popupImgBtn;
          imgBtn.title = "View fullscreen";
          const img = document.createElement("img");
          img.className = styles.popupImg;
          img.src = loc.img;
          img.alt = "";
          imgBtn.appendChild(img);
          const badge = document.createElement("span");
          badge.className = styles.popupImgExpand;
          badge.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>';
          imgBtn.appendChild(badge);
          imgBtn.addEventListener("click", () => setLightboxSrc(loc.img));
          el.appendChild(imgBtn);
        }

        if (loc.desc) {
          const descEl = document.createElement("div");
          descEl.className = styles.popupDesc;
          descEl.appendChild(renderDescription(loc.desc, jumpTo));
          // Keep scrolling the description from zooming the map underneath.
          descEl.addEventListener("wheel", (e) => e.stopPropagation());
          el.appendChild(descEl);
        }

        const btn = document.createElement("button");
        const renderBtn = (c: boolean) => {
          btn.className = `${styles.popupBtn} ${c ? styles.checked : ""}`;
          btn.textContent = c ? "✓ Found" : "Mark as found";
        };
        renderBtn(isChecked);
        // toggleChecked repaints the button via popupSyncRef, so the click just
        // flips the state — same path the sidebar uses, keeping both in sync.
        btn.addEventListener("click", () => toggleChecked.current(loc.id));
        el.appendChild(btn);
        popupSyncRef.current = { id: loc.id, render: renderBtn };

        // Offset the popup up by the pin's height so its tip points at the top
        // of the marker rather than into its middle.
        const popup = new maplibregl.Popup({
          closeButton: true,
          offset: pinPixelHeight(atZoom),
          maxWidth: "500px",
        })
          .setLngLat([loc.lng, loc.lat])
          .setDOMContent(el);
        popup.on("close", () => {
          // Stop syncing the button once this popup's DOM is gone.
          if (popupSyncRef.current?.id === loc.id) popupSyncRef.current = null;
          // Clear the URL + connection lines only when the user closes this
          // popup, not when it's replaced by opening another marker.
          if (activePopup === popup) {
            activePopup = null;
            setMarkerInUrl(null);
            setConnections(null);
          }
        });
        activePopup?.remove();
        activePopup = popup;
        popup.addTo(map);
        setMarkerInUrl(loc.id);
        setConnections(loc);
      }

      map.on("click", LAYER_ID, (e) => {
        const f = e.features?.[0];
        if (!f) return;
        // Completed markers are rendered at zero opacity when "hide completed"
        // is on — don't open popups for those invisible pins.
        if (hideCompletedRef.current && checkedRef.current.has(f.id as number)) return;
        const loc = locById.get(f.id as number);
        if (loc) openLocationPopup(loc);
      });

      // Deep link: if the page was opened with ?locationIds=<id>, jump there.
      const deepLink = new URLSearchParams(window.location.search).get("locationIds");
      if (deepLink && locById.has(Number(deepLink))) jumpTo(Number(deepLink));

      setReady(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      jumpToRef.current = null;
    };
  }, [data, game, mapSlug, storageKey, catToGroupColor, catTitle, regionTitle, locById, catToIcon, locationsByCat]);

  // Sync visibility: visibility is per-marker now, so hide any marker whose id
  // is in hiddenLocs.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setFilter(LAYER_ID, [
      "!",
      ["in", ["id"], ["literal", [...hiddenLocs]]],
    ]);
  }, [hiddenLocs, ready]);

  // Found markers either fade (signify completion, the default) or fully hide,
  // driven by the per-feature `checked` state. MapLibre filters can't read
  // feature-state, so we hide via zero opacity (+ the click guard above) rather
  // than setFilter.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty(LAYER_ID, "icon-opacity", [
      "case",
      ["boolean", ["feature-state", "checked"], false],
      hideCompleted ? 0 : 0.4,
      1,
    ]);
  }, [hideCompleted, ready]);

  // Fly the camera to a region's bounding box.
  function flyToRegion(regionId: number) {
    const map = mapRef.current;
    const region = (data.regions ?? []).find((r) => r.id === regionId);
    if (!map || !region?.geometry) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const ring of region.geometry.coordinates) {
      for (const [lng, lat] of ring) {
        if (lng < w) w = lng;
        if (lng > e) e = lng;
        if (lat < s) s = lat;
        if (lat > n) n = lat;
      }
    }
    map.fitBounds([w, s, e, n], { padding: 48, maxZoom: 14, duration: 800 });
  }

  function toggleRegionExpand(regionId: number) {
    setExpandedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(regionId)) next.delete(regionId);
      else next.add(regionId);
      return next;
    });
  }

  function toggleRegionCat(key: string) {
    setExpandedRegionCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleCatExpand(catId: number) {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
  }

  function setGroupCollapsed(groupId: number, collapsed: boolean) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (collapsed) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
  }

  // Hide/show the whole group on the map, and collapse it when hidden / expand
  // it when shown again.
  function setGroupHidden(groupId: number, ids: number[], hidden: boolean) {
    setManyHidden(ids, hidden);
    setGroupCollapsed(groupId, hidden);
  }

  // Progress counts. All counts (per-category, per-region, overall) only sum
  // markers that count toward progress (i.e. not in untrackedLocs).
  const catProgress = useMemo(() => {
    const total = new Map<number, number>();
    const found = new Map<number, number>();
    for (const [cat, locs] of locationsByCat) {
      let t = 0, f = 0;
      for (const l of locs) {
        if (untrackedLocs.has(l.id)) continue;
        t++;
        if (checked.has(l.id)) f++;
      }
      total.set(cat, t);
      found.set(cat, f);
    }
    return { total, found };
  }, [checked, locationsByCat, untrackedLocs]);

  // Per-region tracked totals/found (respects which markers count).
  const regionProgress = useMemo(() => {
    const total = new Map<number, number>();
    const found = new Map<number, number>();
    for (const [region, locs] of locationsByRegion) {
      let t = 0, f = 0;
      for (const l of locs) {
        if (untrackedLocs.has(l.id)) continue;
        t++;
        if (checked.has(l.id)) f++;
      }
      total.set(region, t);
      found.set(region, f);
    }
    return { total, found };
  }, [checked, locationsByRegion, untrackedLocs]);

  // Overall tracked totals.
  const { totalFound, totalLocations } = useMemo(() => {
    let tf = 0, tl = 0;
    for (const [, locs] of locationsByCat) {
      for (const l of locs) {
        if (untrackedLocs.has(l.id)) continue;
        tl++;
        if (checked.has(l.id)) tf++;
      }
    }
    return { totalFound: tf, totalLocations: tl };
  }, [checked, locationsByCat, untrackedLocs]);
  const pct = totalLocations ? Math.round((totalFound / totalLocations) * 100) : 0;
  const q = search.trim().toLowerCase();

  // A single marker row: completion + tracking + visibility, all per-marker.
  function renderMarkerRow(l: MapLocation, name: string) {
    const mDone = checked.has(l.id);
    const mHidden = hiddenLocs.has(l.id);
    const mUntracked = untrackedLocs.has(l.id);
    return (
      <div
        key={l.id}
        className={`${styles.category} ${styles.markerRow} ${mDone ? styles.complete : ""} ${mUntracked ? styles.untracked : ""}`}
      >
        <span
          className={styles.catTitle}
          onClick={() => jumpToRef.current?.(l.id)}
          style={{ cursor: "pointer" }}
          title="Fly to marker"
        >
          {name}
        </span>
        <span className={styles.rowControls}>
          <CheckToggle
            state={mDone ? "all" : "none"}
            onClick={() => toggleChecked.current(l.id)}
            label={mDone ? "Mark not found" : "Mark found"}
          />
          <TrackStar
            state={mUntracked ? "none" : "all"}
            onClick={() => toggleLocTracked(l.id)}
            label={mUntracked ? "Not counted toward progress" : "Counts toward progress"}
          />
          <EyeToggle
            on={!mHidden}
            onClick={() => toggleLocHidden(l.id)}
            label={mHidden ? "Show on map" : "Hide on map"}
          />
        </span>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <h1>
            {/* Plain anchor (not next/link) so the #<game> fragment is applied
                on the index and its section gets :target focus + scroll. */}
            <a href={`/#${game}`} className={styles.gameLink}>
              {data.game.title}
            </a>
          </h1>
          <p className={styles.mapName}>{data.map.title}</p>
          <p>{data.locations.length.toLocaleString()} markers</p>
          <div className={styles.totalProgress}>
            {totalFound} / {totalLocations} found ({pct}%)
            <div className={styles.bar}>
              <div className={styles.barFill} style={{ width: `${pct}%` }} />
            </div>
          </div>
          <button
            type="button"
            className={styles.optionToggle}
            onClick={() => updateHideCompleted(!hideCompleted)}
            aria-pressed={hideCompleted}
          >
            <span
              className={`${styles.switch} ${hideCompleted ? styles.switchOn : ""}`}
            />
            Hide completed
          </button>
          <input
            className={styles.searchInput}
            type="search"
            placeholder="Search markers…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {!q && (data.regions?.length ?? 0) > 0 && (
          <div className={styles.group}>
            {(() => {
              const sorted = [...data.regions].sort((a, b) =>
                a.title.localeCompare(b.title),
              );
              const allLocIds = data.locations.map((l) => l.id);
              const allVis = visibilityState(allLocIds);
              return (
                <>
                  <div className={styles.groupTitle}>
                    <button
                      type="button"
                      className={styles.chevron}
                      onClick={() => setRegionsExpanded((v) => !v)}
                      aria-label={regionsExpanded ? "Collapse" : "Expand"}
                    >
                      {regionsExpanded ? "▾" : "▸"}
                    </button>
                    <span
                      className={styles.groupName}
                      onClick={() => setRegionsExpanded((v) => !v)}
                      style={{ cursor: "pointer" }}
                      title={regionsExpanded ? "Collapse" : "Expand"}
                    >
                      Regions
                    </span>
                    <span className={styles.rowControls}>
                      <EyeToggle
                        on={allVis === "all"}
                        partial={allVis === "partial"}
                        onClick={() => setManyHidden(allLocIds, allVis === "all")}
                        label={allVis === "all" ? "Hide all regions" : "Show all regions"}
                      />
                    </span>
                  </div>
                  {regionsExpanded &&
                    sorted.map((r) => {
                    const total = regionProgress.total.get(r.id) ?? 0;
                    const found = regionProgress.found.get(r.id) ?? 0;
                    const done = total > 0 && found === total;
                    const open = expandedRegions.has(r.id);
                    // All categories present in this region, in category order.
                    const catMap = markersByRegionCat.get(r.id);
                    const cats = catMap
                      ? [...catMap.keys()].sort(
                          (a, b) => (catOrder.get(a) ?? 0) - (catOrder.get(b) ?? 0),
                        )
                      : [];
                    const regionLocs = locationsByRegion.get(r.id) ?? [];
                    const regionIds = regionLocs.map((l) => l.id);
                    const regionVis = visibilityState(regionIds);
                    // Completion only acts on markers that count toward progress,
                    // matching the tracked-only found/total shown on this row.
                    const regionTrackedIds = regionLocs
                      .filter((l) => !untrackedLocs.has(l.id))
                      .map((l) => l.id);
                    return (
                      <Fragment key={r.id}>
                        <div className={`${styles.category} ${done ? styles.complete : ""}`}>
                          <button
                            type="button"
                            className={styles.chevron}
                            onClick={() => toggleRegionExpand(r.id)}
                            aria-label={open ? "Collapse region" : "Expand region"}
                          >
                            {open ? "▾" : "▸"}
                          </button>
                          <span
                            className={styles.catTitle}
                            onClick={() => toggleRegionExpand(r.id)}
                            style={{ cursor: "pointer" }}
                            title={open ? "Collapse" : "Expand"}
                          >
                            {r.title}
                          </span>
                          <span className={`${styles.catCount} ${done ? styles.done : ""}`}>
                            {found}/{total}
                          </span>
                          <span className={styles.rowControls}>
                            <CheckToggle
                              state={found === 0 ? "none" : done ? "all" : "partial"}
                              onClick={() => setManyChecked.current(regionTrackedIds, !done)}
                              label={done ? "Clear all in region" : "Mark all in region found"}
                            />
                            <JumpButton
                              onClick={() => flyToRegion(r.id)}
                              label="Fly to region"
                            />
                            <EyeToggle
                              on={regionVis === "all"}
                              partial={regionVis === "partial"}
                              onClick={() => setManyHidden(regionIds, regionVis === "all")}
                              label="Show / hide region"
                            />
                          </span>
                        </div>

                        {open &&
                          cats.map((cat) => {
                            const locs = catMap!.get(cat)!;
                            const cFound = locs.filter((l) => checked.has(l.id)).length;
                            const cDone = locs.length > 0 && cFound === locs.length;
                            const ckey = `${r.id}:${cat}`;
                            const cOpen = expandedRegionCats.has(ckey);
                            return (
                              <Fragment key={ckey}>
                                <div className={`${styles.category} ${styles.subCat} ${cDone ? styles.complete : ""}`}>
                                  <button
                                    type="button"
                                    className={styles.chevron}
                                    onClick={() => toggleRegionCat(ckey)}
                                    aria-label={cOpen ? "Collapse" : "Expand"}
                                  >
                                    {cOpen ? "▾" : "▸"}
                                  </button>
                                  <IconChip
                                    color={catToGroupColor.get(cat) ?? "#888888"}
                                    slug={catToIcon.get(cat)}
                                  />
                                  <span
                                    className={styles.catTitle}
                                    onClick={() => toggleRegionCat(ckey)}
                                    style={{ cursor: "pointer" }}
                                    title={cOpen ? "Collapse" : "Expand"}
                                  >
                                    {catTitle.get(cat)}
                                  </span>
                                  <span className={`${styles.catCount} ${cDone ? styles.done : ""}`}>
                                    {cFound}/{locs.length}
                                  </span>
                                  <span className={styles.rowControls}>
                                    <CheckToggle
                                      state={cFound === 0 ? "none" : cDone ? "all" : "partial"}
                                      onClick={() =>
                                        setManyChecked.current(locs.map((l) => l.id), !cDone)
                                      }
                                      label={cDone ? "Clear all" : "Mark all found"}
                                    />
                                  </span>
                                </div>
                                {cOpen &&
                                  locs.map((l, i) =>
                                    renderMarkerRow(l, l.title || `${catTitle.get(cat)} ${i + 1}`),
                                  )}
                              </Fragment>
                            );
                          })}
                      </Fragment>
                    );
                  })}
                </>
              );
            })()}
          </div>
        )}

        {(() => {
          const groupNodes = [...data.groups]
            .filter((g) => g.categories.length > 0)
            .sort((a, b) => a.order - b.order)
            .map((g) => {
              const catIds = g.categories.map((c) => c.id);
              // Whole-group visibility/tracking act on every marker across the
              // group's categories; completion acts only on tracked markers.
              const groupIds = catIds.flatMap((cid) =>
                (locationsByCat.get(cid) ?? []).map((l) => l.id),
              );
              const groupTrackedIds = catIds.flatMap((cid) =>
                (locationsByCat.get(cid) ?? [])
                  .filter((l) => !untrackedLocs.has(l.id))
                  .map((l) => l.id),
              );
              const groupVis = visibilityState(groupIds);
              const groupTrack = trackingState(groupIds);
              const groupFound = catIds.reduce(
                (n, cid) => n + (catProgress.found.get(cid) ?? 0),
                0,
              );
              const groupDone = groupTrackedIds.length > 0 && groupFound === groupTrackedIds.length;
              // Search forces groups open; otherwise honor the collapse state.
              const groupExpanded = q ? true : !collapsedGroups.has(g.id);
              const catNodes = [...g.categories]
                .sort((a, b) => a.order - b.order)
                .map((c) => {
                  const all = locationsByCat.get(c.id) ?? [];
                  // Stable per-marker label (untitled markers fall back to
                  // "<Category> N" using their position in the full list).
                  const labeled = all.map((l, i) => ({
                    l,
                    name: l.title || `${c.title} ${i + 1}`,
                  }));
                  const matches = q
                    ? labeled.filter((x) => x.name.toLowerCase().includes(q))
                    : labeled;
                  // While searching, drop categories with no hits entirely.
                  if (q && matches.length === 0) return null;
                  const total = catProgress.total.get(c.id) ?? 0;
                  const found = catProgress.found.get(c.id) ?? 0;
                  const done = total > 0 && found === total;
                  const allIds = all.map((x) => x.id);
                  // Completion acts only on tracked markers, matching the count.
                  const trackedIds = all
                    .filter((l) => !untrackedLocs.has(l.id))
                    .map((l) => l.id);
                  const catVis = visibilityState(allIds);
                  const catTrack = trackingState(allIds);
                  // Search forces matching categories open; otherwise honor the
                  // manual chevron state.
                  const expanded = q ? true : expandedCats.has(c.id);
                  return (
                    <Fragment key={c.id}>
                      <div
                        className={`${styles.category} ${catTrack === "none" ? styles.untracked : ""} ${done ? styles.complete : ""}`}
                      >
                        <button
                          type="button"
                          className={styles.chevron}
                          onClick={() => toggleCatExpand(c.id)}
                          aria-label={expanded ? "Collapse" : "Expand"}
                        >
                          {expanded ? "▾" : "▸"}
                        </button>
                        <IconChip color={g.color} slug={c.icon ?? undefined} />
                        <span
                          className={styles.catTitle}
                          onClick={() => toggleCatExpand(c.id)}
                          style={{ cursor: "pointer" }}
                          title={expanded ? "Collapse" : "Expand"}
                        >
                          {c.title}
                        </span>
                        <span className={`${styles.catCount} ${done ? styles.done : ""}`}>
                          {found}/{total}
                        </span>
                        <span className={styles.rowControls}>
                          <CheckToggle
                            state={found === 0 ? "none" : done ? "all" : "partial"}
                            onClick={() => setManyChecked.current(trackedIds, !done)}
                            label={done ? "Clear all" : "Mark all found"}
                          />
                          <TrackStar
                            state={catTrack}
                            onClick={() => setManyTracked(allIds, catTrack !== "all")}
                            label={catTrack === "all" ? "Counts toward progress" : "Count toward progress"}
                          />
                          <EyeToggle
                            on={catVis === "all"}
                            partial={catVis === "partial"}
                            onClick={() => setManyHidden(allIds, catVis === "all")}
                            label="Show / hide on map"
                          />
                        </span>
                      </div>
                      {expanded &&
                        (() => {
                          // Group markers by region (one group per region), then
                          // order groups by region order, falling back to title
                          // (this map's regions all share one order value).
                          const groups = new Map<number, typeof matches>();
                          for (const m of matches) {
                            const arr = groups.get(m.l.region);
                            if (arr) arr.push(m);
                            else groups.set(m.l.region, [m]);
                          }
                          const ordered = [...groups.entries()].sort((a, b) => {
                            const oa = regionOrder.get(a[0]) ?? 0;
                            const ob = regionOrder.get(b[0]) ?? 0;
                            return (
                              oa - ob ||
                              (regionTitle.get(a[0]) ?? "").localeCompare(
                                regionTitle.get(b[0]) ?? "",
                              )
                            );
                          });
                          return ordered.map(([rid, items]) => (
                            <Fragment key={rid}>
                              <div className={styles.regionSubhead}>
                                {regionTitle.get(rid) ?? "Unknown region"}
                              </div>
                              {items.map(({ l, name }) => renderMarkerRow(l, name))}
                            </Fragment>
                          ));
                        })()}
                    </Fragment>
                  );
                })
                .filter(Boolean);
              // Hide whole groups that have no matching categories while searching.
              if (q && catNodes.length === 0) return null;
              return (
                <div key={g.id} className={styles.group}>
                  <div className={styles.groupTitle}>
                    <button
                      type="button"
                      className={styles.chevron}
                      onClick={() => setGroupCollapsed(g.id, groupExpanded)}
                      aria-label={groupExpanded ? "Collapse" : "Expand"}
                    >
                      {groupExpanded ? "▾" : "▸"}
                    </button>
                    <span className={styles.swatch} style={{ background: g.color }} />
                    <span
                      className={styles.groupName}
                      onClick={() => setGroupCollapsed(g.id, groupExpanded)}
                      style={{ cursor: "pointer" }}
                      title={groupExpanded ? "Collapse" : "Expand"}
                    >
                      {g.title}
                    </span>
                    <span className={styles.rowControls}>
                      <CheckToggle
                        state={groupFound === 0 ? "none" : groupDone ? "all" : "partial"}
                        onClick={() => setManyChecked.current(groupTrackedIds, !groupDone)}
                        label={groupDone ? "Clear all" : "Mark all found"}
                      />
                      <TrackStar
                        state={groupTrack}
                        onClick={() => setManyTracked(groupIds, groupTrack !== "all")}
                        label={groupTrack === "all" ? "All count toward progress" : "Count all toward progress"}
                      />
                      <EyeToggle
                        on={groupVis === "all"}
                        partial={groupVis === "partial"}
                        onClick={() => setGroupHidden(g.id, groupIds, groupVis === "all")}
                        label={groupVis === "all" ? "Hide all" : "Show all"}
                      />
                    </span>
                  </div>
                  {groupExpanded && catNodes}
                </div>
              );
            })
            .filter(Boolean);
          if (q && groupNodes.length === 0) {
            return (
              <div className={styles.noResults}>
                No markers match “{search.trim()}”.
              </div>
            );
          }
          return groupNodes;
        })()}
      </aside>

      <div className={styles.mapWrap}>
        <div ref={containerRef} className={styles.map} />
        {!ready && <div className={styles.loading}>Loading map…</div>}
      </div>

      {lightboxSrc && (
        <div
          className={styles.lightbox}
          onClick={() => setLightboxSrc(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            className={styles.lightboxClose}
            onClick={() => setLightboxSrc(null)}
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            ×
          </button>
          {/* Stop clicks on the image itself from dismissing the overlay. */}
          <img
            className={styles.lightboxImg}
            src={lightboxSrc}
            alt=""
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

// Show/hide toggle styled to sit beside the progress star: an eye that gains a
// slash when the row is hidden from the map.
function EyeToggle({
  on,
  partial = false,
  onClick,
  label,
}: {
  on: boolean;
  partial?: boolean;
  onClick: () => void;
  label: string;
}) {
  const off = !on && !partial;
  return (
    <button
      type="button"
      className={`${styles.eyeBtn} ${off ? styles.eyeOff : ""} ${partial ? styles.eyePartial : ""}`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
        {off && <line x1="3" y1="3" x2="21" y2="21" />}
      </svg>
    </button>
  );
}

// Progress-tracking star with all/partial/none states (★ gold / ★ dim / ☆).
function TrackStar({
  state,
  onClick,
  label,
}: {
  state: "all" | "partial" | "none";
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.trackStar} ${
        state === "all" ? styles.tracked : state === "partial" ? styles.trackedPartial : ""
      }`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {state === "none" ? "☆" : "★"}
    </button>
  );
}

// Completion toggle — a check-in-circle that reads as found/in-progress/empty.
// On marker rows it's a simple on/off; on region and category rows it reflects
// (and toggles) the whole section: "all" found, "partial", or "none".
function CheckToggle({
  state,
  onClick,
  label,
}: {
  state: "none" | "partial" | "all";
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.checkBtn} ${
        state === "all" ? styles.checkAll : state === "partial" ? styles.checkPartial : ""
      }`}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="12" r="9" />
        {state === "all" && <path d="M8 12l2.5 2.5L16 9" />}
        {state === "partial" && <line x1="8" y1="12" x2="16" y2="12" />}
      </svg>
    </button>
  );
}

// Crosshair "fly to" button — centers the camera on a region (the region row's
// title now toggles expand/collapse, so jumping needs its own control).
function JumpButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={styles.eyeBtn}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <line x1="2" x2="5" y1="12" y2="12" />
        <line x1="19" x2="22" y1="12" y2="12" />
        <line x1="12" x2="12" y1="2" y2="5" />
        <line x1="12" x2="12" y1="19" y2="22" />
        <circle cx="12" cy="12" r="7" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
  );
}

// A small sidebar chip mirroring the map pin: the category's group color with
// its white icon, so the list correlates with the markers. Categories without a
// baked icon fall back to a plain colored dot.
function IconChip({ color, slug }: { color: string; slug?: string }) {
  const svg = slug ? ICONS[slug] : undefined;
  if (!svg) return <span className={styles.swatch} style={{ background: color }} />;
  return (
    <span
      className={styles.iconChip}
      style={{ background: color }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

// Render the small markdown subset used in marker descriptions: paragraphs
// (blank-line separated), single-newline breaks, **bold**, _italic_/*italic*,
// bullet lists, and [label](url) links. Links are built as DOM nodes so the
// ones carrying ?locationIds=N keep their in-app jump handler. Output is a
// fragment of <p>/<ul> blocks — no innerHTML, so nothing in the description can
// inject markup.
function renderDescription(
  text: string,
  onJump: (id: number) => void,
): DocumentFragment {
  const frag = document.createDocumentFragment();
  const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);
  const clean = text.replace(/\r\n?/g, "\n"); // normalize CRLF/CR

  for (const block of clean.split(/\n{2,}/)) {
    if (!block.trim()) continue;
    const lines = block.split("\n");

    // Walk the block's lines, grouping runs of bullets into a <ul> and runs of
    // other lines into a <p> — so a "lead-in:" line followed by bullets (no
    // blank line between) still renders as text + list.
    let i = 0;
    while (i < lines.length) {
      if (isBullet(lines[i])) {
        const ul = document.createElement("ul");
        ul.className = styles.popupList;
        while (i < lines.length && isBullet(lines[i])) {
          const li = document.createElement("li");
          for (const n of parseInline(lines[i].replace(/^\s*[-*]\s+/, ""), onJump)) {
            li.appendChild(n);
          }
          ul.appendChild(li);
          i++;
        }
        frag.appendChild(ul);
      } else {
        const p = document.createElement("p");
        p.className = styles.popupPara;
        let first = true;
        while (i < lines.length && !isBullet(lines[i])) {
          if (lines[i].trim()) {
            if (!first) p.appendChild(document.createElement("br"));
            for (const n of parseInline(lines[i], onJump)) p.appendChild(n);
            first = false;
          }
          i++;
        }
        if (p.childNodes.length) frag.appendChild(p);
      }
    }
  }
  return frag;
}

// Inline markdown -> DOM nodes. Recursive so emphasis can wrap links etc.
const INLINE_TOKENS: { type: string; re: RegExp }[] = [
  { type: "link", re: /\[([^\]]+)\]\(([^)]+)\)/ },
  { type: "bold", re: /\*\*([\s\S]+?)\*\*/ },
  { type: "italic", re: /_([^_]+)_/ },
  { type: "italic", re: /\*([^*\n]+)\*/ },
];

function parseInline(text: string, onJump: (id: number) => void): Node[] {
  const out: Node[] = [];
  let rest = text;

  while (rest.length) {
    let best: { type: string; m: RegExpExecArray } | null = null;
    for (const { type, re } of INLINE_TOKENS) {
      const m = re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { type, m };
    }
    if (!best) {
      out.push(document.createTextNode(rest));
      break;
    }

    const { type, m } = best;
    if (m.index > 0) out.push(document.createTextNode(rest.slice(0, m.index)));

    if (type === "link") {
      out.push(makeLink(m[1], m[2], onJump));
    } else {
      const el = document.createElement(type === "bold" ? "strong" : "em");
      for (const n of parseInline(m[1], onJump)) el.appendChild(n);
      out.push(el);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function makeLink(
  label: string,
  url: string,
  onJump: (id: number) => void,
): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = styles.popupLink;
  a.textContent = label;
  // Marker links are stored as real relative URLs, e.g. "?locationIds=123".
  const idMatch = url.match(/locationIds=(\d+)/);
  if (idMatch) {
    const targetId = Number(idMatch[1]);
    a.href = url; // a genuine, shareable link to the marker
    a.addEventListener("click", (ev) => {
      // Plain left-click jumps in-app (no reload). Let cmd/ctrl/middle-click
      // through so the link can still be opened in a new tab.
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey ||
          ev.shiftKey || ev.altKey) {
        return;
      }
      ev.preventDefault();
      onJump(targetId);
    });
  } else {
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  }
  return a;
}
