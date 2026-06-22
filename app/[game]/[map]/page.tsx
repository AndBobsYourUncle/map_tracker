import fs from "node:fs/promises";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import type { MapData } from "@/lib/types";
import { dataFile, DATA_DIR } from "@/lib/paths";
import { resolveMarkerIcons } from "@/lib/markerIcons";
import builtinIcons from "@/lib/marker-icons.json";
import MapTracker from "../../MapTracker";

async function loadData(game: string, map: string): Promise<MapData | null> {
  const file = dataFile(game, map);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as MapData;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: PageProps<"/[game]/[map]">): Promise<Metadata> {
  const { game, map } = await params;
  const data = await loadData(game, map);
  if (!data) return {};
  // Game name leads, the map name follows.
  return { title: `${data.game.title} – ${data.map.title}` };
}

export default async function MapPage({ params }: PageProps<"/[game]/[map]">) {
  const { game, map } = await params;
  const data = await loadData(game, map);
  if (!data) notFound();
  // Built-in icons, with any <DATA_DIR>/marker-icons.custom.json mappings layered
  // on top. Resolved on the server so the client gets a ready slug -> SVG map.
  const icons = resolveMarkerIcons(builtinIcons as Record<string, string>, DATA_DIR);
  return <MapTracker data={data} game={game} map={map} icons={icons} />;
}
