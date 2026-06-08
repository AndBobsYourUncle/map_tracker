#!/usr/bin/env node
// Bakes the marker icons we use into lib/marker-icons.json so the app has no
// runtime dependency on lucide. Reads SVGs straight from lucide-static (ISC
// licensed) so we never hand-transcribe path data.
//
//   node scripts/build-marker-icons.mjs
//
// Each category in a map's data.json carries an `icon` slug (e.g. "boss",
// "fish"). We map those slugs to Lucide icon names below. Slugs mapped to null
// have no clean Lucide match — the app falls back to a plain colored dot for
// them, and they're reported here as candidates for hand-drawn SVGs.

import fs from "node:fs";
import path from "node:path";

const ICONS_DIR = path.join(process.cwd(), "node_modules", "lucide-static", "icons");
const OUT = path.join(process.cwd(), "lib", "marker-icons.json");

// slug -> lucide icon name (or null = no clean match)
const MAP = {
  // Locations
  breakable_surface: "pickaxe",      // ~ approximate
  button: "concierge-bell",
  kear_lock: "lock",                 // ~ game-specific lock variant
  lock: "lock",
  mirror: "mirror-round",
  pipe: "arrow-up-from-dot",         // launch pipe — an arrow anchored to a point
  point_of_interest: "map-pin",
  spark_lock: "lock",                // ~ game-specific lock variant
  statue: "person-standing",
  statue_head: "venetian-mask",      // ~ a sculpted face/head
  train_station: "train-front",
  transition: "door-open",
  underlab: "mountain",              // ~ the mountain the lab is buried under
  vial_lock: "lock",                 // ~ game-specific lock variant
  // Collection
  bonestone_gem: "gem",
  cloak_upgrade: "shirt",            // ~ no cloak/cape icon in Lucide
  fish: "fish",
  fishing_upgrade: "fishing-rod",
  health_rose: "rose",
  joule_box: "battery",
  kear: "key",
  sidearm: "bow-arrow",              // ranged weapon (non-firearm); pairs with weapon=sword
  spark_container: "zap",
  spark_generator: "plug-zap",
  trinket: "sparkles",               // ~ approximate
  trinket_bag: "backpack",
  underlab_equipment: "wrench",
  vial_pouch: "flask-conical",
  weapon: "sword",
  // NPCs
  boss: "skull",
  merchant: "store",
  npc: "user",
  // Other
  easter_egg: "egg",
  interactable: "hand",
  miscellaneous: "help-circle",
  newspaper: "newspaper",
};

// Slugs the app renders white on the colored marker; these get a slightly
// heavier stroke so they read at small sizes.
const STROKE = "#ffffff";
const STROKE_WIDTH = "2.25";

function loadSvg(name) {
  const file = path.join(ICONS_DIR, `${name}.svg`);
  let svg = fs.readFileSync(file, "utf8");
  svg = svg
    .replace(/<!--[\s\S]*?-->/g, "") // strip license comment
    .replace(/\sclass="[^"]*"/, "")
    .replace(/stroke="currentColor"/, `stroke="${STROKE}"`)
    .replace(/stroke-width="[^"]*"/, `stroke-width="${STROKE_WIDTH}"`)
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return svg;
}

const icons = {};
const missing = [];
const unmatched = [];

for (const [slug, name] of Object.entries(MAP)) {
  if (name === null) {
    unmatched.push(slug);
    continue;
  }
  if (!fs.existsSync(path.join(ICONS_DIR, `${name}.svg`))) {
    missing.push(`${slug} -> ${name}`);
    continue;
  }
  icons[slug] = loadSvg(name);
}

if (missing.length) {
  console.error("ERROR: lucide icons not found (bad name in MAP):");
  for (const m of missing) console.error("  " + m);
  process.exit(1);
}

fs.writeFileSync(OUT, JSON.stringify(icons, null, 2) + "\n");

console.log(`Wrote ${Object.keys(icons).length} icons -> ${path.relative(process.cwd(), OUT)}`);
console.log(`\nSlugs with NO clean Lucide match (fall back to colored dot):`);
for (const s of unmatched) console.log("  - " + s);
