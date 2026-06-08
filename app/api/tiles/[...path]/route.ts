import { readFile } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { safeMapsJoin } from "@/lib/paths";

// Serves base-map tiles from the locally-ingested data dir:
//   <DATA_DIR>/maps/<game>/<map>/tiles/{z}/{y}/{x}.<ext>
// Requested by MapLibre as /api/tiles/<game>/<map>/{z}/{y}/{x}.<ext>.
// Missing tiles (holes outside the island) return a blank tile so MapLibre
// doesn't log errors. Tiles come only from local disk — no external requests.

// A fully-transparent 256x256 RGBA PNG served for holes (tiles inside the
// bounding box but outside the island's actual coverage). It must be a
// full-size, standard, strictly-valid PNG: MapLibre decodes raster tiles with
// createImageBitmap, and Chrome rejects malformed or 1x1 grayscale+alpha PNGs
// with "InvalidStateError: The source image could not be decoded". This buffer
// was validated to decode via createImageBitmap.
const BLANK_TILE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAABAKADAAQAAAABAAABAAAAAABn6hpJAAAEkElEQVR4Ae3QMQEAAADCoPVP7WsIiEBhwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDBgwIABAwYMGDDwAwMBPAABGrpAUwAAAABJRU5ErkJggg==",
  "base64",
);

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

// Bump this whenever BLANK_TILE's bytes change so caches revalidate to the new
// blank. NOT marked immutable: a "missing" tile isn't permanent content (a hole
// could later be filled, or the blank itself fixed), so the browser must be
// able to revalidate — otherwise a once-cached bad blank is frozen forever.
const BLANK_ETAG = '"blank-256-v2"';

function blankTile(req: NextRequest) {
  const headers = {
    "Content-Type": "image/png",
    // Cached for an hour, then revalidated (cheap 304 via ETag). No immutable.
    "Cache-Control": "public, max-age=3600, must-revalidate",
    ETag: BLANK_ETAG,
  };
  // Answer the revalidation cheaply: if the client already holds this exact
  // blank, send a bodiless 304 instead of re-shipping the PNG.
  if (req.headers.get("if-none-match") === BLANK_ETAG) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(BLANK_TILE, { status: 200, headers });
}

export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/tiles/[...path]">,
) {
  const { path: parts } = await ctx.params;
  // [game, map, z, y, "x.ext"]
  if (parts.length !== 5) {
    return blankTile(req);
  }

  const [game, map, z, y, xFile] = parts;
  const ext = xFile.split(".").pop() ?? "jpg";
  const file = safeMapsJoin([game, map, "tiles", z, y, xFile]);
  if (!file) return blankTile(req);

  try {
    const buf = await readFile(file);
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return blankTile(req);
  }
}
