// Shared types for multi-device tracker sync. Imported by both the server route
// handlers and the client (MapTracker), so it must stay free of any server- or
// browser-only imports.
//
// The sync model is operation-based: every user action is a discrete delta
// (add/remove ids on a set, or set a boolean). Clients send ops, the server
// applies them to the canonical per-map state and broadcasts them to the other
// subscribed devices over SSE. Deltas (rather than full-snapshot last-write-wins)
// avoid one device clobbering another's concurrent edit.

// The four meaningful, synced fields. Cosmetic UI state (expanded groups, search,
// lightbox, sidebar drawer) is intentionally NOT synced.
export type SyncField = "checked" | "hidden" | "untracked";

export type SyncOp =
  | { kind: SyncField; action: "add" | "remove"; ids: number[] }
  | { kind: "hideCompleted"; value: boolean };

// A full snapshot of a profile's state for one map. `checked`, `hiddenLocs` and
// `untrackedLocs` are id arrays on the wire (Sets aren't JSON-serializable).
export interface MapStateSnapshot {
  checked: number[];
  hiddenLocs: number[];
  untrackedLocs: number[];
  hideCompleted: boolean;
  rev: number;
}

// Messages pushed over the SSE stream. `snapshot` is sent on every (re)connect so
// a reconnecting client always re-syncs to server truth; `op` carries a single
// applied delta. `originClientId` lets a device ignore the echo of its own op.
export type SyncStreamMessage =
  | { type: "snapshot"; state: MapStateSnapshot }
  | { type: "op"; op: SyncOp; originClientId?: string };

export interface Profile {
  id: string;
  name: string;
  createdAt: number;
}
