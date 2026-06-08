import type { NextRequest } from "next/server";
import { getStateSnapshot, profileExists } from "@/lib/profileStore";
import { channelKey, subscribe, unsubscribe } from "@/lib/syncBus";
import { safeProfilesJoin } from "@/lib/paths";
import type { SyncStreamMessage } from "@/lib/syncTypes";

// Server-Sent Events stream for one profile's view of one map. Each connected
// device holds one of these; a PATCH elsewhere broadcasts the delta here so it
// arrives live. On (re)connect we send a full snapshot first, so a reconnecting
// client always re-syncs to server truth and never misses an op across a drop.
//
// Streaming a Response from a route handler via ReadableStream is the documented
// approach in this Next version (node_modules/next/dist/docs/01-app/02-guides/
// streaming.md, "Streaming in Route Handlers"). Requires the Node runtime and
// dynamic rendering.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string; game: string; map: string }> };

const HEARTBEAT_MS = 15_000;

function sse(msg: SyncStreamMessage): string {
  if (msg.type === "snapshot") {
    return `event: snapshot\ndata: ${JSON.stringify(msg.state)}\n\n`;
  }
  return `event: op\ndata: ${JSON.stringify({ op: msg.op, originClientId: msg.originClientId })}\n\n`;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { id, game, map } = await ctx.params;

  // Validate everything BEFORE the stream opens — once streaming starts the
  // status code and headers are already sent and can't be changed.
  if (safeProfilesJoin([id, "state", game, `${map}.json`]) === null) {
    return new Response("Invalid path", { status: 400 });
  }
  if (!(await profileExists(id))) {
    return new Response("Unknown profile", { status: 404 });
  }

  const clientId = req.nextUrl.searchParams.get("clientId") ?? undefined;
  const channel = channelKey(id, game, map);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true; // controller already torn down
        }
      };

      // Suggest a 3s reconnect backoff to the browser's EventSource.
      send("retry: 3000\n\n");

      // Initial snapshot so the client hydrates (and re-syncs on reconnect).
      const state = await getStateSnapshot(id, game, map);
      send(sse({ type: "snapshot", state }));

      const onMessage = (msg: SyncStreamMessage) => {
        // Skip echoing an op back to the device that originated it.
        if (msg.type === "op" && msg.originClientId && msg.originClientId === clientId) {
          return;
        }
        send(sse(msg));
      };
      subscribe(channel, onMessage);

      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe(channel, onMessage);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Defeat proxy buffering (nginx honors this; harmless to HAProxy).
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
