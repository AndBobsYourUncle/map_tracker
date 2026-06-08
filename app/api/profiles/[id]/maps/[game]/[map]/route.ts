import { NextResponse, type NextRequest } from "next/server";
import {
  applyOp,
  getStateSnapshot,
  profileExists,
  replaceState,
} from "@/lib/profileStore";
import { broadcast, channelKey } from "@/lib/syncBus";
import { safeProfilesJoin } from "@/lib/paths";
import type { SyncOp } from "@/lib/syncTypes";

// Per-profile, per-map synced state.
//   GET                        -> { state: MapStateSnapshot }
//   PATCH { clientId, op }     -> applies one delta op, broadcasts it, { rev }
//   PUT   { checked, ... }     -> replaces the whole state (localStorage import)
// Open on the LAN (no auth). All paths are validated against the profiles subtree.

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; game: string; map: string }> };

// Reject params that would escape the profiles subtree before touching disk.
function validParams(id: string, game: string, map: string): boolean {
  return safeProfilesJoin([id, "state", game, `${map}.json`]) !== null;
}

function isValidOp(op: unknown): op is SyncOp {
  if (!op || typeof op !== "object") return false;
  const o = op as Record<string, unknown>;
  if (o.kind === "hideCompleted") return typeof o.value === "boolean";
  if (o.kind === "checked" || o.kind === "hidden" || o.kind === "untracked") {
    return (
      (o.action === "add" || o.action === "remove") &&
      Array.isArray(o.ids) &&
      o.ids.every((n) => typeof n === "number")
    );
  }
  return false;
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id, game, map } = await ctx.params;
  if (!validParams(id, game, map)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  if (!(await profileExists(id))) {
    return NextResponse.json({ error: "Unknown profile" }, { status: 404 });
  }
  return NextResponse.json({ state: await getStateSnapshot(id, game, map) });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id, game, map } = await ctx.params;
  if (!validParams(id, game, map)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  if (!(await profileExists(id))) {
    return NextResponse.json({ error: "Unknown profile" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { clientId, op } = (body ?? {}) as { clientId?: unknown; op?: unknown };
  if (!isValidOp(op)) {
    return NextResponse.json({ error: "Invalid op" }, { status: 400 });
  }

  const state = await applyOp(id, game, map, op);
  // Tell the other connected devices about the delta. The originating client
  // ignores its own echo via originClientId.
  broadcast(channelKey(id, game, map), {
    type: "op",
    op,
    originClientId: typeof clientId === "string" ? clientId : undefined,
  });
  return NextResponse.json({ rev: state.rev });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id, game, map } = await ctx.params;
  if (!validParams(id, game, map)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  if (!(await profileExists(id))) {
    return NextResponse.json({ error: "Unknown profile" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const numArr = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];

  const state = await replaceState(id, game, map, {
    checked: numArr(b.checked),
    hiddenLocs: numArr(b.hiddenLocs),
    untrackedLocs: numArr(b.untrackedLocs),
    hideCompleted: Boolean(b.hideCompleted),
  });
  // A full replace re-syncs every connected device.
  broadcast(channelKey(id, game, map), { type: "snapshot", state });
  return NextResponse.json({ rev: state.rev });
}
