import { useState } from "react";
import { FileTree } from "./FileTree";
import { ChangesPanel } from "./ChangesPanel";
import { filterPaths } from "../lib/repo";
import type { useRepository } from "../hooks/useRepository";

/**
 * The left column: open a repository, then browse it.
 *
 * The All / Changed toggle switches which source feeds the tree, not merely which rows are
 * hidden — see `useRepository`. The filter matters more than it looks: with every file in
 * the repository reported as changed, the changed view is 2163 rows deep, and typing is
 * the only realistic way to find anything in it.
 */
export function RepoPanel({
  repo,
  onPickFolder,
  onCommit,
  onDiscard,
}: {
  repo: ReturnType<typeof useRepository>;
  onPickFolder: () => void | Promise<void>;
  /** Open the commit dialog for what is currently staged. */
  onCommit: () => void;
  /** Open the discard dialog for these paths. Nothing is discarded without it. */
  onDiscard: (paths: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  // Flat vs nested for the changed view. With 2163 changed files a tree is easier to
  // navigate; with a handful, a flat list shows every path at once and saves the expanding.
  const [flat, setFlat] = useState(false);

  const visible = filter
    ? repo.rows.filter((r) => filterPaths([{ path: r.entry.rel_path }], filter).length > 0)
    : repo.rows;

  // Flattening drops directories and labels each file with its full path — otherwise a
  // list of bare filenames is ambiguous in a tree where "Texture.uasset" occurs 40 times.
  const rows =
    flat && repo.mode === "changed"
      ? visible
          .filter((r) => !r.entry.is_dir)
          .map((r) => ({ ...r, depth: 0, entry: { ...r.entry, name: r.entry.rel_path } }))
      : visible;

  if (!repo.info) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-ink-2">No repository open.</p>
        <button
          onClick={() => void onPickFolder()}
          className="rounded border border-accent/40 bg-accent/15 px-3 py-1.5 text-accent hover:bg-accent/25"
        >
          Open a folder…
        </button>
        {repo.busy && <p className="text-ink-2">Opening…</p>}
        {repo.error && (
          <p className="selectable max-w-64 text-danger">{repo.error}</p>
        )}
      </div>
    );
  }

  const changedCount = repo.info.status.changes.length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Which view, and how many changes there are. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
        <button
          onClick={() => repo.setMode("all")}
          className={`rounded px-2 py-0.5 ${repo.mode === "all" ? "bg-surface-3 text-ink-0" : "text-ink-2 hover:text-ink-1"}`}
        >
          All files
        </button>
        <button
          onClick={() => repo.setMode("changed")}
          className={`rounded px-2 py-0.5 ${repo.mode === "changed" ? "bg-surface-3 text-ink-0" : "text-ink-2 hover:text-ink-1"}`}
        >
          Changed{changedCount > 0 ? ` (${changedCount})` : ""}
        </button>
        <span className="ml-auto" />
        {repo.mode === "changed" && (
          <button
            onClick={() => setFlat((v) => !v)}
            title={flat ? "Show as a tree" : "Show as a flat list"}
            className="rounded px-1.5 py-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink-0"
          >
            {flat ? "⊞" : "☰"}
          </button>
        )}
        <button
          onClick={() => void repo.refreshStatus(true)}
          title="Re-read the repository, including locks"
          className="rounded px-1.5 py-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink-0"
        >
          ↻
        </button>
      </div>

      <div className="shrink-0 border-b border-line px-2 py-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name…"
          className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink-0 placeholder:text-ink-2 focus:border-accent focus:outline-none"
        />
      </div>

      {repo.mode === "changed" && !flat ? (
        // Staging is a different task from browsing: it asks "what am I about to
        // send", which is a boundary between two lists rather than a column in one.
        // The flat toggle still gives a tree view of the same set.
        <ChangesPanel
          changes={repo.info.status.changes}
          busy={repo.staging}
          onStage={(paths) => void repo.stage(paths)}
          onUnstage={(paths) => void repo.unstage(paths)}
    onDiscard={onDiscard}
          onCommit={onCommit}
        />
      ) : (
      <div className="min-h-0 flex-1">
        <FileTree
          rows={rows}
          changes={repo.changes}
          locks={repo.locks}
          selected={repo.selected}
          onSelect={(e) => repo.setSelected(e.rel_path)}
          onToggle={(e) => void repo.toggle(e)}
          empty={
            filter
              ? "Nothing matches that filter."
              : repo.mode === "changed"
                ? "No changes."
                : // Revision 0 means nothing has ever been committed — a repository that was
                  // just created, which is a different thing from a folder that happens to be
                  // empty. Saying "this folder is empty" there reads as a local fault and
                  // sends someone looking for files that were never there.
                  repo.info?.status.revision === 0
                  ? "This repository is empty — nothing has been committed to it yet."
                  : "This folder is empty."
          }
        />
      </div>
      )}

      {/* Lock state is a fact about other people's work, so its absence must be visible.
          "Unknown" is not the same as "none", and only one of them is safe to act on. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-3 py-1.5">
        <span className="text-ink-2">
          {repo.locksAvailable
            ? repo.locks.size === 0
              ? "No files locked"
              : `${repo.locks.size} file${repo.locks.size > 1 ? "s" : ""} locked`
            : "Locks unknown — not connected"}
        </span>
        <button
          onClick={() => void repo.refreshLocks(true)}
          title="Check who has files locked (needs a connection)"
          className="ml-auto rounded px-1.5 py-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink-0"
        >
          🔒
        </button>
      </div>

      {repo.error && (
        <p className="shrink-0 border-t border-line px-3 py-2 text-danger">{repo.error}</p>
      )}
    </div>
  );
}
