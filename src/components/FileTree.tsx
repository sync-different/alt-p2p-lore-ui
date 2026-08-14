import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { changeBadge, changeLabel, type ChangeKind, type FileLock } from "../lib/repo";
import type { VisibleRow } from "../lib/tree";
import type { DirEntry } from "../lib/repo";

/**
 * The file tree.
 *
 * Virtualized because the reference repository has 2162 files and *all* of them show as
 * changed — so the changed view is not a short list, it is the whole tree. Rendering that
 * as DOM makes scrolling unusable, and it is the default case rather than a pathological
 * one.
 *
 * Rows are a fixed height so the virtualizer needs no measurement pass, which is what keeps
 * scrolling smooth while children arrive asynchronously.
 */

const ROW_HEIGHT = 22;

const BADGE_COLOUR: Record<string, string> = {
  A: "text-ok",
  M: "text-warn",
  D: "text-danger",
};

function RowContent({
  row,
  change,
  lock,
  selected,
  onSelect,
  onToggle,
}: {
  row: VisibleRow;
  change: ChangeKind | undefined;
  lock: FileLock | undefined;
  selected: boolean;
  onSelect: (e: DirEntry) => void;
  onToggle: (e: DirEntry) => void;
}) {
  const { entry, depth, expanded, loading } = row;
  const badge = change ? changeBadge(change) : null;

  return (
    <button
      onClick={() => (entry.is_dir ? onToggle(entry) : onSelect(entry))}
      title={entry.rel_path}
      className={`flex h-[22px] w-full items-center gap-1 pr-2 text-left ${
        selected ? "bg-accent/20 text-ink-0" : "text-ink-1 hover:bg-surface-2"
      }`}
      // Indent by depth. Padding rather than nested elements keeps every row a sibling,
      // which is what lets the list be windowed at all.
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span className="w-3 shrink-0 text-center text-ink-2">
        {entry.is_dir ? (loading ? "·" : expanded ? "▾" : "▸") : ""}
      </span>

      <span className={`shrink-0 ${entry.is_dir ? "text-accent/70" : "text-ink-2"}`}>
        {entry.is_dir ? "▉" : entry.is_binary ? "◆" : "○"}
      </span>

      <span className="truncate">{entry.name}</span>

      {/* Who holds this file. For an artist working on binary assets that cannot be
          merged, this is often the most important thing on the row — so it sits next to
          the name rather than after the change badge. */}
      {lock && (
        <span
          className="shrink-0 text-warn"
          title={`Locked by ${lock.owner}${lock.since ? ` since ${lock.since}` : ""}`}
        >
          🔒
        </span>
      )}

      {badge && (
        <span
          className={`ml-auto shrink-0 font-mono text-[11px] ${BADGE_COLOUR[badge] ?? "text-ink-2"}`}
          title={changeLabel(change!)}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export function FileTree({
  rows,
  changes,
  locks,
  selected,
  onSelect,
  onToggle,
  empty,
}: {
  rows: VisibleRow[];
  changes: Map<string, ChangeKind>;
  locks?: Map<string, FileLock>;
  selected: string | null;
  onSelect: (e: DirEntry) => void;
  onToggle: (e: DirEntry) => void;
  empty: string;
}) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  if (rows.length === 0) {
    return <p className="px-3 py-3 text-ink-2">{empty}</p>;
  }

  return (
    <div ref={parentRef} className="h-full overflow-auto" data-testid="file-tree">
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          return (
            <div
              key={row.entry.rel_path}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              <RowContent
                row={row}
                change={changes.get(row.entry.rel_path)}
                lock={locks?.get(row.entry.rel_path)}
                selected={selected === row.entry.rel_path}
                onSelect={onSelect}
                onToggle={onToggle}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
