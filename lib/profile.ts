// Client-only helper for the device's selected sync profile. The selection is
// sticky per device (localStorage) and global across maps. The sentinel "local"
// means "Local (this device)" — today's localStorage-only behavior, no server
// sync. Any other value is a server profile id.
//
// A tiny window event lets every mounted component (the map sidebar, the home
// index) react to a change without threading a React context through both routes.

export const LOCAL_PROFILE = "local";
const SELECTED_KEY = "map-tracker:selectedProfile";
const CHANGE_EVENT = "map-tracker:profilechange";

export function getSelectedProfile(): string {
  if (typeof window === "undefined") return LOCAL_PROFILE;
  return window.localStorage.getItem(SELECTED_KEY) ?? LOCAL_PROFILE;
}

export function setSelectedProfile(id: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SELECTED_KEY, id);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: id }));
}

// Subscribe to selection changes (from this tab or, via the storage event,
// another tab). Returns an unsubscribe function.
export function onProfileChange(fn: (id: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const local = () => fn(getSelectedProfile());
  const storage = (e: StorageEvent) => {
    if (e.key === SELECTED_KEY) fn(getSelectedProfile());
  };
  window.addEventListener(CHANGE_EVENT, local);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, local);
    window.removeEventListener("storage", storage);
  };
}
