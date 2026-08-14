/**
 * A branch switch that would overwrite unsaved work.
 *
 * lore refuses to do it — "File has local changes: note.txt" — so nothing is at risk by the
 * time this appears. What this adds is asking *before* the attempt rather than reporting a
 * failure after it, and naming exactly which files stand in the way.
 *
 * Only files that differ between the two branches are listed. Uncommitted work in files the
 * branches agree on comes across untouched, which is why this is not a general "you have
 * changes" warning.
 */
export function SwitchBlockedDialog({
  branch,
  files,
  onCommit,
  onDiscard,
  onCancel,
}: {
  branch: string;
  files: string[];
  onCommit: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="max-h-full w-[32rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">Switching to “{branch}” would overwrite your changes</h2>
        <p className="mt-1 text-ink-2">
          {files.length} file{files.length === 1 ? "" : "s"} differ{files.length === 1 ? "s" : ""}{" "}
          between the branches and {files.length === 1 ? "has" : "have"} edits that are not
          committed. Nothing has been changed.
        </p>

        <ul className="mt-3 max-h-40 overflow-auto rounded border border-line bg-surface-2">
          {files.map((f) => (
            <li key={f} className="selectable truncate px-2 py-1 text-ink-1" title={f}>
              {f}
            </li>
          ))}
        </ul>

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2"
          >
            Stay here
          </button>
          {/* Discard is offered but not made easy: it is the one path that loses work, and it
              goes through the same dialog as any other discard so the files are named twice. */}
          <button
            onClick={onDiscard}
            className="rounded border border-warn/40 px-3 py-1 text-warn hover:bg-warn/10"
          >
            Discard those changes…
          </button>
          <button
            onClick={onCommit}
            className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25"
          >
            Commit them first
          </button>
        </div>
      </div>
    </div>
  );
}
