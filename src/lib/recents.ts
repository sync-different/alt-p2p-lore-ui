/**
 * Recently opened repositories.
 *
 * Kept in localStorage rather than the OS keychain: a folder path is not a secret, and
 * putting it behind a keychain prompt would be friction for no protection. Credentials go
 * elsewhere — see the PSK and token handling in M3.
 */

const KEY = "alt-lore.recent-repos";

/**
 * How many to remember.
 *
 * Small on purpose. This is a shortcut for "the repository I was in yesterday", not a
 * history feature — a long list is slower to scan than the folder picker it replaces.
 */
export const MAX_RECENTS = 8;

export interface Recent {
  path: string;
  /** Epoch millis of the last open, so the list can be most-recent-first. */
  at: number;
}

function read(storage: Storage): Recent[] {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter rather than trust: this is user-writable storage that a previous version may
    // have written in another shape, and a malformed entry must not break the picker.
    return parsed
      .filter((r) => r && typeof r.path === "string" && typeof r.at === "number")
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function loadRecents(storage: Storage = localStorage): Recent[] {
  return read(storage).sort((a, b) => b.at - a.at);
}

/**
 * Record an open, moving an existing entry to the front rather than duplicating it.
 */
export function rememberRecent(path: string, storage: Storage = localStorage, now = Date.now()): Recent[] {
  const existing = read(storage).filter((r) => r.path !== path);
  const next = [{ path, at: now }, ...existing].slice(0, MAX_RECENTS);
  try {
    storage.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or unavailable storage must not stop the repository from opening — this is a
    // convenience, and failing the open over it would be absurd.
  }
  return next;
}

export function forgetRecent(path: string, storage: Storage = localStorage): Recent[] {
  const next = read(storage).filter((r) => r.path !== path);
  try {
    storage.setItem(KEY, JSON.stringify(next));
  } catch {
    // as above
  }
  return next;
}

/** The last path component, which is what the user actually calls the repository. */
export function repoName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** Abbreviate the home directory, as a shell would. */
export function shortenPath(path: string, home?: string): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}
