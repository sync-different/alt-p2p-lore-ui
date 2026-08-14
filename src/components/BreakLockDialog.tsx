import { useState } from "react";
import type { FileLock } from "../lib/repo";
import { describeBreak, displayOwner } from "../lib/locks";

/**
 * Taking a file back off a colleague.
 *
 * `lore` draws no line here: `lock release` on somebody else's lock succeeds, and does not
 * even want `--force`. So the only thing standing between a mis-click and a colleague losing
 * an afternoon's work is this dialog, which is why it names them rather than saying "this
 * file is locked".
 *
 * Deliberately not styled as a routine confirmation. The person holding the lock cannot see
 * this happen and will not be told; they will simply find, later, that a file they were
 * working on moved underneath them.
 */
export function BreakLockDialog({
  locks,
  busy,
  onConfirm,
  onCancel,
}: {
  /** The locks to break — always someone else's; ours never reach here. */
  locks: FileLock[];
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const owners = [...new Set(locks.map(displayOwner))];

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="max-h-full w-[32rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">Break a lock</h2>

        <div className="mt-4 rounded border border-danger/40 bg-danger/10 p-3">
          <p className="text-danger">{describeBreak(locks)}</p>
          <ul className="mt-2 max-h-32 overflow-auto rounded border border-line bg-surface-2">
            {locks.map((l) => (
              <li key={l.path} className="selectable truncate px-2 py-0.5 text-ink-1" title={l.path}>
                {l.path}
                <span className="text-ink-2">
                  {" — "}
                  {displayOwner(l)}
                  {l.since ? `, since ${l.since}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Said plainly because it is the part people assume is not true: there is no
            notification, and no undo beyond taking the lock back again. */}
        <p className="mt-3 text-ink-2">
          {owners.length === 1 ? `${owners[0]} will not be told` : "They will not be told"}, and any
          work {owners.length === 1 ? "they have" : "they have"} in progress stays on their machine.
          Prefer asking first, if you can.
        </p>

        <label className="mt-4 flex items-start gap-2 text-ink-1">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
            disabled={busy}
          />
          <span>I have checked that nobody is working on {locks.length === 1 ? "it" : "these"}</span>
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy || !understood}
            className="rounded border border-danger/60 bg-danger/20 px-3 py-1 text-danger hover:bg-danger/30 disabled:opacity-40"
          >
            {busy ? "Working…" : `Break ${locks.length === 1 ? "the lock" : `${locks.length} locks`}`}
          </button>
        </div>
      </div>
    </div>
  );
}
