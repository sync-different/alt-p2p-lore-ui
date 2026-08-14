import { useCallback, useEffect, useRef, useState } from "react";
import {
  changeIndex,
  listDir,
  listLocks,
  lockIndex,
  openRepo,
  repoStatus,
  stagePaths,
  unstagePaths,
  type ChangeKind,
  type DirEntry,
  type FileLock,
  type RepoInfo,
  type RepoStatus,
} from "../lib/repo";
import { flattenTree, toggleExpanded, treeFromPaths, type LoadedDirs } from "../lib/tree";
import { rememberRecent, repoName } from "../lib/recents";
import type { NoticeLevel } from "../types/app";
import { explainError } from "../lib/auth";
import { explainUnreachable, type Reach } from "../lib/reachability";

/** Reports what happened, so the Activity pane can show it. Optional so tests need none. */
export type OnEvent = (level: NoticeLevel, message: string) => void;

/**
 * Owns one open repository: its status, its lazily-loaded tree, and the derived rows the
 * list renders.
 *
 * The two views draw from different sources on purpose. **All files** comes from directory
 * listings, expanded on demand — the repository has 1988 directories and walking them all
 * to show one level would defeat the point. **Changed files** is built from the paths in
 * `lore status`, because the changed set spans the whole tree and reading it from disk
 * would mean the very walk laziness exists to avoid.
 */

export type TreeMode = "all" | "changed";

export function useRepository(onEvent?: OnEvent) {
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState<TreeMode>("all");
  const [loaded, setLoaded] = useState<LoadedDirs>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [locks, setLocks] = useState<Map<string, FileLock>>(new Map());
  /**
   * How the open repository is reachable, supplied by the caller.
   *
   * Held in a ref so that a change in connection state does not re-create every callback in
   * this hook — and so an error handler always reads the *current* answer rather than the
   * one captured when it was defined.
   */
  const reachRef = useRef<Reach>({ state: "unknown" });
  /** Who lore is acting as, for the difference between "expired" and "no grant". */
  const signedInAsRef = useRef<string | null>(null);
  /** Who this repository is pinned to act as, named where possible. */
  const repoIdentityRef = useRef<string | null>(null);
  // Locks need a live session, so being unable to read them is normal and must be shown
  // as "unknown" rather than as "none held" — see refreshLocks.
  const [locksAvailable, setLocksAvailable] = useState(false);
  // Mirrors locksAvailable for the callback's own use: depending on the state value would
  // rebuild refreshLocks on every change and re-subscribe the focus listener with it.
  const locksAvailableRef = useRef(false);

  // Guards results from a repository the user has already navigated away from: an in-flight
  // listing for the previous repo must not land in the new one's tree.
  const generation = useRef(0);
  // refreshStatus needs refreshLocks, which is declared after it; a ref keeps the order
  // legible without hoisting one of them into a less obvious place.
  const refreshLocksRef = useRef<((announce?: boolean) => Promise<void>) | null>(null);

  const changes = changeIndex(info?.status ?? null);

  const open = useCallback(async (path: string) => {
    const gen = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const opened = await openRepo(path);
      if (gen !== generation.current) return;
      setInfo(opened);
      setExpanded(new Set());
      setSelected(null);
      const root = await listDir(path, "");
      if (gen !== generation.current) return;
      setLoaded(new Map([["", root]]));
      rememberRecent(path);
      onEvent?.(
        "success",
        `Opened “${repoName(path)}” at revision ${opened.status.revision ?? "?"} — ` +
          `${opened.status.changes.length} changed file${opened.status.changes.length === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      if (gen === generation.current) {
        // An expired token surfaces as a storage or transport error several layers from the
        // cause; relaying that sends people to check the network instead of their sign-in.
        const { message } = explainError(String(e), signedInAsRef.current, repoIdentityRef.current);
        setError(message);
        setInfo(null);
        setLoaded(new Map());
        onEvent?.("error", message);
      }
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }, []);

  /**
   * Re-read the repository: status *and* every directory currently loaded.
   *
   * Refreshing status alone was not enough, and the gap was invisible in the changed view
   * because that is derived from status. The all-files tree is built from directory
   * listings cached at expansion time, so a file created on disk could never appear —
   * refresh looked like it did nothing, which is exactly what a user reports as "refresh is
   * broken".
   *
   * Only already-loaded directories are re-read, so the cost stays proportional to what is
   * on screen rather than to the repository's 1988 directories.
   */
  const refreshStatus = useCallback(async (announce = false) => {
    if (!info) return;
    const gen = generation.current;
    const path = info.path;

    try {
      const [status, ...listings] = await Promise.all([
        repoStatus(path),
        ...[...loaded.keys()].map(async (rel) => {
          try {
            return [rel, await listDir(path, rel)] as const;
          } catch {
            // A directory removed since it was expanded should not fail the whole refresh;
            // drop it from the tree instead.
            return [rel, null] as const;
          }
        }),
      ]);

      if (gen !== generation.current) return;

      setInfo((prev) => (prev ? { ...prev, status } : prev));
      setLoaded(() => {
        const next: LoadedDirs = new Map();
        for (const [rel, entries] of listings) {
          if (entries) next.set(rel, entries);
        }
        return next;
      });
      // Forget expansion only for directories we tried to re-read and could not find. A
      // blanket rebuild would also wipe expansion in the changed view, where directories
      // are inferred from paths and never loaded — collapsing the user's tree on every
      // refresh for no reason.
      const vanished = new Set(listings.filter(([, e]) => !e).map(([r]) => r));
      if (vanished.size > 0) {
        setExpanded((prev) => {
          const next = new Set(prev);
          for (const rel of vanished) next.delete(rel);
          return next;
        });
      }
    } catch (e) {
      const { message } = explainError(String(e), signedInAsRef.current, repoIdentityRef.current);
      setError(message);
      onEvent?.("error", `Could not re-read the repository: ${message}`);
    }

    // Locks are part of "the state of this repository", so a refresh must include them —
    // otherwise the padlocks on screen describe a moment that has passed.
    void refreshLocksRef.current?.(announce);
  }, [info, loaded, onEvent]);

  /** Expand or collapse, loading children the first time a directory is opened. */
  const toggle = useCallback(
    async (entry: DirEntry) => {
      if (!info || !entry.is_dir) return;
      const rel = entry.rel_path;
      const willExpand = !expanded.has(rel);
      setExpanded((prev) => toggleExpanded(prev, rel));

      if (!willExpand || loaded.has(rel) || mode === "changed") return;

      const gen = generation.current;
      setLoading((prev) => new Set(prev).add(rel));
      try {
        const children = await listDir(info.path, rel);
        if (gen !== generation.current) return;
        setLoaded((prev) => new Map(prev).set(rel, children));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(rel);
          return next;
        });
      }
    },
    [info, expanded, loaded, mode],
  );

  // The changed view is derived, so it is rebuilt whenever status or mode changes rather
  // than being fetched. Status costs 0.06s, so this stays in step with no caching.
  const changedTree = mode === "changed"
    ? treeFromPaths((info?.status.changes ?? []).map((c) => c.path))
    : null;

  const rows = flattenTree(changedTree ?? loaded, expanded, loading);

  // Refresh when the user comes back to the window: they have probably just edited
  // something in another application, which is the whole reason to be looking here.
  useEffect(() => {
    const onFocus = () => void refreshStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshStatus]);

  /**
   * Read every lock on the current branch.
   *
   * Failure sets `locksAvailable = false` rather than an empty map. Reporting "no locks"
   * when we simply could not ask would tell an artist a file is free to edit when a
   * colleague may be holding it — the one wrong answer here that costs someone their work.
   */
  const refreshLocks = useCallback(
    async (announce = false) => {
      const branch = info?.branches.current;
      if (!info || !branch) return;
      const gen = generation.current;
      try {
        const found = await listLocks(info.path, branch);
        if (gen !== generation.current) return;
        setLocks(lockIndex(found));
        const wasUnavailable = !locksAvailableRef.current;
        setLocksAvailable(true);
        locksAvailableRef.current = true;
        // Only speak when asked, or when the answer has changed from "unknown" to known —
        // otherwise every window focus would add a line saying nothing new.
        if (announce || wasUnavailable) {
          onEvent?.(
            "info",
            found.length === 0
              ? "No files are locked."
              : `${found.length} file${found.length === 1 ? " is" : "s are"} locked.`,
          );
        }
      } catch (e) {
        if (gen !== generation.current) return;
        setLocks(new Map());
        const wasAvailable = locksAvailableRef.current;
        setLocksAvailable(false);
        locksAvailableRef.current = false;
        // Warn rather than error: not knowing is an ordinary consequence of being offline,
        // but it must be visible because "unknown" is not "none". Announced on an explicit
        // refresh, or when knowledge is *lost* — repeating it on every focus while offline
        // would bury everything else in the feed.
        if (announce || wasAvailable) {
            // "Disconnected from server" is what lore says when the port it dials is not
            // the port this session forwards. Left as-is it points at the network, while the
            // tunnel is healthy and simply listening elsewhere.
            // Two translations, in order: a port that nothing serves, then a grant the
            // account does not hold. Both are reported by lore as something else.
            const why = explainError(
              explainUnreachable(String(e), reachRef.current),
              signedInAsRef.current,
              repoIdentityRef.current,
            ).message;
            onEvent?.("warn", `Could not check locks — ${why}`);
        }
      }
    },
    [info, onEvent],
  );

  refreshLocksRef.current = refreshLocks;

  const close = useCallback(() => {
    generation.current++;
    setInfo(null);
    setLoaded(new Map());
    setExpanded(new Set());
    setSelected(null);
    setError(null);
    setLocks(new Map());
    setLocksAvailable(false);
    locksAvailableRef.current = false;
  }, []);

  const setReach = useCallback((r: Reach) => {
    reachRef.current = r;
  }, []);

  const setSignedInAs = useCallback((who: string | null) => {
    signedInAsRef.current = who;
  }, []);

  /**
   * Stage or unstage, then adopt the status the command returned.
   *
   * The command re-reads status itself, so this needs no follow-up refresh — one process
   * instead of two, and no window where the list on screen disagrees with what was just done.
   */
  const [staging, setStaging] = useState(false);
  const applyStaging = useCallback(
    async (paths: string[], fn: (path: string, paths: string[]) => Promise<RepoStatus>, verb: string) => {
      if (!info || paths.length === 0) return;
      setStaging(true);
      try {
        const status = await fn(info.path, paths);
        setInfo((prev) => (prev ? { ...prev, status } : prev));
        onEvent?.(
          "info",
          `${verb} ${paths.length} file${paths.length === 1 ? "" : "s"}.`,
        );
      } catch (e) {
        onEvent?.("error", explainError(String(e), signedInAsRef.current, repoIdentityRef.current).message);
      } finally {
        setStaging(false);
      }
    },
    [info, onEvent],
  );

  const stage = useCallback(
    (paths: string[]) => applyStaging(paths, stagePaths, "Staged"),
    [applyStaging],
  );
  const unstage = useCallback(
    (paths: string[]) => applyStaging(paths, unstagePaths, "Unstaged"),
    [applyStaging],
  );

  /** Take a status a command has already read, rather than spending a process re-reading it. */
  const adoptStatus = useCallback((status: RepoStatus) => {
    setInfo((prev) => (prev ? { ...prev, status } : prev));
  }, []);

  const setRepoIdentity = useCallback((who: string | null) => {
    repoIdentityRef.current = who;
  }, []);

  return {
    adoptStatus,
    stage,
    unstage,
    staging,
    setReach,
    setSignedInAs,
    setRepoIdentity,
    info,
    error,
    busy,
    mode,
    setMode,
    rows,
    expanded,
    selected,
    setSelected,
    changes: changes as Map<string, ChangeKind>,
    locks,
    locksAvailable,
    refreshLocks,
    open,
    close,
    toggle,
    refreshStatus,
  };
}
