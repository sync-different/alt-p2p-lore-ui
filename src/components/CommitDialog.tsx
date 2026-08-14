import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { describeCommit, describeKind } from "../lib/changes";
import type { ChangeEntry, RepoStatus } from "../lib/repo";
import { explainError } from "../lib/auth";

/**
 * Write what is staged.
 *
 * The dialog shows the staged set in full rather than a count, because this is the last
 * moment before something leaves the machine and "12 files" is not something anyone can check.
 * The list is not editable here — staging happens in the panel behind, and a dialog that let
 * you change the set would be a second place to do the same thing, disagreeing with the first.
 */
export function CommitDialog({
  path,
  staged,
  onCommitted,
  onCancel,
}: {
  path: string;
  staged: ChangeEntry[];
  onCommitted: (status: RepoStatus, message: string) => void;
  onCancel: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = async () => {
    setError(null);
    setBusy(true);
    try {
      const status = await invoke<RepoStatus>("commit", { path, message });
      onCommitted(status, message.trim());
    } catch (e) {
      // Whatever lore said. A commit can fail for reasons this dialog cannot anticipate —
      // a lock held by someone else, an expired sign-in — and its own words are the specific
      // ones.
      setError(explainError(String(e)).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="max-h-full w-[34rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">Commit</h2>
        <p className="mt-1 text-ink-2">{describeCommit(staged)}</p>

        <label className="mt-4 block text-[11px] uppercase tracking-wide text-ink-2">Message</label>
        <textarea
          className="h-24 w-full resize-none rounded border border-line bg-surface-2 px-2 py-1 text-ink-0 placeholder:text-ink-2 focus:border-accent focus:outline-none"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="What changed, and why"
          autoFocus
          disabled={busy}
        />

        {/* The whole staged set, not a count: this is the last look before it leaves. */}
        <div className="mt-3 max-h-48 overflow-auto rounded border border-line bg-surface-2">
          <ul>
            {staged.map((c) => (
              <li key={c.path} className="flex gap-2 px-2 py-1">
                <span className="w-14 shrink-0 text-[11px] text-ink-2">{describeKind(c.kind)}</span>
                <span className="selectable min-w-0 flex-1 truncate text-ink-1" title={c.path}>
                  {c.path}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {error && <p className="mt-3 selectable whitespace-pre-wrap text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void commit()}
            disabled={busy || !message.trim() || staged.length === 0}
            className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-50"
          >
            {busy ? "Committing…" : "Commit"}
          </button>
        </div>
      </div>
    </div>
  );
}
