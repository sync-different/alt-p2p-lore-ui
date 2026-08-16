import { adviseBranch } from "../lib/standing";
import type { RepoStatus } from "../lib/repo";
import { formatBytes, formatElapsed, formatRate } from "../lib/clone";
import type { OperationView } from "../hooks/useOperationProgress";

/**
 * Where this branch stands, and what can be done about it.
 *
 * Shown permanently rather than discovered by pressing something: "Branch has diverged, sync
 * to merge remote changes" is a fine error, but it arrives after a wasted round trip and says
 * only what could have been said beforehand. A button that cannot work is disabled and carries
 * the reason.
 */

const TONE: Record<string, string> = {
  ok: "text-ok",
  info: "text-ink-2",
  warn: "text-warn",
  danger: "text-danger",
};

export function BranchBar({
  status,
  busy = false,
  progress = null,
  stuck = false,
  onSync,
  onPush,
  onResolve,
  onAbort,
}: {
  status: RepoStatus | null;
  busy?: boolean;
  /** Live sync progress while one is in flight, else null. */
  progress?: OperationView | null;
  /** A Sync ran but found nothing to merge — the branch is a merge already ahead of the host,
      lore mislabels it "diverged". Say so and let Push through, just for this case. */
  stuck?: boolean;
  onSync: () => void;
  onPush: () => void;
  /** Take one side for every conflicted file. */
  onResolve: (takeMine: boolean) => void;
  onAbort: () => void;
}) {
  const base = adviseBranch(status);
  // When a sync has proven there is nothing to pull, override the "diverged, sync first" advice:
  // Push is the fix, and lore will fast-forward it (or refuse a genuine divergence itself).
  const advice = stuck
    ? {
        ...base,
        summary: "The host is behind your local merge — Push to publish it.",
        canPush: true,
        canSync: false,
        pushBlockedReason: undefined,
        tone: "info" as const,
      }
    : base;
  const conflicts = status?.conflicts ?? [];

  return (
    <div className="shrink-0 border-t border-line px-3 py-2">
      <div className="flex items-center gap-2">
        {/* Two lines at a smaller size rather than one truncated line: the standing messages
            ("Branch has diverged, sync to merge the host's changes") are full sentences and were
            being cut off mid-word. `line-clamp-2` still caps it so a very long one cannot push
            the buttons around, and the title keeps the whole text on hover. */}
        <span
          className={`min-w-0 flex-1 text-[11px] leading-tight line-clamp-2 ${TONE[advice.tone]}`}
          title={advice.summary}
        >
          {advice.summary}
        </span>

        <button
          onClick={onSync}
          disabled={!advice.canSync || busy}
          title={advice.canSync ? "Bring down the host's work" : "Finish the merge first."}
          className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2 disabled:opacity-40"
        >
          Sync
        </button>
        <button
          onClick={onPush}
          disabled={!advice.canPush || busy}
          // The reason lives on the control that is refused, so it is read at the moment
          // someone reaches for it.
          title={advice.pushBlockedReason ?? "Send your commits to the host"}
          className="rounded border border-accent/40 bg-accent/15 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/25 disabled:opacity-40"
        >
          Push
        </button>
      </div>

      {/* Live progress for whichever repo-level operation is running. These print nothing
          parseable while they work, so without this the button just greys out for minutes — a
          working 12 MB/s sync looked like a crash. No total is knowable (lore reports none), so
          there is no bar or ETA: an honest "moving, this fast, this long" instead of a dishonest
          percentage. Switch and abort re-materialise files, so their bytes climb the same way. */}
      {progress && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-2">
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent"
            aria-hidden
          />
          <span className="text-ink-1">
            {progress.op === "switch"
              ? "Switching branch…"
              : progress.op === "abort"
                ? "Abandoning merge…"
                : progress.op === "resolve"
                  ? "Resolving conflict…"
                  : "Syncing…"}
          </span>
          {progress.received > 0 && (
            <span className="tabular-nums" title="Written so far">
              {formatBytes(progress.received)}
            </span>
          )}
          {progress.rate != null && (
            <span className="tabular-nums">· {formatRate(progress.rate)}</span>
          )}
          {progress.tempFiles > 0 && (
            <span className="tabular-nums" title="Files being written right now">
              · {progress.tempFiles} in flight
            </span>
          )}
          <span className="ml-auto tabular-nums">{formatElapsed(progress.elapsedSeconds)}</span>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="mt-2 rounded border border-danger/40 bg-danger/10 p-2">
          <p className="text-danger">
            {conflicts.length} file{conflicts.length === 1 ? "" : "s"} in conflict. Lore will not
            commit {conflicts.length === 1 ? "it" : "them"} until you choose a side — editing the
            file is not enough.
          </p>
          <ul className="mt-1 max-h-24 overflow-auto">
            {conflicts.map((p) => (
              <li key={p} className="selectable truncate text-ink-1" title={p}>
                {p}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            {/* Both discard the other side for those files, so both say whose work survives. */}
            <button
              onClick={() => onResolve(true)}
              disabled={busy}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2 disabled:opacity-40"
            >
              Keep my version
            </button>
            <button
              onClick={() => onResolve(false)}
              disabled={busy}
              className="rounded border border-line px-2 py-0.5 text-[11px] text-ink-1 hover:bg-surface-2 disabled:opacity-40"
            >
              Take the host's version
            </button>
            <button
              onClick={onAbort}
              disabled={busy}
              className="ml-auto rounded border border-warn/40 px-2 py-0.5 text-[11px] text-warn hover:bg-warn/10 disabled:opacity-40"
              title="Undo the merge and go back to where this working copy was"
            >
              Abandon merge
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
