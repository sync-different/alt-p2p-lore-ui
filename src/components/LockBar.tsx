import type { FileLock } from "../lib/repo";
import { holderOf, lockState } from "../lib/locks";

/**
 * Locks for the selected file: who has it, and what you may do about it.
 *
 * The summary on the right stays even when nothing is selected, because "is anything locked"
 * is a question people ask of the repository rather than of a file — and because **not
 * knowing** has to be visible. Offline, `lore` cannot answer at all, and an empty padlock
 * column would read as "nothing is locked", which is the one wrong answer that gets an artist
 * to edit a file a colleague is holding.
 *
 * Releasing our own lock and breaking someone else's are separate buttons that look different,
 * although underneath they are the same command — `lore` applies no ownership check whatsoever.
 * The distinction exists only in this app, so it is drawn where it can be seen.
 */
export function LockBar({
  selected,
  locks,
  available,
  busy,
  onTake,
  onRelease,
  onBreak,
  onRefresh,
}: {
  /** The file the tree has selected, if any. */
  selected: string | null;
  locks: Map<string, FileLock>;
  /** False when the lock list could not be read — offline, most likely. */
  available: boolean;
  busy: boolean;
  onTake: (path: string) => void;
  onRelease: (path: string) => void;
  onBreak: (lock: FileLock) => void;
  onRefresh: () => void;
}) {
  const state = selected ? lockState(selected, locks, available) : "unknown";
  const holder = selected ? holderOf(selected, locks) : null;
  const lock = selected ? locks.get(selected) : undefined;

  return (
    // Wraps rather than truncates. This bar lives in a narrow sidebar, and the first thing a
    // horizontal layout gives up is the end of the longest string — which here is the person's
    // name. "Locked by ui…" is the one rendering that fails at the only job this line has.
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-line px-3 py-1.5">
      {selected && available ? (
        <>
          {state === "free" && (
            <>
              <span className="shrink-0 text-ink-2">Not locked</span>
              <button
                onClick={() => onTake(selected)}
                disabled={busy}
                title="Take the lock so others cannot edit it"
                className="shrink-0 rounded border border-accent/40 px-1.5 py-0.5 text-accent hover:bg-accent/15 disabled:opacity-40"
              >
                Lock
              </button>
            </>
          )}

          {state === "mine" && (
            <>
              <span className="shrink-0 text-ok">Locked by you</span>
              <button
                onClick={() => onRelease(selected)}
                disabled={busy}
                title="Give the lock back"
                className="shrink-0 rounded border border-line px-1.5 py-0.5 text-ink-1 hover:bg-surface-2 disabled:opacity-40"
              >
                Unlock
              </button>
            </>
          )}

          {state === "theirs" && lock && (
            <>
              {/* The holder is named here rather than in a tooltip: it is the answer to
                  "why can't I edit this?", and the remedy is to go and talk to them. The name
                  is never clipped — a half-written name is worse than none, because it looks
                  like a whole one. `break-all` covers a name longer than the sidebar, which
                  wraps rather than disappearing. */}
              <span
                className="min-w-0 break-all text-warn"
                title={lock.since ? `Since ${lock.since}` : undefined}
              >
                Locked by {holder}
              </span>
              <button
                onClick={() => onBreak(lock)}
                disabled={busy}
                title="Take this lock off them — they will not be told"
                className="shrink-0 rounded border border-danger/40 px-1.5 py-0.5 text-danger hover:bg-danger/10 disabled:opacity-40"
              >
                Break lock
              </button>
            </>
          )}
        </>
      ) : (
        <span className="text-ink-2">
          {!available
            ? "Locks unknown — not connected"
            : locks.size === 0
              ? "No files locked"
              : `${locks.size} file${locks.size > 1 ? "s" : ""} locked`}
        </span>
      )}

      {/* The repository-wide count is deliberately *not* repeated beside a selected file. It
          competed for width with the holder's name and lost the wrong one, and the padlocks
          down the tree already answer "is anything else locked" at a glance. */}
      <button
        onClick={onRefresh}
        disabled={busy}
        title={
          selected && available
            ? `Re-read locks — ${locks.size === 0 ? "none held" : `${locks.size} held`} in this repository`
            : "Check who has files locked (needs a connection)"
        }
        className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink-0 disabled:opacity-40"
      >
        🔒
      </button>
    </div>
  );
}
