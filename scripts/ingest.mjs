#!/usr/bin/env node
// CLI wrapper around lib/ingest.mjs.
//
//   node scripts/ingest.mjs <mapUrl> [--max-zoom N] [--concurrency N]
//   e.g. node scripts/ingest.mjs https://example.com/some-game/maps/some-map
//
// The full map URL is supplied by the caller, so no host is baked in. Output
// goes to <DATA_DIR>/maps/<game>/<map>/ (DATA_DIR = MAP_TRACKER_DATA_DIR, or
// ./data by default). After this runs the app serves everything locally.

import path from "node:path";
import { ingestMap } from "../lib/ingest.mjs";

const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith("--"));
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

if (!positionals[0]) {
  console.error(
    "Usage: node scripts/ingest.mjs <mapUrl> [--max-zoom N] [--concurrency N]\n" +
      "  e.g. node scripts/ingest.mjs https://example.com/some-game/maps/some-map",
  );
  process.exit(1);
}

// Resolve the data maps root the same way lib/paths.ts does (kept in sync).
const DATA_DIR =
  process.env.MAP_TRACKER_DATA_DIR ?? path.resolve(process.env.PWD ?? ".", "data");
const mapsRoot = path.join(DATA_DIR, "maps");

let lastLine = "";
function onProgress({ phase, done, total, message }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const line = `  ${phase}${message ? ` ${message}` : ""}: ${done}/${total} (${pct}%)`;
  // Carriage-return overwrite while a phase is in flight; newline when it ends.
  process.stdout.write(`\r${line}   `);
  if (done === total) { process.stdout.write("\n"); lastLine = ""; }
  else lastLine = line;
}

console.log(`\nIngesting via ${positionals[0]}`);
console.log(`  out: ${mapsRoot}\n`);

ingestMap(positionals[0], {
  mapsRoot,
  maxZoom: flag("max-zoom", null),
  concurrency: Number(flag("concurrency", "24")),
  onProgress,
})
  .then((r) => {
    if (lastLine) process.stdout.write("\n");
    console.log(
      `\nDone: ${r.game}/${r.map} — tiles saved=${r.counts.saved}, holes=${r.counts.holes}, ` +
        `skipped=${r.counts.skipped}; ${r.counts.groups} groups, ${r.counts.regions} regions, ` +
        `${r.counts.locations} locations.`,
    );
  })
  .catch((err) => {
    console.error("\nIngest failed:", err);
    process.exit(1);
  });
