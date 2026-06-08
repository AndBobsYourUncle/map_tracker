"use client";

import { useEffect, useRef, useState } from "react";
import {
  getSelectedProfile,
  LOCAL_PROFILE,
  onProfileChange,
  setSelectedProfile,
} from "@/lib/profile";
import type { Profile } from "@/lib/syncTypes";
import styles from "./ProfileSwitcher.module.css";

export type SyncStatus = "synced" | "connecting" | "offline";

const NEW_SENTINEL = "__new__";

// Dropdown to pick the device's sync profile: "Local (this device)", any named
// server profile, or "New profile…". Used in the map sidebar and the home index.
// `status` (optional) shows the live SSE connection state for a synced profile;
// the index passes nothing.
export default function ProfileSwitcher({ status }: { status?: SyncStatus | null }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState<string>(LOCAL_PROFILE);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelected(getSelectedProfile());
    return onProfileChange(setSelected);
  }, []);

  // Load the profile list once on mount.
  useEffect(() => {
    let alive = true;
    fetch("/api/profiles")
      .then((r) => r.json())
      .then((d) => {
        if (alive && Array.isArray(d.profiles)) setProfiles(d.profiles);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  function onSelect(value: string) {
    if (value === NEW_SENTINEL) {
      setError(null);
      setNewName("");
      setCreating(true);
      return;
    }
    setSelectedProfile(value);
  }

  async function createProfile() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profiles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed");
      const profile: Profile = await res.json();
      setProfiles((prev) => [...prev, profile]);
      setCreating(false);
      setNewName("");
      setSelectedProfile(profile.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create profile");
    } finally {
      setBusy(false);
    }
  }

  if (creating) {
    return (
      <div className={styles.wrap}>
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          placeholder="Profile name"
          value={newName}
          maxLength={60}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") createProfile();
            if (e.key === "Escape") setCreating(false);
          }}
        />
        <button
          type="button"
          className={styles.btn}
          onClick={createProfile}
          disabled={busy || !newName.trim()}
        >
          Create
        </button>
        <button
          type="button"
          className={styles.btnGhost}
          onClick={() => setCreating(false)}
        >
          Cancel
        </button>
        {error && <span className={styles.error}>{error}</span>}
      </div>
    );
  }

  const syncing = selected !== LOCAL_PROFILE;
  return (
    <div className={styles.wrap}>
      <select
        className={styles.select}
        value={selected}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="Sync profile"
      >
        <option value={LOCAL_PROFILE}>Local (this device)</option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value={NEW_SENTINEL}>New profile…</option>
      </select>
      {syncing && status && (
        <span className={styles.status}>
          <span className={`${styles.dot} ${styles[status]}`} />
          {status === "synced" ? "Synced" : status === "connecting" ? "Reconnecting…" : "Offline"}
        </span>
      )}
    </div>
  );
}
