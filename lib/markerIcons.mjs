// Shared marker-icon helpers, used by both the build-time baker
// (scripts/build-marker-icons.mjs) and the runtime resolver (the map page).
//
// Built-in icons are baked into lib/marker-icons.json at build time. On top of
// those, a self-hoster can add their own category mappings at runtime — without
// rebuilding — by dropping a <DATA_DIR>/marker-icons.custom.json file (see
// resolveMarkerIcons). Everything reads local files only; no network at serve
// time. Lucide ships static SVGs (ISC licensed) so we never transcribe paths.

import fs from "node:fs";
import path from "node:path";

// Lucide's static icons live under node_modules relative to the working dir.
// This holds in every run path: the build script and `next dev`/`next build`
// (cwd = repo root) and the standalone server (cwd = the app dir, where
// outputFileTracingIncludes in next.config.ts places the icon set). Using
// process.cwd() rather than import.meta.url keeps it bundler-safe — Turbopack
// rewrites import.meta.url, which breaks require.resolve in the server bundle.
export const ICONS_DIR = path.join(
  process.cwd(),
  "node_modules",
  "lucide-static",
  "icons",
);

// Glyphs render white on the colored marker; a slightly heavier stroke keeps
// them legible at small sizes.
const STROKE = "#ffffff";
const STROKE_WIDTH = "2.25";

// Normalize a raw Lucide SVG: strip the license comment + class attribute,
// recolor the stroke, bump the stroke width, and collapse whitespace.
export function normalizeIconSvg(raw) {
  return raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\sclass="[^"]*"/, "")
    .replace(/stroke="currentColor"/, `stroke="${STROKE}"`)
    .replace(/stroke-width="[^"]*"/, `stroke-width="${STROKE_WIDTH}"`)
    .replace(/\s*\n\s*/g, " ")
    .trim();
}

// Load + normalize a Lucide icon by name. Returns null if there's no such icon.
export function loadLucideIcon(name) {
  const file = path.join(ICONS_DIR, `${name}.svg`);
  if (!fs.existsSync(file)) return null;
  return normalizeIconSvg(fs.readFileSync(file, "utf8"));
}

const CUSTOM_FILE = "marker-icons.custom.json";

// Merge user-supplied icon mappings over the baked built-ins. The custom file
// (<dataDir>/marker-icons.custom.json) maps a category slug to either a Lucide
// icon name (resolved against the bundled set, same as the built-ins) or, for a
// fully bespoke glyph, a raw "<svg …>" string used as-is. A missing/unreadable/
// malformed file or an unknown icon name is ignored, so a bad entry can never
// break the map — those categories just keep their built-in icon or colored dot.
export function resolveMarkerIcons(builtins, dataDir) {
  const merged = { ...builtins };
  let custom;
  try {
    custom = JSON.parse(fs.readFileSync(path.join(dataDir, CUSTOM_FILE), "utf8"));
  } catch {
    return merged;
  }
  if (!custom || typeof custom !== "object") return merged;
  for (const [slug, value] of Object.entries(custom)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const v = value.trim();
    const svg = v.startsWith("<svg") ? v : loadLucideIcon(v);
    if (svg) merged[slug] = svg;
  }
  return merged;
}
