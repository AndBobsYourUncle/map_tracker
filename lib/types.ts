export interface Category {
  id: number;
  title: string;
  icon: string | null;
  order: number;
}

export interface Group {
  id: number;
  title: string;
  color: string;
  order: number;
  categories: Category[];
}

export interface MapLocation {
  id: number;
  cat: number;
  region: number;
  lat: number;
  lng: number;
  title: string;
  desc: string | null;
  img: string | null;
}

export interface Region {
  id: number;
  title: string;
  subtitle: string | null;
  parent: number | null;
  order: number;
  count: number; // markers tagged with this region
  geometry: { type: "Polygon"; coordinates: number[][][] };
}

export interface MapConfig {
  initial_zoom: number;
  start_lat: number;
  start_lng: number;
  min_zoom: number;
  max_zoom: number;
  tile_ext: string;
  bounds: [number, number, number, number]; // [west, south, east, north]
}

export interface MapData {
  game: { slug: string; title: string };
  map: { id: number; title: string; slug: string };
  mapConfig: MapConfig;
  groups: Group[];
  regions: Region[];
  locations: MapLocation[];
}
