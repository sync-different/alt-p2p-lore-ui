import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChangeEntry, RepoStatus } from "../lib/repo";
import { explainError } from "../lib/auth";
import { formatBytes, formatElapsed, formatRate } from "../lib/clone";
import { useOperationProgress } from "../hooks/useOperationProgress";

/**
 * Throwing work away — the one action here that cannot be undone.
 *
 * Two operations wear the word "discard" and they are not equivalent, so this dialog refuses
 * to blur them:
 *
 * - a **changed** file is restored from the last commit; the old contents still exist
 * - a **new** file has never been committed, so there is nothing to restore it from. Removing
 *   it means deleting it, and it is gone
 *
 * The second therefore needs its own decision, taken separately and after reading which files
 * it applies to. Everything else about this dialog follows from that: the lists are shown in
 * full, the counts are exact, and the destructive button says "Delete" rather than "OK".
 */
export function DiscardDialog({
  path,
  entries,
  onDone,
  onCancel,
}: {
  path: string;
  /** The selected changes, of both sorts. */
  entries: ChangeEntry[];
  onDone: (status: RepoStatus, summary: string) => void;
  onCancel: () => void;
}) {
  const [alsoDelete, setAlsoDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restoring a deleted file re-materialises it onto disk — potentially gigabytes — so this is a
  // real data operation, not an instant one. The monitor's bytes-on-disk climb is what makes a
  // long restore legible instead of a frozen button (see progress.rs / reset_paths).
  const progress = useOperationProgress(path, "reset");

  // A file lore has never committed is "added"; anything else has a revision to go back to.
  const isNew = (c: ChangeEntry) => c.kind === "added";
  const newFiles = entries.filter(isNew);
  const changed = entries.filter((c) => !isNew(c));

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const paths = alsoDelete ? entries.map((c) => c.path) : changed.map((c) => c.path);
      const status = await invoke<RepoStatus>("reset_paths", { path, paths, purge: alsoDelete });
      const parts = [
        changed.length > 0 && `restored ${changed.length}`,
        alsoDelete && newFiles.length > 0 && `deleted ${newFiles.length}`,
      ].filter(Boolean);
      onDone(status, parts.join(", ") || "nothing to discard");
    } catch (e) {
      setError(explainError(String(e)).message);
    } finally {
      setBusy(false);
    }
  };

  const list = (items: ChangeEntry[]) => (
    <ul className="mt-1 max-h-32 overflow-auto rounded border border-line bg-surface-2">
      {items.map((c) => (
        <li key={c.path} className="selectable truncate px-2 py-0.5 text-ink-1" title={c.path}>
          {c.path}
        </li>
      ))}
    </ul>
  );

  // Nothing would happen: say so rather than offering a button that does nothing.
  const nothingToDo = changed.length === 0 && !alsoDelete;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="max-h-full w-[34rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">Discard changes</h2>

        {changed.length > 0 && (
          <div className="mt-4">
            <p className="text-ink-1">
              {changed.length} file{changed.length === 1 ? "" : "s"} will be restored from the last
              commit.
            </p>
            {list(changed)}
          </div>
        )}

        {newFiles.length > 0 && (
          <div className="mt-4 rounded border border-danger/40 bg-danger/10 p-3">
            <p className="text-danger">
              {newFiles.length} new file{newFiles.length === 1 ? " has" : "s have"} never been
              committed. There is nothing to restore {newFiles.length === 1 ? "it" : "them"} from.
            </p>
            {list(newFiles)}
            <label className="mt-2 flex items-start gap-2 text-ink-1">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={alsoDelete}
                onChange={(e) => setAlsoDelete(e.target.checked)}
                disabled={busy}
              />
              <span>
                Delete {newFiles.length === 1 ? "it" : "them"} from disk
                <span className="mt-0.5 block text-[11px] text-ink-2">
                  This cannot be undone. Leave unticked to keep the file{newFiles.length === 1 ? "" : "s"} and
                  only restore the rest.
                </span>
              </span>
            </label>
          </div>
        )}

        {error && <p className="mt-3 selectable text-danger">{error}</p>}

        {/* Alive-not-hung feedback while it runs. A restore re-materialises files, so bytes climb
            (shown); a pure purge deletes and leaves nothing to count, so it is just the timer. */}
        {busy && (
          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-2">
            <span
              className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
              aria-hidden
            />
            <span className="text-ink-1">Discarding…</span>
            {progress && progress.received > 0 && (
              <span className="tabular-nums" title="Restored so far">
                {formatBytes(progress.received)}
              </span>
            )}
            {progress?.rate != null && (
              <span className="tabular-nums">· {formatRate(progress.rate)}</span>
            )}
            <span className="ml-auto tabular-nums">
              {formatElapsed(progress?.elapsedSeconds ?? 0)}
            </span>
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void run()}
            disabled={busy || nothingToDo}
            className={`rounded border px-3 py-1 disabled:opacity-40 ${
              alsoDelete && newFiles.length > 0
                ? "border-danger/60 bg-danger/20 text-danger hover:bg-danger/30"
                : "border-warn/40 bg-warn/10 text-warn hover:bg-warn/20"
            }`}
          >
            {busy
              ? "Working…"
              : alsoDelete && newFiles.length > 0
                ? `Restore and delete ${newFiles.length}`
                : `Restore ${changed.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
