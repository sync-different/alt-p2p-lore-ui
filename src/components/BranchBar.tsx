import { adviseBranch } from "../lib/standing";
import type { RepoStatus } from "../lib/repo";

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
  onSync,
  onPush,
  onResolve,
  onAbort,
}: {
  status: RepoStatus | null;
  busy?: boolean;
  onSync: () => void;
  onPush: () => void;
  /** Take one side for every conflicted file. */
  onResolve: (takeMine: boolean) => void;
  onAbort: () => void;
}) {
  const advice = adviseBranch(status);
  const conflicts = status?.conflicts ?? [];

  return (
    <div className="shrink-0 border-t border-line px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`min-w-0 flex-1 truncate ${TONE[advice.tone]}`} title={advice.summary}>
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
