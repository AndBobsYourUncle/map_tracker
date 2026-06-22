/** Absolute path to the bundled Lucide static icons directory. */
export const ICONS_DIR: string;

/** Normalize a raw Lucide SVG (recolor stroke, bump width, collapse whitespace). */
export function normalizeIconSvg(raw: string): string;

/** Load + normalize a Lucide icon by name; null if no such icon exists. */
export function loadLucideIcon(name: string): string | null;

/**
 * Merge user-supplied icon mappings (<dataDir>/marker-icons.custom.json, mapping
 * a category slug to a Lucide icon name or a raw "<svg …>" string) over the
 * baked built-ins. Returns a slug -> SVG-string map. Robust to a missing or
 * malformed file.
 */
export function resolveMarkerIcons(
  builtins: Record<string, string>,
  dataDir: string,
): Record<string, string>;
