"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { installDecodeDebug, attachMapErrorLogger } from "./mapDebug";
import type { MapData, MapLocation } from "@/lib/types";
import markerIcons from "@/lib/marker-icons.json";
import {
  getSelectedProfile,
  LOCAL_PROFILE,
  onProfileChange,
} from "@/lib/profile";
import type { MapStateSnapshot, SyncOp } from "@/lib/syncTypes";
import ProfileSwitcher, { type SyncStatus } from "./ProfileSwitcher";
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
  // Mobile only: whether the sidebar drawer is open. On desktop the sidebar is
  // always visible and this flag is ignored (see the CSS media query).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Mobile drawer drag: the left-edge open strip, the drawer itself, and the
  // backdrop (all driven by native non-passive listeners), plus a ref mirror of
  // sidebarOpen so those listeners can read the latest value.
  const edgeRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const sidebarOpenRef = useRef(false);

  // ── Multi-device sync ──────────────────────────────────────────────────
  // The selected sync profile (sticky per device). "local" = today's
  // localStorage-only behavior; any other value is a server profile id whose
  // state syncs live over SSE.
  const [profileId, setProfileId] = useState<string>(LOCAL_PROFILE);
  const synced = profileId !== LOCAL_PROFILE;
  // Per-tab id so the server can avoid echoing our own ops back to us.
  const clientIdRef = useRef<string | null>(null);
  if (clientIdRef.current == null) clientIdRef.current = crypto.randomUUID();
  // Live connection state, surfaced as a calm dot in the profile switcher.
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("connecting");
  // Mirrors of the hidden/untracked sets (like checkedRef) so persistence can
  // read the just-updated value synchronously, before setState has flushed.
  const hiddenLocsRef = useRef<Set<number>>(new Set());
  const untrackedLocsRef = useRef<Set<number>>(new Set());
  // Stable handle to the current commit(); the once-created map-click closures
  // (toggleChecked/setManyChecked refs) call through this to reach live state.
  const commitRef = useRef<(op: SyncOp) => void>(() => {});
  // Ops whose PATCH failed (offline); flushed in order on reconnect.
  const pendingOpsRef = useRef<SyncOp[]>([]);
  // One-time prompt to import this device's local progress into a fresh profile.
  const [importPrompt, setImportPrompt] = useState(false);

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

  // Hydrate from localStorage in LOCAL mode (client-only to avoid a hydration
  // mismatch). Synced profiles hydrate from the SSE snapshot instead — see the
  // sync effect below. Also re-runs when switching back to local.
  /* eslint-disable react-hooks/set-state-in-effect -- hydrating an external
     store (localStorage) into state on mount is the intended use here. */
  useEffect(() => {
    if (synced) return;
    const hidden = loadIdSet(hiddenLocsKey);
    hiddenLocsRef.current = hidden;
    setHiddenLocs(hidden);
    const untracked = loadIdSet(untrackedLocsKey);
    untrackedLocsRef.current = untracked;
    setUntrackedLocs(untracked);
    const hc = window.localStorage.getItem(hideCompletedKey) === "1";
    hideCompletedRef.current = hc;
    setHideCompleted(hc);

    // Checked: repaint the diff against whatever the map currently shows (covers
    // a profile switch while the map is live), then adopt the loaded set.
    const next = loadIdSet(storageKey);
    const map = mapRef.current;
    if (map) {
      for (const id of checkedRef.current) {
        if (!next.has(id)) map.setFeatureState({ source: SOURCE_ID, id }, { checked: false });
      }
      for (const id of next) {
        if (!checkedRef.current.has(id)) map.setFeatureState({ source: SOURCE_ID, id }, { checked: true });
      }
    }
    checkedRef.current = next;
    setChecked(next);

    // Start any group whose markers are entirely hidden collapsed.
    const collapsed = new Set<number>();
    for (const g of data.groups) {
      const ids = g.categories.flatMap((c) =>
        (locationsByCat.get(c.id) ?? []).map((l) => l.id),
      );
      if (ids.length > 0 && ids.every((id) => hidden.has(id))) collapsed.add(g.id);
    }
    setCollapsedGroups(collapsed);
  }, [synced, storageKey, hiddenLocsKey, untrackedLocsKey, hideCompletedKey, data, locationsByCat]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Apply cores ─────────────────────────────────────────────────────────
  // Each mutates React state + refs + the map, but does NOT persist. Public
  // actions call an apply core then commit(); incoming SSE ops call only the
  // apply core (no echo back to the server).

  // Repaint only the markers whose checked-state changed between two sets.
  function paintCheckedDiff(prev: Set<number>, next: Set<number>) {
    const map = mapRef.current;
    if (!map) return;
    for (const id of prev) {
      if (!next.has(id)) map.setFeatureState({ source: SOURCE_ID, id }, { checked: false });
    }
    for (const id of next) {
      if (!prev.has(id)) map.setFeatureState({ source: SOURCE_ID, id }, { checked: true });
    }
  }

  function applyCheckedOp(ids: number[], value: boolean) {
    const next = new Set(checkedRef.current);
    for (const id of ids) {
      if (value) next.add(id);
      else next.delete(id);
      mapRef.current?.setFeatureState({ source: SOURCE_ID, id }, { checked: value });
    }
    checkedRef.current = next;
    setChecked(next);
    const sync = popupSyncRef.current;
    if (sync && ids.includes(sync.id)) sync.render(value);
  }

  function applyHiddenOp(ids: number[], hidden: boolean) {
    const next = new Set(hiddenLocsRef.current);
    ids.forEach((id) => (hidden ? next.add(id) : next.delete(id)));
    hiddenLocsRef.current = next;
    setHiddenLocs(next);
  }

  function applyUntrackedOp(ids: number[], untracked: boolean) {
    const next = new Set(untrackedLocsRef.current);
    ids.forEach((id) => (untracked ? next.add(id) : next.delete(id)));
    untrackedLocsRef.current = next;
    setUntrackedLocs(next);
  }

  function applyHideCompletedLocal(value: boolean) {
    hideCompletedRef.current = value;
    setHideCompleted(value);
  }

  // Apply an op received over SSE (from another device) without re-sending it.
  function applyOpLocal(op: SyncOp) {
    if (op.kind === "hideCompleted") applyHideCompletedLocal(op.value);
    else if (op.kind === "checked") applyCheckedOp(op.ids, op.action === "add");
    else if (op.kind === "hidden") applyHiddenOp(op.ids, op.action === "add");
    else if (op.kind === "untracked") applyUntrackedOp(op.ids, op.action === "add");
  }

  // Replace all four fields from a server snapshot (initial load / reconnect).
  function applySnapshot(snap: MapStateSnapshot) {
    const nextChecked = new Set(snap.checked);
    paintCheckedDiff(checkedRef.current, nextChecked);
    checkedRef.current = nextChecked;
    setChecked(nextChecked);
    hiddenLocsRef.current = new Set(snap.hiddenLocs);
    setHiddenLocs(hiddenLocsRef.current);
    untrackedLocsRef.current = new Set(snap.untrackedLocs);
    setUntrackedLocs(untrackedLocsRef.current);
    applyHideCompletedLocal(snap.hideCompleted);
    const sync = popupSyncRef.current;
    if (sync) sync.render(nextChecked.has(sync.id));
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  // In local mode an op re-saves the affected set/bool to localStorage. In
  // synced mode it's PATCHed to the server, which broadcasts it to other devices.
  function commit(op: SyncOp) {
    if (synced) {
      void sendOp(op);
      return;
    }
    switch (op.kind) {
      case "checked":
        saveIdSet(storageKey, checkedRef.current);
        break;
      case "hidden":
        saveIdSet(hiddenLocsKey, hiddenLocsRef.current);
        break;
      case "untracked":
        saveIdSet(untrackedLocsKey, untrackedLocsRef.current);
        break;
      case "hideCompleted":
        window.localStorage.setItem(hideCompletedKey, op.value ? "1" : "0");
        break;
    }
  }
  // Keep the stable handle current (the map-click closures call through it).
  useEffect(() => {
    commitRef.current = commit;
  });

  async function sendOp(op: SyncOp) {
    try {
      const res = await fetch(`/api/profiles/${profileId}/maps/${game}/${mapSlug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: clientIdRef.current, op }),
      });
      if (!res.ok) throw new Error(`PATCH ${res.status}`);
    } catch {
      // Buffer for replay on reconnect; the UI already reflects the change.
      pendingOpsRef.current.push(op);
      if (pendingOpsRef.current.length > 1000) pendingOpsRef.current.shift();
      setSyncStatus("offline");
    }
  }

  async function flushPending() {
    if (pendingOpsRef.current.length === 0) return;
    const queue = pendingOpsRef.current;
    pendingOpsRef.current = [];
    for (const op of queue) await sendOp(op);
  }

  // ── One-time localStorage → profile import ──────────────────────────────
  function localHasProgress(): boolean {
    return (
      loadIdSet(storageKey).size > 0 ||
      loadIdSet(hiddenLocsKey).size > 0 ||
      loadIdSet(untrackedLocsKey).size > 0 ||
      window.localStorage.getItem(hideCompletedKey) === "1"
    );
  }
  function importDismissKey(): string {
    return `map-tracker:importDismissed:${profileId}:${game}:${mapSlug}`;
  }
  // Offer to import only when the profile is brand new (rev 0) for this map and
  // this device actually has local progress to bring over.
  function maybeOfferImport(snap: MapStateSnapshot) {
    if (snap.rev !== 0) return;
    if (!localHasProgress()) return;
    if (window.localStorage.getItem(importDismissKey()) === "1") return;
    setImportPrompt(true);
  }
  async function importLocalProgress() {
    try {
      await fetch(`/api/profiles/${profileId}/maps/${game}/${mapSlug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checked: [...loadIdSet(storageKey)],
          hiddenLocs: [...loadIdSet(hiddenLocsKey)],
          untrackedLocs: [...loadIdSet(untrackedLocsKey)],
          hideCompleted: window.localStorage.getItem(hideCompletedKey) === "1",
        }),
      });
      // The server broadcasts a snapshot; our own SSE applies it.
    } finally {
      setImportPrompt(false);
    }
  }
  function dismissImport() {
    window.localStorage.setItem(importDismissKey(), "1");
    setImportPrompt(false);
  }

  // ── Public actions (called by the sidebar/popup UI) ────────────────────────
  function updateHideCompleted(value: boolean) {
    applyHideCompletedLocal(value);
    commit({ kind: "hideCompleted", value });
  }
  function toggleLocHidden(id: number) {
    const hidden = !hiddenLocsRef.current.has(id);
    applyHiddenOp([id], hidden);
    commit({ kind: "hidden", action: hidden ? "add" : "remove", ids: [id] });
  }
  function setManyHidden(ids: number[], hidden: boolean) {
    applyHiddenOp(ids, hidden);
    commit({ kind: "hidden", action: hidden ? "add" : "remove", ids });
  }
  function toggleLocTracked(id: number) {
    // The set stores EXCLUDED markers, so toggling membership flips tracking.
    const untracked = !untrackedLocsRef.current.has(id);
    applyUntrackedOp([id], untracked);
    commit({ kind: "untracked", action: untracked ? "add" : "remove", ids: [id] });
  }
  function setManyTracked(ids: number[], tracked: boolean) {
    applyUntrackedOp(ids, !tracked);
    commit({ kind: "untracked", action: tracked ? "remove" : "add", ids });
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
    mapRef.current?.setFeatureState(
      { source: SOURCE_ID, id },
      { checked: nowChecked },
    );
    const sync = popupSyncRef.current;
    if (sync && sync.id === id) sync.render(nowChecked);
    // Persist (localStorage in local mode, or PATCH+broadcast when synced).
    commitRef.current({ kind: "checked", action: nowChecked ? "add" : "remove", ids: [id] });
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
    const sync = popupSyncRef.current;
    if (sync && ids.includes(sync.id)) sync.render(value);
    commitRef.current({ kind: "checked", action: value ? "add" : "remove", ids });
  });

  // Track the device's selected profile (sticky, shared with the home index).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProfileId(getSelectedProfile());
    return onProfileChange(setProfileId);
  }, []);

  // Live sync for a server profile: stream snapshots + ops over SSE, and
  // reconnect gracefully. A dropped connection is a non-event — EventSource
  // retries on its own; we only recreate it (with backoff) if it gives up.
  useEffect(() => {
    // In local mode there's no stream; syncStatus is unused (the switcher is
    // passed null), so nothing to do here.
    if (!synced) return;
    let closed = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;
    const url = `/api/profiles/${profileId}/maps/${game}/${mapSlug}/stream?clientId=${clientIdRef.current}`;

    const open = () => {
      es = new EventSource(url);
      es.onopen = () => {
        setSyncStatus("synced");
        backoff = 1000;
        void flushPending();
      };
      es.addEventListener("snapshot", (e) => {
        const snap: MapStateSnapshot = JSON.parse((e as MessageEvent).data);
        applySnapshot(snap);
        setSyncStatus("synced");
        void flushPending();
        maybeOfferImport(snap);
      });
      es.addEventListener("op", (e) => {
        const { op, originClientId } = JSON.parse((e as MessageEvent).data) as {
          op: SyncOp;
          originClientId?: string;
        };
        if (originClientId === clientIdRef.current) return; // ignore our own echo
        applyOpLocal(op);
      });
      es.onerror = () => {
        if (es && es.readyState === EventSource.CLOSED) {
          // Gave up — recreate with capped exponential backoff.
          setSyncStatus("offline");
          es = null;
          if (!closed) {
            reconnectTimer = setTimeout(() => {
              if (!closed) open();
            }, backoff);
            backoff = Math.min(backoff * 2, 15_000);
          }
        } else {
          // Transient: EventSource is reconnecting itself.
          setSyncStatus("connecting");
        }
      };
    };
    open();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
    // Handlers are stable in behavior; re-subscribing only on the channel keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, profileId, game, mapSlug]);

  // Initialize the map once.
  useEffect(() => {
    if (mapRef.current || !containerRef.current) return;

    installDecodeDebug(); // diagnostic: trace intermittent tile decode failures

    // checkedRef is populated by the hydration / sync effects (localStorage in
    // local mode, the SSE snapshot when synced); the on-load apply below paints
    // whatever it holds by then.

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

      // Below this zoom the map is too far out for an open popup to make sense
      // (it floats over a tiny patch), so on mobile we hide it until the user
      // zooms back in. A couple levels below the deepest zoom, but never below
      // near-min. Desktop has the room, so it's left visible there.
      const popupHideBelow = Math.max(map.getMinZoom() + 1, map.getMaxZoom() - 3);
      const syncPopupVisibility = () => {
        const el = activePopup?.getElement();
        if (!el) return;
        const isMobile = window.matchMedia("(max-width: 768px)").matches;
        el.style.visibility = isMobile && map.getZoom() < popupHideBelow ? "hidden" : "";
      };

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
        syncPopupVisibility();
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
        // of the marker rather than into its middle. On mobile we pin a fixed
        // anchor: without one MapLibre re-picks the anchor as the map moves,
        // which makes the popup jump around distractingly on a small screen.
        const isMobile =
          typeof window !== "undefined" &&
          window.matchMedia("(max-width: 768px)").matches;
        const popup = new maplibregl.Popup({
          closeButton: true,
          offset: pinPixelHeight(atZoom),
          maxWidth: "500px",
          ...(isMobile ? { anchor: "bottom" as const } : {}),
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
        syncPopupVisibility(); // respect the zoom-out hide threshold on open
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

  // After expanding a sidebar section near the bottom, reveal the rows that just
  // appeared. We scroll down by exactly how much of the expanded block is cut off
  // below the fold — but never so far that the header would scroll above the top
  // (so it's bounded by the content and can't overshoot). Mobile only; a no-op
  // when the block is already fully visible. The double rAF waits for the new
  // rows to lay out before measuring.
  function revealOnExpand(e: { currentTarget: HTMLElement }) {
    const container = sidebarRef.current;
    if (!container) return;
    if (!window.matchMedia("(max-width: 768px)").matches) return;
    const header = e.currentTarget.closest<HTMLElement>(
      `.${styles.category}, .${styles.groupTitle}`,
    );
    if (!header) return;
    // Measure AFTER React renders the expanded rows — the block doesn't exist
    // yet at click time, so read it (and measure) inside the rAF.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const block = header.nextElementSibling as HTMLElement | null;
        if (!block) return;
        const cRect = container.getBoundingClientRect();
        const belowFold = block.getBoundingClientRect().bottom - cRect.bottom;
        if (belowFold <= 0) return; // already fully visible
        const maxScroll = header.getBoundingClientRect().top - cRect.top; // keep header on screen
        const delta = Math.min(belowFold + 8, Math.max(0, maxScroll));
        if (delta > 4) container.scrollBy({ top: delta, behavior: "smooth" });
      }),
    );
  }

  function toggleRegionExpand(regionId: number, e?: { currentTarget: HTMLElement }) {
    const willOpen = !expandedRegions.has(regionId);
    setExpandedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(regionId)) next.delete(regionId);
      else next.add(regionId);
      return next;
    });
    if (willOpen && e) revealOnExpand(e);
  }

  function toggleRegionCat(key: string, e?: { currentTarget: HTMLElement }) {
    const willOpen = !expandedRegionCats.has(key);
    setExpandedRegionCats((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (willOpen && e) revealOnExpand(e);
  }

  function toggleCatExpand(catId: number, e?: { currentTarget: HTMLElement }) {
    const willOpen = !expandedCats.has(catId);
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      return next;
    });
    if (willOpen && e) revealOnExpand(e);
  }

  function setGroupCollapsed(
    groupId: number,
    collapsed: boolean,
    e?: { currentTarget: HTMLElement },
  ) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (collapsed) next.add(groupId);
      else next.delete(groupId);
      return next;
    });
    if (!collapsed && e) revealOnExpand(e); // !collapsed == expanding
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
          onClick={() => {
            jumpToRef.current?.(l.id);
            setSidebarOpen(false); // mobile: reveal the map after picking
          }}
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

  // Keep a ref mirror of sidebarOpen for the native touch listeners (which are
  // attached once and would otherwise capture a stale value).
  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  // Interactive drawer drag (mobile): the sidebar tracks the finger as you swipe
  // it open from the left-edge strip or closed from on the drawer, then animates
  // to the nearest resting state on release. Listeners are native + NON-passive
  // so preventDefault() can both own the gesture and suppress iOS Safari's edge
  // swipe-back. Transforms are written straight to the DOM (no per-frame React
  // re-render); state updates once, on release.
  useEffect(() => {
    const edge = edgeRef.current;
    const drawer = sidebarRef.current;
    if (!edge || !drawer) return;

    let mode: "open" | "close" | null = null;
    let axis: "none" | "x" | "y" = "none";
    let startX = 0;
    let startY = 0;
    let width = 300;
    let tx = 0;

    // Live-track: translate the drawer and fade the backdrop with the finger.
    const apply = (x: number) => {
      tx = Math.min(0, Math.max(-width, x));
      drawer.style.transition = "none";
      drawer.style.transform = `translateX(${tx}px)`;
      const bd = backdropRef.current;
      if (bd) {
        bd.style.transition = "none";
        bd.style.opacity = String((tx + width) / width);
        bd.style.pointerEvents = "none";
      }
    };

    // Release: animate to the chosen rest state, then hand control back to the
    // CSS classes once the transition completes (inline target == class target,
    // so clearing the inline styles causes no visual jump).
    const settle = (open: boolean) => {
      drawer.style.transition = "";
      drawer.style.transform = open ? "translateX(0)" : "translateX(-100%)";
      const bd = backdropRef.current;
      if (bd) {
        bd.style.transition = "";
        bd.style.opacity = open ? "1" : "0";
        bd.style.pointerEvents = open ? "auto" : "none";
      }
      setSidebarOpen(open);
      window.setTimeout(() => {
        drawer.style.transform = "";
        drawer.style.transition = "";
        if (bd) {
          bd.style.opacity = "";
          bd.style.pointerEvents = "";
          bd.style.transition = "";
        }
      }, 240);
    };

    // Returns the dominant axis once the finger has moved enough to tell, else
    // null. Returning it (rather than mutating `axis` in place) keeps TS's
    // control-flow narrowing accurate at the call sites.
    const decideAxis = (dx: number, dy: number): "x" | "y" | null => {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return null;
      return Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    };
    const reset = () => {
      mode = null;
      axis = "none";
    };

    // ── Open: swipe right from the left-edge strip ──
    const edgeStart = (e: TouchEvent) => {
      if (sidebarOpenRef.current) return;
      mode = "open";
      axis = "none";
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      width = drawer.offsetWidth || 300;
      tx = -width;
      e.preventDefault(); // claim the edge gesture from the browser
    };
    const edgeMove = (e: TouchEvent) => {
      if (mode !== "open") return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (axis === "none") {
        const a = decideAxis(dx, dy);
        if (!a) return;
        axis = a;
      }
      if (axis !== "x") return;
      e.preventDefault();
      apply(-width + dx);
    };
    const edgeEnd = () => {
      if (mode === "open" && axis === "x") settle(tx > -width * 0.6);
      reset();
    };

    // ── Close: drag left on the open drawer ──
    const drawerStart = (e: TouchEvent) => {
      if (!sidebarOpenRef.current) return;
      mode = "close";
      axis = "none";
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      width = drawer.offsetWidth || 300;
      tx = 0;
    };
    const drawerMove = (e: TouchEvent) => {
      if (mode !== "close") return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (axis === "none") {
        const a = decideAxis(dx, dy);
        if (!a) return;
        axis = a;
        if (axis === "y") {
          mode = null; // a vertical gesture — let the list scroll
          return;
        }
      }
      if (axis !== "x") return;
      e.preventDefault();
      apply(dx);
    };
    const drawerEnd = () => {
      if (mode === "close" && axis === "x") settle(tx > -width * 0.4);
      reset();
    };

    edge.addEventListener("touchstart", edgeStart, { passive: false });
    edge.addEventListener("touchmove", edgeMove, { passive: false });
    edge.addEventListener("touchend", edgeEnd);
    edge.addEventListener("touchcancel", edgeEnd);
    drawer.addEventListener("touchstart", drawerStart, { passive: true });
    drawer.addEventListener("touchmove", drawerMove, { passive: false });
    drawer.addEventListener("touchend", drawerEnd);
    drawer.addEventListener("touchcancel", drawerEnd);
    return () => {
      edge.removeEventListener("touchstart", edgeStart);
      edge.removeEventListener("touchmove", edgeMove);
      edge.removeEventListener("touchend", edgeEnd);
      edge.removeEventListener("touchcancel", edgeEnd);
      drawer.removeEventListener("touchstart", drawerStart);
      drawer.removeEventListener("touchmove", drawerMove);
      drawer.removeEventListener("touchend", drawerEnd);
      drawer.removeEventListener("touchcancel", drawerEnd);
    };
  }, []);

  return (
    <div className={styles.shell}>
      {/* Mobile-only: thin left-edge zone to swipe the drawer open (hidden on
          desktop via CSS). When the drawer is open it sits under it. Gesture
          handling is wired up natively in the effect above. */}
      <div ref={edgeRef} className={styles.edgeSwipe} />

      {/* Mobile-only: floating button to open the sidebar drawer. Hidden on
          desktop via CSS (the sidebar is always visible there). */}
      <button
        type="button"
        className={styles.menuBtn}
        onClick={() => setSidebarOpen(true)}
        aria-label="Open marker list"
      >
        <span />
        <span />
        <span />
      </button>

      {/* Backdrop behind the open drawer; tap to dismiss. Always mounted (so its
          opacity can be faded during a drag); CSS hides it on desktop. */}
      <div
        ref={backdropRef}
        className={`${styles.backdrop} ${sidebarOpen ? styles.backdropOpen : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <aside
        ref={sidebarRef}
        className={`${styles.sidebar} ${sidebarOpen ? styles.sidebarOpen : ""}`}
      >
        <div className={styles.sidebarHeader}>
          {/* Mobile-only close button for the drawer. */}
          <button
            type="button"
            className={styles.closeBtn}
            onClick={() => setSidebarOpen(false)}
            aria-label="Close marker list"
          >
            ×
          </button>
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

          {/* Sync profile picker + live connection status. */}
          <div className={styles.profileRow}>
            <ProfileSwitcher status={synced ? syncStatus : null} />
          </div>
          {importPrompt && (
            <div className={styles.importBanner}>
              <span>Import this device&apos;s progress into this profile?</span>
              <div className={styles.importBtns}>
                <button type="button" className={styles.importYes} onClick={importLocalProgress}>
                  Import
                </button>
                <button type="button" className={styles.importNo} onClick={dismissImport}>
                  Not now
                </button>
              </div>
            </div>
          )}

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
                            onClick={(e) => toggleRegionExpand(r.id, e)}
                            aria-label={open ? "Collapse region" : "Expand region"}
                          >
                            {open ? "▾" : "▸"}
                          </button>
                          <span
                            className={styles.catTitle}
                            onClick={(e) => toggleRegionExpand(r.id, e)}
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

                        {open && (
                          <div className={styles.expandBlock}>
                          {cats.map((cat) => {
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
                                    onClick={(e) => toggleRegionCat(ckey, e)}
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
                                    onClick={(e) => toggleRegionCat(ckey, e)}
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
                                {cOpen && (
                                  <div className={styles.expandBlock}>
                                    {locs.map((l, i) =>
                                      renderMarkerRow(l, l.title || `${catTitle.get(cat)} ${i + 1}`),
                                    )}
                                  </div>
                                )}
                              </Fragment>
                            );
                          })}
                          </div>
                        )}
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
                          onClick={(e) => toggleCatExpand(c.id, e)}
                          aria-label={expanded ? "Collapse" : "Expand"}
                        >
                          {expanded ? "▾" : "▸"}
                        </button>
                        <IconChip color={g.color} slug={c.icon ?? undefined} />
                        <span
                          className={styles.catTitle}
                          onClick={(e) => toggleCatExpand(c.id, e)}
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
                      {expanded && (
                        <div className={styles.expandBlock}>
                        {(() => {
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
                        </div>
                      )}
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
                      onClick={(e) => setGroupCollapsed(g.id, groupExpanded, e)}
                      aria-label={groupExpanded ? "Collapse" : "Expand"}
                    >
                      {groupExpanded ? "▾" : "▸"}
                    </button>
                    <span className={styles.swatch} style={{ background: g.color }} />
                    <span
                      className={styles.groupName}
                      onClick={(e) => setGroupCollapsed(g.id, groupExpanded, e)}
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
                  {groupExpanded && <div className={styles.expandBlock}>{catNodes}</div>}
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
