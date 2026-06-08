import path from "node:path";

// Where ingested map data lives at runtime. This is deliberately OUTSIDE the
// Next.js `public/` folder: `public/` is a build-time concept (baked into the
// build artifact / Docker image and effectively immutable), whereas scraped
// maps are mutable, runtime-written, and 100s of MB. In production the data dir
// is a persisted volume; in dev it defaults to ./data next to the project.
// MAP_TRACKER_DATA_DIR is set explicitly in every run path: the npm dev/start
// scripts (./data) and the Dockerfile (/data). The fallback below exists only
// as a last resort and is intentionally built from process.env.PWD (a dynamic
// value) rather than process.cwd() — Turbopack's file tracer constant-folds
// process.cwd() to the project root and would pull the 18k+ tiles under ./data
// into the build trace. Keeping the base dynamic avoids that over-bundling.
export const DATA_DIR =
  process.env.MAP_TRACKER_DATA_DIR ??
  path.resolve(process.env.PWD ?? ".", "data");

// Root holding <game>/<map>/{data.json,tiles,media}.
export function mapsRoot(): string {
  return path.join(DATA_DIR, "maps");
}

export function mapDir(game: string, map: string): string {
  return path.join(mapsRoot(), game, map);
}

export function dataFile(game: string, map: string): string {
  return path.join(mapDir(game, map), "data.json");
}

// Join URL path segments under mapsRoot(), rejecting traversal. Returns null if
// any segment tries to escape (".." or absolute). Used by the asset/tile routes
// to serve files straight off disk safely.
export function safeMapsJoin(parts: string[]): string | null {
  if (parts.some((p) => p.includes("..") || p.includes("\0") || path.isAbsolute(p))) {
    return null;
  }
  const full = path.join(mapsRoot(), ...parts);
  const root = mapsRoot();
  // Defense in depth: the resolved path must stay within mapsRoot().
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}
