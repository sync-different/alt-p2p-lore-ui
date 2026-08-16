/**
 * The repository data layer: Tauri commands in, view models out.
 *
 * Every *repository* command lives here, so the wire shape (snake_case, from serde) is
 * translated once rather than in each caller.
 *
 * Not an absolute rule, and the comment used to claim it was: dialogs that own a single
 * command — clone, commit, discard, sign-in — call `invoke` directly, and are tested by
 * mocking the module. Stating an invariant the code does not hold is worse than a narrower
 * one, because the next person believes it.
 */

import { invoke } from "@tauri-apps/api/core";

// --- wire types (mirror the Rust structs exactly) --------------------------

export type ChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | { other: string };

export interface ChangeEntry {
  /** Already staged, so part of the next commit. Only the section header says so. */
  staged: boolean;
  kind: ChangeKind;
  path: string;
}

/** Where the local branch stands against the remote, in lore's own words. */
export type BranchStanding =
  | "unknown"
  | "no_remote"
  | "in_sync"
  | "ahead"
  | "behind"
  | "diverged";

export interface RepoStatus {
  repo_id: string | null;
  branch: string | null;
  revision: number | null;
  revision_hash: string | null;
  changes: ChangeEntry[];
  standing: BranchStanding;
  /** A merge is open: `sync` started one and it has not been committed. */
  pending_merge: boolean;
  /** Files lore refuses to commit until resolved. Editing them by hand does not clear this. */
  conflicts: string[];
}

export interface Branches {
  /** Local and remote merged, deduplicated. */
  names: string[];
  current: string | null;
  /** Exists on the host but not on this machine yet. */
  remote_only: string[];
}

export interface RepoInfo {
  path: string;
  status: RepoStatus;
  branches: Branches;
  /** What this working copy acts as, when pinned. `lore` honours it with no flag. */
  identity: string | null;
  /** Where this working copy dials, from `.lore/config.toml`. */
  remote_url: string | null;
  /** The loopback port in that URL — pinned to a port, not to a session. */
  remote_port: number | null;
}

export type DiffLineKind = "context" | "added" | "removed" | "hunk_header" | "file_header";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface FileDiff {
  /** lore reported the file as binary: it changed, but has no lines to show. */
  binary: boolean;
  has_changes: boolean;
  from: string | null;
  to: string | null;
  lines: DiffLine[];
  added: number;
  removed: number;
}

export interface FileLock {
  path: string;
  owner: string;
  /** Present only from `lock status`; `lock query` reports the branch instead. */
  since: string | null;
  /**
   * What this app calls the holder, when it recognises them.
   *
   * `owner` is whatever the host rendered, and it is not stable — one lock has printed as
   * `Alejandro`, `ale` and `u-87c4…`. Prefer this so the name matches the rest of the UI.
   */
  known_as: string | null;
  /**
   * Whether we hold it. `null` means unknown, and is not the same as `false`.
   *
   * Never derived from `owner`, which is a display name that differs between workspaces for
   * one and the same lock. The backend resolves it server-side.
   */
  mine: boolean | null;
}

/** An account this machine has signed in as: the id `--owner` resolves, and what we call it. */
export interface KnownIdentity {
  id: string;
  name: string;
}

/** What a lock call actually did — a batch can be partly refused. */
export interface LockOutcome {
  acquired: string[];
  already_owned: string[];
  released: string[];
  /** Refused because someone else holds them, named. */
  blocked: FileLock[];
}

export interface DirEntry {
  name: string;
  rel_path: string;
  is_dir: boolean;
  size: number;
  modified_ms: number;
  is_binary: boolean;
}

// --- commands --------------------------------------------------------------

export const openRepo = (path: string) => invoke<RepoInfo>("open_repo", { path });
export const repoStatus = (path: string) => invoke<RepoStatus>("repo_status", { path });
export const listDir = (root: string, rel: string) => invoke<DirEntry[]>("list_dir", { root, rel });
export const fileDiff = (path: string, file: string) =>
  invoke<FileDiff>("file_diff", { path, file });
export const isLoreRepo = (path: string) => invoke<boolean>("is_lore_repo", { path });

export const listLocks = (
  path: string,
  branch: string,
  identity?: string | null,
  known: KnownIdentity[] = [],
) => invoke<FileLock[]>("list_locks", { path, branch, identity: identity ?? null, known });
export const acquireLocks = (
  path: string,
  paths: string[],
  identity?: string | null,
  known: KnownIdentity[] = [],
) => invoke<LockOutcome>("acquire_locks", { path, paths, identity: identity ?? null, known });
export const releaseLocks = (path: string, paths: string[], force: boolean) =>
  invoke<LockOutcome>("release_locks", { path, paths, force });

/** Locks keyed by path, for decorating tree rows in one pass. */
export function lockIndex(locks: FileLock[]): Map<string, FileLock> {
  return new Map(locks.map((l) => [l.path, l]));
}

// --- derived views ---------------------------------------------------------

/** Single-letter badge for a change, as a file browser would show it. */
export function changeBadge(kind: ChangeKind): string {
  if (kind === "added") return "A";
  if (kind === "modified") return "M";
  if (kind === "deleted") return "D";
  return typeof kind === "object" && "other" in kind ? kind.other : "?";
}

export function changeLabel(kind: ChangeKind): string {
  if (kind === "added") return "Added";
  if (kind === "modified") return "Modified";
  if (kind === "deleted") return "Deleted";
  return typeof kind === "object" && "other" in kind ? `Change code ${kind.other}` : "Changed";
}

/** Fast lookup of change state by path, for decorating tree rows. */
export function changeIndex(status: RepoStatus | null): Map<string, ChangeKind> {
  const map = new Map<string, ChangeKind>();
  for (const c of status?.changes ?? []) map.set(c.path, c.kind);
  return map;
}

/**
 * Does any changed file live at or below this directory?
 *
 * Used to mark folders whose contents changed. Kept as a prefix test over the change list
 * rather than a walk of the filesystem, because the change set is already in memory and
 * the tree is loaded lazily — a walk would defeat the laziness it is decorating.
 */
export function directoryHasChanges(index: Map<string, ChangeKind>, dirRel: string): boolean {
  if (!dirRel) return index.size > 0;
  const prefix = `${dirRel}/`;
  for (const p of index.keys()) if (p.startsWith(prefix)) return true;
  return false;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // One decimal below 10 keeps "1.4 MB" readable without pretending to precision.
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/**
 * Filter paths by a case-insensitive substring.
 *
 * The changes list can hold 2163 entries — every file in the reference repository — so a
 * filter is not a convenience here, it is the only way to find anything.
 */
export function filterPaths<T extends { path: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((i) => i.path.toLowerCase().includes(q));
}

/** Put paths into the next commit. Returns the status as it now stands. */
export const stagePaths = (path: string, paths: string[]) =>
  invoke<RepoStatus>("stage_paths", { path, paths });

/** Take paths back out of the next commit. Files on disk are untouched. */
export const unstagePaths = (path: string, paths: string[]) =>
  invoke<RepoStatus>("unstage_paths", { path, paths });

export const syncRepo = (path: string) => invoke<RepoStatus>("sync", { path });
export const pushRepo = (path: string) => invoke<RepoStatus>("push", { path });
export const resolveConflicts = (path: string, paths: string[], takeMine: boolean) =>
  invoke<RepoStatus>("resolve_conflicts", { path, paths, takeMine });
export const abortMerge = (path: string) => invoke<RepoStatus>("abort_merge", { path });

/** What a switch would overwrite, without switching. Empty means it would go through. */
export const checkSwitchBranch = (path: string, branch: string) =>
  invoke<string[]>("check_switch_branch", { path, branch });

export const switchBranch = (path: string, branch: string) =>
  invoke<RepoStatus>("switch_branch", { path, branch });

export const createBranch = (path: string, branch: string) =>
  invoke<RepoStatus>("create_branch", { path, branch });
