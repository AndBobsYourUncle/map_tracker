import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { profilesFile, profilesRoot, safeProfilesJoin } from "@/lib/paths";
import type { MapStateSnapshot, Profile, SyncOp } from "@/lib/syncTypes";

// Server-side store for synced tracker state. Mirrors the in-memory singleton
// style of lib/ingestJobs.ts: an authoritative cache lives in module scope for
// the life of the single-instance server process, backed by durable JSON files
// under <DATA_DIR>/profiles/ so progress survives restarts and redeploys.
//
//   profiles.json                       — the profile registry
//   <profileId>/state/<game>/<map>.json — one profile's progress for one map
//
// Writes are human-paced (a click = an op), so each mutation is a write-through:
// we await an atomic temp-write + rename, serialized per file to avoid torn
// writes. Reads are served from the in-memory cache after the first load.

// ── Profile registry ──────────────────────────────────────────────────────

let registry: Profile[] | null = null;
let registryLoading: Promise<Profile[]> | null = null;

async function loadRegistry(): Promise<Profile[]> {
  if (registry) return registry;
  if (registryLoading) return registryLoading;
  registryLoading = (async () => {
    let loaded: Profile[];
    try {
      const raw = await readFile(profilesFile(), "utf8");
      const parsed = JSON.parse(raw);
      loaded = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    } catch {
      loaded = [];
    }
    registry = loaded;
    registryLoading = null;
    return loaded;
  })();
  return registryLoading;
}

export async function listProfiles(): Promise<Profile[]> {
  return [...(await loadRegistry())];
}

export async function profileExists(id: string): Promise<boolean> {
  return (await loadRegistry()).some((p) => p.id === id);
}

export async function createProfile(rawName: string): Promise<Profile> {
  const name = rawName.trim().slice(0, 60);
  if (!name) throw new Error("Profile name is required");
  const profiles = await loadRegistry();
  const profile: Profile = {
    id: crypto.randomUUID(),
    name,
    createdAt: Date.now(),
  };
  profiles.push(profile);
  await atomicWrite(profilesFile(), JSON.stringify({ profiles }, null, 2));
  return profile;
}

// ── Per-map state ───────────────────────────────────────────────────────────

interface MapState {
  checked: Set<number>;
  hiddenLocs: Set<number>;
  untrackedLocs: Set<number>;
  hideCompleted: boolean;
  rev: number;
}

const stateCache = new Map<string, MapState>();
const stateLoading = new Map<string, Promise<MapState>>();

function cacheKey(id: string, game: string, map: string): string {
  return `${id}/${game}/${map}`;
}

// Resolve the on-disk file for a profile's map state, guarding traversal.
function stateFile(id: string, game: string, map: string): string {
  const file = safeProfilesJoin([id, "state", game, `${map}.json`]);
  if (!file) throw new Error("Invalid profile/map path");
  return file;
}

function emptyState(): MapState {
  return {
    checked: new Set(),
    hiddenLocs: new Set(),
    untrackedLocs: new Set(),
    hideCompleted: false,
    rev: 0,
  };
}

function toNumberSet(v: unknown): Set<number> {
  return Array.isArray(v) ? new Set(v.filter((n) => typeof n === "number")) : new Set();
}

async function loadState(id: string, game: string, map: string): Promise<MapState> {
  const key = cacheKey(id, game, map);
  const cached = stateCache.get(key);
  if (cached) return cached;
  const inFlight = stateLoading.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    let state: MapState;
    try {
      const raw = await readFile(stateFile(id, game, map), "utf8");
      const p = JSON.parse(raw);
      state = {
        checked: toNumberSet(p.checked),
        hiddenLocs: toNumberSet(p.hiddenLocs),
        untrackedLocs: toNumberSet(p.untrackedLocs),
        hideCompleted: Boolean(p.hideCompleted),
        rev: typeof p.rev === "number" ? p.rev : 0,
      };
    } catch {
      state = emptyState();
    }
    stateCache.set(key, state);
    stateLoading.delete(key);
    return state;
  })();
  stateLoading.set(key, promise);
  return promise;
}

function snapshot(state: MapState): MapStateSnapshot {
  return {
    checked: [...state.checked],
    hiddenLocs: [...state.hiddenLocs],
    untrackedLocs: [...state.untrackedLocs],
    hideCompleted: state.hideCompleted,
    rev: state.rev,
  };
}

export async function getStateSnapshot(
  id: string,
  game: string,
  map: string,
): Promise<MapStateSnapshot> {
  return snapshot(await loadState(id, game, map));
}

function setForField(state: MapState, kind: "checked" | "hidden" | "untracked"): Set<number> {
  if (kind === "checked") return state.checked;
  if (kind === "hidden") return state.hiddenLocs;
  return state.untrackedLocs;
}

// Apply one delta op, bump the revision, and durably persist before returning.
export async function applyOp(
  id: string,
  game: string,
  map: string,
  op: SyncOp,
): Promise<MapStateSnapshot> {
  const state = await loadState(id, game, map);
  if (op.kind === "hideCompleted") {
    state.hideCompleted = op.value;
  } else {
    const set = setForField(state, op.kind);
    for (const n of op.ids) {
      if (op.action === "add") set.add(n);
      else set.delete(n);
    }
  }
  state.rev++;
  await persist(id, game, map, state);
  return snapshot(state);
}

// Replace the whole state (used by the one-time localStorage import).
export async function replaceState(
  id: string,
  game: string,
  map: string,
  fields: Omit<MapStateSnapshot, "rev">,
): Promise<MapStateSnapshot> {
  const state = await loadState(id, game, map);
  state.checked = new Set(fields.checked);
  state.hiddenLocs = new Set(fields.hiddenLocs);
  state.untrackedLocs = new Set(fields.untrackedLocs);
  state.hideCompleted = Boolean(fields.hideCompleted);
  state.rev++;
  await persist(id, game, map, state);
  return snapshot(state);
}

// ── Durable, serialized writes ────────────────────────────────────────────

// One chained promise per file so concurrent ops never produce a torn write.
const writeQueues = new Map<string, Promise<void>>();

function persist(id: string, game: string, map: string, state: MapState): Promise<void> {
  const file = stateFile(id, game, map);
  const payload = JSON.stringify(
    {
      checked: [...state.checked],
      hiddenLocs: [...state.hiddenLocs],
      untrackedLocs: [...state.untrackedLocs],
      hideCompleted: state.hideCompleted,
      rev: state.rev,
      updatedAt: Date.now(),
    },
    null,
    0,
  );
  const prev = writeQueues.get(file) ?? Promise.resolve();
  const next = prev.then(() => atomicWrite(file, payload)).catch(() => {});
  writeQueues.set(
    file,
    next.finally(() => {
      if (writeQueues.get(file) === next) writeQueues.delete(file);
    }),
  );
  return next;
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, file);
}

// Ensure the profiles dir exists (registry writes go through atomicWrite which
// mkdirs the parent, so this is mainly defensive / for first run).
export async function ensureProfilesDir(): Promise<void> {
  await mkdir(profilesRoot(), { recursive: true });
}
