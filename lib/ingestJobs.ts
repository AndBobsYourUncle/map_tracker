import { ingestMap } from "@/lib/ingest";
import { mapsRoot } from "@/lib/paths";

// In-memory registry for UI-triggered ingests. A single ingest runs at a time
// (it's heavy: thousands of tile downloads), so we track one "current" job and
// reject a new request while it's running. State lives in module scope, which
// persists for the life of the single-instance server process — adequate for a
// self-hosted homelab deploy. It is intentionally NOT durable: if the process
// restarts mid-ingest, the partial map stays hidden (no data.json) and can be
// re-run to resume.

export interface JobState {
  id: string;
  url: string;
  status: "running" | "done" | "error";
  phase: string;
  done: number;
  total: number;
  message?: string;
  game?: string;
  map?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

let current: JobState | null = null;

export function getJob(): JobState | null {
  return current;
}

/**
 * Start an ingest in the background. If one is already running, returns the
 * in-flight job with started=false (caller should reject with 409).
 */
export function startIngest(url: string): { job: JobState; started: boolean } {
  if (current && current.status === "running") {
    return { job: current, started: false };
  }

  const job: JobState = {
    id: crypto.randomUUID(),
    url,
    status: "running",
    phase: "page",
    done: 0,
    total: 1,
    startedAt: Date.now(),
  };
  current = job;

  // Fire and forget; progress callbacks mutate `job` in place, and the GET
  // status endpoint reads it.
  ingestMap(url, {
    mapsRoot: mapsRoot(),
    onProgress: (p) => {
      job.phase = p.phase;
      job.done = p.done;
      job.total = p.total;
      job.message = p.message;
    },
  })
    .then((r) => {
      job.status = "done";
      job.game = r.game;
      job.map = r.map;
      job.phase = "write";
      job.done = 1;
      job.total = 1;
      job.message = "done";
      job.finishedAt = Date.now();
    })
    .catch((err: unknown) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
    });

  return { job, started: true };
}
