import type { SyncStreamMessage } from "@/lib/syncTypes";

// In-memory pub/sub for live multi-device sync. Mirrors the module-singleton
// style of lib/ingestJobs.ts: state lives in module scope and persists for the
// life of the single-instance server process — adequate for a self-hosted
// homelab. It is intentionally NOT durable (a restart drops subscribers; clients
// reconnect and re-sync from the snapshot the stream sends on connect).
//
// A "channel" is one profile's view of one map: `${profileId}/${game}/${map}`.
// Each SSE connection subscribes a callback; a PATCH that applies an op
// broadcasts to that channel so the other connected devices receive the delta.

type Subscriber = (msg: SyncStreamMessage) => void;

const channels = new Map<string, Set<Subscriber>>();

export function channelKey(profileId: string, game: string, map: string): string {
  return `${profileId}/${game}/${map}`;
}

export function subscribe(channel: string, fn: Subscriber): void {
  let set = channels.get(channel);
  if (!set) {
    set = new Set();
    channels.set(channel, set);
  }
  set.add(fn);
}

export function unsubscribe(channel: string, fn: Subscriber): void {
  const set = channels.get(channel);
  if (!set) return;
  set.delete(fn);
  if (set.size === 0) channels.delete(channel);
}

export function broadcast(channel: string, msg: SyncStreamMessage): void {
  const set = channels.get(channel);
  if (!set) return;
  for (const fn of set) {
    // A misbehaving subscriber (e.g. an already-closed controller) must not
    // break delivery to the others.
    try {
      fn(msg);
    } catch {
      // ignore — the stream's own cleanup will unsubscribe it
    }
  }
}
