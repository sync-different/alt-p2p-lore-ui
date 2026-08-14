import { useState } from "react";
import { describeCommit, describeKind, groupChanges, toggleAll, toggleSelected } from "../lib/changes";
import type { ChangeEntry } from "../lib/repo";

/**
 * What has changed, and what the next commit will contain.
 *
 * A separate view from the file tree because it is a different task: browsing asks "what is
 * in this repository", staging asks "what am I about to send". The tree answers the first
 * well and would answer the second badly — a checkbox on every row of 2,157 files, most of
 * which are irrelevant.
 *
 * Staged and unstaged are shown apart rather than as one list with a flag, because the
 * question a person actually has is "what will this commit include", and that is a boundary,
 * not a column.
 */

const KIND_COLOUR: Record<string, string> = {
  added: "text-ok",
  changed: "text-warn",
  deleted: "text-danger",
  moved: "text-ink-1",
};

function Group({
  title,
  entries,
  selected,
  onToggle,
  onToggleAll,
  action,
  actionLabel,
  secondaryAction,
  secondaryLabel,
  busy,
  empty,
}: {
  title: string;
  entries: ChangeEntry[];
  selected: Set<string>;
  onToggle: (path: string) => void;
  onToggleAll: (paths: string[]) => void;
  action: (paths: string[]) => void;
  actionLabel: string;
  /** Discarding, offered only where there is something to discard. */
  secondaryAction?: (paths: string[]) => void;
  secondaryLabel?: string;
  busy: boolean;
  empty: string;
}) {
  const paths = entries.map((e) => e.path);
  const chosen = paths.filter((p) => selected.has(p));
  const allSelected = paths.length > 0 && chosen.length === paths.length;

  return (
    <div className="min-h-0 flex-1 overflow-auto border-b border-line last:border-b-0">
      <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-surface-1 px-2 py-1.5">
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => onToggleAll(paths)}
          disabled={paths.length === 0 || busy}
          aria-label={`Select all ${title.toLowerCase()}`}
        />
        <span className="text-[11px] uppercase tracking-wide text-ink-2">
          {title} {entries.length > 0 && `(${entries.length})`}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {secondaryAction && (
            <button
              onClick={() => secondaryAction(chosen)}
              disabled={chosen.length === 0 || busy}
              className="rounded border border-warn/40 px-2 py-0.5 text-[11px] text-warn hover:bg-warn/10 disabled:opacity-40"
            >
              {secondaryLabel}
              {chosen.length > 0 && ` (${chosen.length})`}
            </button>
          )}
          <button
            onClick={() => action(chosen)}
            disabled={chosen.length === 0 || busy}
            className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2 disabled:opacity-40"
          >
            {actionLabel}
            {chosen.length > 0 && ` (${chosen.length})`}
          </button>
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="px-3 py-2 text-ink-2">{empty}</p>
      ) : (
        <ul>
          {entries.map((e) => (
            <li key={e.path} className="flex items-center gap-2 px-2 py-1 hover:bg-surface-1">
              <input
                type="checkbox"
                checked={selected.has(e.path)}
                onChange={() => onToggle(e.path)}
                disabled={busy}
                aria-label={e.path}
              />
              <span className={`w-14 shrink-0 text-[11px] ${KIND_COLOUR[describeKind(e.kind)] ?? "text-ink-2"}`}>
                {describeKind(e.kind)}
              </span>
              <span className="selectable min-w-0 flex-1 truncate text-ink-1" title={e.path}>
                {e.path}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ChangesPanel({
  changes,
  busy = false,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
}: {
  changes: ChangeEntry[];
  busy?: boolean;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  /** Opens the discard dialog for these paths — it does not discard on its own. */
  onDiscard: (paths: string[]) => void;
  onCommit: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { staged, unstaged } = groupChanges(changes);

  const act = (fn: (paths: string[]) => void) => (paths: string[]) => {
    fn(paths);
    // The paths acted on move to the other group; keeping them ticked would carry a selection
    // across a boundary the user just pushed them over.
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.delete(p);
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Group
        title="Staged"
        entries={staged}
        selected={selected}
        onToggle={(p) => setSelected((s) => toggleSelected(s, p))}
        onToggleAll={(paths) => setSelected((s) => toggleAll(s, paths))}
        action={act(onUnstage)}
        actionLabel="Unstage"
        busy={busy}
        empty="Nothing staged yet."
      />
      <Group
        title="Not staged"
        entries={unstaged}
        selected={selected}
        onToggle={(p) => setSelected((s) => toggleSelected(s, p))}
        onToggleAll={(paths) => setSelected((s) => toggleAll(s, paths))}
        action={act(onStage)}
        actionLabel="Stage"
        secondaryAction={onDiscard}
        secondaryLabel="Discard…"
        busy={busy}
        empty="No other changes."
      />

      <div className="flex shrink-0 items-center gap-2 border-t border-line px-2 py-2">
        {/* What a commit would write — counted from what is staged, never from what is
            ticked. The two differ constantly, and only one of them is a commit. */}
        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-2">
          {describeCommit(staged)}
        </span>
        <button
          onClick={onCommit}
          disabled={staged.length === 0 || busy}
          className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-40"
        >
          Commit…
        </button>
      </div>
    </div>
  );
}
