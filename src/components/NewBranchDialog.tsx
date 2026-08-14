import { useState } from "react";

/**
 * Start a branch here.
 *
 * Two things this says that the CLI does not, both learned by watching a branch go missing:
 * creating does **not** switch you to it, and the new branch exists only on this machine until
 * something pushes it. A collaborator looking for it will not find it, and that is not a fault
 * to debug later.
 */
export function NewBranchDialog({
  currentBranch,
  existing,
  onCreate,
  onCancel,
}: {
  currentBranch: string | null;
  existing: string[];
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  // Refused here rather than by lore, so the reason is in the user's words.
  const clash = existing.some((b) => b.toLowerCase() === trimmed.toLowerCase());

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="w-[30rem] rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">New branch</h2>
        <p className="mt-1 text-ink-2">
          Starts at the revision you are on{currentBranch ? ` (${currentBranch})` : ""}.
        </p>

        <input
          className="mt-4 w-full rounded border border-line bg-surface-2 px-2 py-1 font-mono text-ink-0 placeholder:text-ink-2 focus:border-accent focus:outline-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="lighting-pass"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed && !clash) onCreate(trimmed);
          }}
        />

        {clash ? (
          <p className="mt-2 text-danger">There is already a branch called “{trimmed}”.</p>
        ) : (
          <p className="mt-2 text-[11px] text-ink-2">
            You stay on the branch you are on. It exists only on this machine until you push it —
            nobody else can see it before then.
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onCancel} className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2">
            Cancel
          </button>
          <button
            onClick={() => onCreate(trimmed)}
            disabled={!trimmed || clash}
            className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-50"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
