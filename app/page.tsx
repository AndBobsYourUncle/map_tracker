import fs from "node:fs/promises";
import path from "node:path";
import MapIndex, { type GameGroup } from "./MapIndex";
import { mapsRoot } from "@/lib/paths";

// The map list is read from the data dir at request time, and that dir changes
// at runtime (maps are added via the UI). Without this the page would be
// prerendered static at build (when the data dir is empty) and never update.
export const dynamic = "force-dynamic";

async function listGames(): Promise<GameGroup[]> {
  const root = mapsRoot();

  let games: string[] = [];
  try {
    games = (await fs.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }

  const groups: GameGroup[] = [];
  for (const game of games) {
    const gameDir = path.join(root, game);
    let maps: string[] = [];
    try {
      maps = (await fs.readdir(gameDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue;
    }

    const group: GameGroup = { slug: game, title: game, maps: [] };
    for (const map of maps) {
      try {
        const data = JSON.parse(
          await fs.readFile(path.join(gameDir, map, "data.json"), "utf8"),
        );
        group.title = data.game?.title ?? game;
        group.maps.push({
          game,
          map,
          mapTitle: data.map?.title ?? map,
          markers: data.locations?.length ?? 0,
        });
      } catch {
        // skip folders without a valid data.json (e.g. mid-ingest)
      }
    }
    if (group.maps.length) {
      group.maps.sort((a, b) => a.mapTitle.localeCompare(b.mapTitle));
      groups.push(group);
    }
  }
  groups.sort((a, b) => a.title.localeCompare(b.title));
  return groups;
}

export default async function Home() {
  const games = await listGames();
  return <MapIndex games={games} />;
}
