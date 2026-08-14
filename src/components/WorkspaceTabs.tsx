import type { WorkspaceSummary } from "../lib/workspaces";

/**
 * One tab per working copy — the unit people actually work in.
 *
 * Not one per connection, which is what this used to be. A day of testing established that
 * nothing in lore is per-session: a repository reaches its host over a loopback port, and the
 * identity it acts as lives in its own config. So two clones of one repository, acting as two
 * different people, are two workspaces served by one tunnel — and a tab that meant "session"
 * could not express that.
 *
 * The colour answers "can I work here?", which is a question about the repository, not about
 * the tab you happen to be looking at.
 */

export type WorkspaceHealth = "ready" | "unreachable" | "signed_out" | "missing" | "unknown";

const DOT: Record<WorkspaceHealth, string> = {
  ready: "bg-ok",
  unreachable: "bg-ink-2/50",
  signed_out: "bg-warn",
  missing: "bg-danger",
  unknown: "bg-ink-2/50",
};

const WHY: Record<WorkspaceHealth, string> = {
  ready: "Reachable",
  unreachable: "No connected host is serving this repository's port",
  signed_out: "The identity this repository acts as is not signed in",
  missing: "The folder is gone",
  unknown: "Not known yet",
};

export function WorkspaceTabs({
  workspaces,
  label,
  health,
  identityName,
  activeId,
  onSelect,
  onEdit,
  onAdd,
  onClone,
}: {
  workspaces: WorkspaceSummary[];
  /** What to call it — disambiguated when two clones share a name. */
  label: (w: WorkspaceSummary) => string;
  health: (w: WorkspaceSummary) => WorkspaceHealth;
  /** The identity a workspace acts as, named where the id is known. */
  identityName: (w: WorkspaceSummary) => string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onEdit: (w: WorkspaceSummary) => void;
  /** Add a working copy that already exists on this machine. */
  onAdd: () => void;
  /** Make a new one from a host. */
  onClone: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface-0 px-2">
      {/* Labelled to match the Hosts row above it, so the two strips read as a pair: what you
          can reach, and what you are working in. */}
      <span className="shrink-0 pr-1 text-[11px] uppercase tracking-wide text-ink-2">Repos</span>
      {workspaces.length === 0 && (
        <span className="px-1 py-2 text-ink-2">
          No workspaces yet — clone one from a host, or open a folder you cloned earlier.
        </span>
      )}

      {workspaces.map((w) => {
        const active = w.id === activeId;
        const state = health(w);
        const who = identityName(w);
        return (
          <div
            key={w.id}
            onClick={() => onSelect(w.id)}
            onDoubleClick={() => onEdit(w)}
            className={`group flex cursor-pointer items-center gap-2 border-b-2 px-2.5 py-2 ${
              active
                ? "border-accent bg-surface-1 text-ink-0"
                : "border-transparent text-ink-2 hover:bg-surface-1 hover:text-ink-1"
            }`}
            title={`${w.path}\n${WHY[state]}`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} aria-hidden />
            <span className="max-w-[16rem] truncate">{label(w)}</span>
            {/* The identity is part of what a workspace *is*, so it is on the tab rather than
                hidden in a panel — with two clones of one repository it is the only thing
                that tells them apart. */}
            {who && (
              <span className="shrink-0 rounded bg-surface-2 px-1 text-[11px] text-ink-2">
                {who}
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onEdit(w);
              }}
              aria-label={`Settings for ${w.name}`}
              title="Workspace settings"
              className={`shrink-0 rounded px-1 text-[13px] leading-none text-ink-2 hover:bg-surface-3 hover:text-ink-0 ${
                active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              }`}
            >
              ⚙
            </button>
          </div>
        );
      })}

      {/* Both ways to get work, at the end of the list of work. They were in a "Repo"
          dropdown in the row below, which duplicated this strip and which a tester could not
          find — reasonably, since nothing about a list of repositories suggests that adding
          one happens somewhere else. */}
      <button
        onClick={onClone}
        className="ml-1 shrink-0 rounded border border-accent/40 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/15"
        title="Clone a repository from a host into a new folder"
      >
        + Clone
      </button>
      <button
        onClick={onAdd}
        className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-1 hover:text-ink-0"
        title="Add a working copy already on this machine"
      >
        + Open
      </button>
    </div>
  );
}
