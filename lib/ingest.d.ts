export interface IngestProgress {
  phase: "page" | "media" | "tiles" | "write";
  done: number;
  total: number;
  message?: string;
}

export interface IngestOptions {
  /** Absolute path to the data maps root (e.g. mapsRoot() from lib/paths). */
  mapsRoot: string;
  maxZoom?: number | null;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (p: IngestProgress) => void;
}

export interface IngestResult {
  game: string;
  map: string;
  counts: {
    saved: number;
    holes: number;
    skipped: number;
    locations: number;
    regions: number;
    groups: number;
  };
}

export function ingestMap(mapUrl: string, opts: IngestOptions): Promise<IngestResult>;
