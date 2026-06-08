import { readFile } from "node:fs/promises";
import type { NextRequest } from "next/server";
import { safeMapsJoin } from "@/lib/paths";

// Serves non-tile map assets (marker media images) straight off the data dir:
//   <DATA_DIR>/maps/<game>/<map>/media/<file>
// Requested as /api/asset/<game>/<map>/media/<file>. Tiles have their own route
// (/api/tiles) because they need the blank-tile fallback for holes; media that
// is missing is a genuine 404. Files come only from local disk — no external
// requests at serve time.

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

export async function GET(
  _req: NextRequest,
  ctx: RouteContext<"/api/asset/[...path]">,
) {
  const { path: parts } = await ctx.params;
  const file = safeMapsJoin(parts);
  if (!file) return new Response("Not found", { status: 404 });

  const ext = parts[parts.length - 1]?.split(".").pop()?.toLowerCase() ?? "";
  try {
    const buf = await readFile(file);
    return new Response(buf, {
      status: 200,
      headers: {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        // Media for a given <game>/<map>/<file> never changes once ingested.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
