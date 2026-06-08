"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import ProfileSwitcher from "./ProfileSwitcher";
import styles from "./MapIndex.module.css";

export interface MapEntry {
  game: string;
  map: string;
  mapTitle: string;
  markers: number;
}

export interface GameGroup {
  slug: string;
  title: string;
  maps: MapEntry[];
}

interface Stat {
  found: number;
  trackedTotal: number;
  untracked: number;
  pct: number;
}

interface Job {
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
}

function readStat(m: MapEntry): Stat {
  const base = `map-tracker:${m.game}:${m.map}`;
  const parse = (k: string): number[] => {
    try {
      return JSON.parse(window.localStorage.getItem(`${base}:${k}`) ?? "[]");
    } catch {
      return [];
    }
  };
  const checked = parse("checked");
  const untrackedArr = parse("untrackedLocs");
  const untracked = new Set(untrackedArr);
  const trackedTotal = Math.max(0, m.markers - untracked.size);
  const found = checked.filter((id) => !untracked.has(id)).length;
  const pct = trackedTotal > 0 ? Math.round((found / trackedTotal) * 100) : 0;
  return { found, trackedTotal, untracked: untracked.size, pct };
}

// Form + live progress for importing a new map by URL. The scraper runs on the
// server (a background job); we poll its status and refresh the list on success.
function AddMap() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick up an ingest already in flight (e.g. after a page reload).
  useEffect(() => {
    fetch("/api/maps/ingest", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d.job && d.job.status === "running") setJob(d.job);
      })
      .catch(() => {});
  }, []);

  // Poll while running; refresh the map list once the job completes. State
  // updates live in the async timer callback (not the effect body) so they
  // don't trigger synchronous cascading renders.
  useEffect(() => {
    if (!job || job.status !== "running") return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/maps/ingest", { cache: "no-store" });
        const d = await r.json();
        if (!d.job) return;
        setJob(d.job);
        if (d.job.status === "done") {
          router.refresh();
          setUrl("");
        }
      } catch {
        /* transient; keep polling */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [job?.status, job?.id, router]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/maps/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        setError(d.error ?? "Failed to start ingest");
        if (d.job) setJob(d.job);
      } else {
        setJob(d.job);
      }
    } catch {
      setError("Could not reach the server");
    } finally {
      setSubmitting(false);
    }
  }

  const running = job?.status === "running";
  const pct = job && job.total ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <section className={styles.addMap}>
      <form className={styles.addForm} onSubmit={handleSubmit}>
        <input
          className={styles.addInput}
          type="url"
          placeholder="Paste a map URL to import…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={running}
        />
        <button className={styles.addBtn} type="submit" disabled={running || submitting}>
          {running ? "Importing…" : "Add map"}
        </button>
      </form>

      {error && <p className={styles.addError}>{error}</p>}

      {job && job.status !== "error" && (
        <div className={styles.ingest}>
          <div className={styles.ingestLine}>
            <span>
              {job.status === "done"
                ? `Imported ${job.game}/${job.map}`
                : `${job.phase}${job.message ? ` — ${job.message}` : ""}`}
            </span>
            <span className={styles.ingestCount}>
              {job.status === "done" ? "✓" : `${job.done}/${job.total}`}
            </span>
          </div>
          <div className={styles.ingestBar}>
            <div
              className={styles.ingestBarFill}
              style={{ width: `${job.status === "done" ? 100 : pct}%` }}
            />
          </div>
        </div>
      )}
      {job?.status === "error" && (
        <p className={styles.addError}>Import failed: {job.error}</p>
      )}
    </section>
  );
}

export default function MapIndex({ games }: { games: GameGroup[] }) {
  // localStorage is client-only, so progress is read after mount.
  const [stats, setStats] = useState<Record<string, Stat>>({});
  useEffect(() => {
    const s: Record<string, Stat> = {};
    for (const g of games) {
      for (const m of g.maps) s[`${m.game}/${m.map}`] = readStat(m);
    }
    // Intentional post-mount read: localStorage is unavailable during SSR, so
    // progress can only be computed client-side after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStats(s);
  }, [games]);

  return (
    <main className={styles.main}>
      <div className={styles.headerRow}>
        <h1 className={styles.heading}>Map Tracker</h1>
        {/* Pick the device's sync profile here too; it applies to every map. */}
        <div className={styles.profilePicker}>
          <ProfileSwitcher />
        </div>
      </div>

      <AddMap />

      {games.length === 0 ? (
        <p className={styles.empty}>
          No maps yet. Paste a map URL above to import one.
        </p>
      ) : (
        games.map((g) => (
          <section key={g.slug} id={g.slug} className={styles.section}>
            <h2 className={styles.gameTitle}>{g.title}</h2>
            <ul
              className={`${styles.grid} ${g.maps.length === 1 ? styles.gridSingle : ""}`}
            >
              {g.maps.map((m) => {
                const st = stats[`${m.game}/${m.map}`];
                const done = st && st.trackedTotal > 0 && st.found === st.trackedTotal;
                return (
                  <li key={`${m.game}/${m.map}`}>
                    <Link href={`/${m.game}/${m.map}`} className={styles.card}>
                      <div className={styles.cardTop}>
                        <span className={styles.mapTitle}>{m.mapTitle}</span>
                        <span className={styles.markers}>
                          {m.markers.toLocaleString()} markers
                        </span>
                      </div>
                      {st && (
                        <>
                          <div className={styles.progressRow}>
                            <span className={done ? styles.done : undefined}>
                              {st.found} / {st.trackedTotal} found ({st.pct}%)
                            </span>
                            {st.untracked > 0 && (
                              <span className={styles.untrackedNote}>
                                {st.untracked} not tracked
                              </span>
                            )}
                          </div>
                          <div className={styles.bar}>
                            <div
                              className={styles.barFill}
                              style={{ width: `${st.pct}%` }}
                            />
                          </div>
                        </>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </main>
  );
}
