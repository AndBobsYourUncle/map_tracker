// Diagnostic logging for the intermittent
//   "InvalidStateError: The source image could not be decoded"
// MapLibre raster tiles are decoded via createImageBitmap; when that rejects it
// surfaces as an uncaught error with no context. These two hooks add context so
// the next occurrence can be traced to a specific tile / payload.
//
// TODO(diagnostic): remove once the decode failure is understood.

/* eslint-disable @typescript-eslint/no-explicit-any */

// Wrap the global createImageBitmap once so any decode rejection logs the
// offending payload's type, size, and first bytes (truncated image? HTML error
// page? empty body?). Re-throws so behavior is unchanged.
export function installDecodeDebug() {
  if (typeof window === "undefined") return;
  const w = window as any;
  if (w.__decodeDebugInstalled) return;
  const orig = w.createImageBitmap?.bind(window);
  if (!orig) return;
  w.__decodeDebugInstalled = true;
  w.createImageBitmap = function (src: any, ...rest: any[]) {
    return orig(src, ...rest).catch(async (err: any) => {
      try {
        if (src instanceof Blob) {
          const head = new Uint8Array(await src.slice(0, 32).arrayBuffer());
          const hex = [...head].map((b) => b.toString(16).padStart(2, "0")).join(" ");
          const ascii = String.fromCharCode(...head).replace(/[^\x20-\x7e]/g, ".");
          console.error(
            `[TILE-DECODE-FAIL] ${err?.name ?? "error"} — Blob type="${src.type}" size=${src.size}\n  first bytes: ${hex}\n  as text:     ${ascii}`,
          );
        } else {
          console.error(
            `[TILE-DECODE-FAIL] ${err?.name ?? "error"} — source kind=${src?.constructor?.name} w=${src?.width} h=${src?.height} src=${String(src?.currentSrc ?? "").slice(-100)}`,
          );
        }
      } catch {
        console.error(`[TILE-DECODE-FAIL] ${err?.name ?? "error"} (could not inspect source)`);
      }
      throw err;
    });
  };
}

// Log every MapLibre error with the tile coordinates / URL it relates to, so a
// decode failure can be tied to a specific z/x/y "section" of the map.
export function attachMapErrorLogger(
  map: any,
  tileUrl: (z: number, x: number, y: number) => string,
) {
  map.on("error", (e: any) => {
    const err = e?.error;
    const c = e?.tile?.tileID?.canonical ?? e?.coord?.canonical;
    const where = c
      ? `tile z${c.z}/x${c.x}/y${c.y} → ${tileUrl(c.z, c.x, c.y)}`
      : e?.sourceId
        ? `source=${e.sourceId}`
        : "(no tile context)";
    console.error(`[MAP-ERROR] ${err?.name ?? ""} ${err?.message ?? String(err)} | ${where}`);
  });
}
