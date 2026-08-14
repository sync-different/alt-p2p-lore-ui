import { useState } from "react";
import { renameWorkspace, setWorkspaceIdentity, type WorkspaceSummary } from "../lib/workspaces";
import type { AuthIdentity } from "../lib/auth";

/**
 * What a workspace is, and the two things you can do to it.
 *
 * Mostly a read-out, because almost nothing here is the app's to change: the host and the
 * identity live in `.lore/config.toml` and belong to the repository. Showing them is the
 * point — with two clones of one repository, the identity is the only thing that tells them
 * apart, and it is invisible everywhere else.
 */
export function WorkspaceForm({
  workspace,
  identityName,
  hostName,
  siblings = [],
  known = [],
  onRenamed,
  onRemove,
  onCancel,
}: {
  workspace: WorkspaceSummary;
  identityName: string | null;
  hostName: string | null;
  /** Other workspaces that are clones of the same repository. */
  siblings?: WorkspaceSummary[];
  /** Identities stored on this machine, to choose from. */
  known?: AuthIdentity[];
  onRenamed: (list: WorkspaceSummary[]) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(workspace.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const pin = async (identity: string | null) => {
    setBusy(true);
    setError(null);
    try {
      onRenamed(await setWorkspaceIdentity(workspace.id, identity));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      onRenamed(await renameWorkspace(workspace.id, name.trim() || workspace.name));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const row = "flex gap-2 text-ink-2";
  const val = "selectable min-w-0 flex-1 truncate text-ink-1";

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="max-h-full w-[32rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">Workspace</h2>

        <label className="mt-4 block text-[11px] uppercase tracking-wide text-ink-2">Name</label>
        <input
          className="w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink-0 focus:border-accent focus:outline-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="mt-1 text-[11px] text-ink-2">
          Only the label in this app. Two clones of one repository need names you can tell apart.
        </p>

        <div className="mt-4 space-y-1.5 rounded border border-line bg-surface-2 p-2">
          <div className={row}>
            <span className="w-20 shrink-0">Folder</span>
            <span className={val} title={workspace.path}>{workspace.path}</span>
          </div>
          <div className={row}>
            <span className="w-20 shrink-0">Host</span>
            <span className={val}>
              {hostName ?? "—"}
              {workspace.remote_port != null && (
                <span className="text-ink-2"> · port {workspace.remote_port}</span>
              )}
            </span>
          </div>
          <div className={row}>
            <span className="w-20 shrink-0">Repository</span>
            <span className={val} title={workspace.repository_id ?? undefined}>
              {workspace.repository_id ? (
                <>
                  {workspace.repository_id.slice(0, 12)}…
                  {siblings.length > 0 && (
                    // Not a warning: lore supports several instances of one repository, and
                    // it is what makes two identities possible on one machine.
                    <span className="text-ink-2">
                      {" "}
                      · also cloned as {siblings.map((s) => `“${s.name}”`).join(", ")}
                    </span>
                  )}
                </>
              ) : (
                "—"
              )}
            </span>
          </div>

          <div className={row}>
            <span className="w-20 shrink-0">Acts as</span>
            <span className="min-w-0 flex-1">
              {/* The one setting here that changes behaviour, and the answer to "how do I have
                  a different user per workspace?" — not by signing out, which removes the
                  credential for the whole machine. Both identities stay signed in; each
                  working copy chooses. */}
              <select
                className="w-full rounded border border-line bg-surface-1 px-1.5 py-0.5 text-ink-1 focus:border-accent focus:outline-none"
                value={workspace.identity ?? ""}
                onChange={(e) => void pin(e.target.value || null)}
                disabled={busy}
              >
                <option value="">whoever is signed in</option>
                {known.map((i) => (
                  <option key={i.user_id ?? i.user ?? ""} value={i.user_id ?? ""}>
                    {i.user ?? i.user_id}
                  </option>
                ))}
                {/* Keep a pin to someone not currently signed in, rather than silently
                    dropping it when the list does not contain them. */}
                {workspace.identity && !known.some((i) => i.user_id === workspace.identity) && (
                  <option value={workspace.identity}>
                    {identityName ?? workspace.identity} (not signed in)
                  </option>
                )}
              </select>
              <span className="mt-1 block text-[11px] text-ink-2">
                Stored in this repository&rsquo;s own config, where Lore reads it.
              </span>
            </span>
          </div>
        </div>

        {!workspace.exists && (
          <p className="mt-3 text-danger">This folder is no longer there.</p>
        )}
        {error && <p className="mt-3 selectable text-danger">{error}</p>}

        <div className="mt-5 flex items-center gap-2">
          <button
            onClick={() => (confirming ? onRemove() : setConfirming(true))}
            onBlur={() => setConfirming(false)}
            className={`mr-auto rounded border px-3 py-1 ${
              confirming
                ? "border-danger/60 bg-danger/20 text-danger"
                : "border-danger/40 text-danger hover:bg-danger/10"
            }`}
            title="Remove from this app. The folder on disk is untouched."
          >
            {confirming ? "Click again to remove" : "Remove"}
          </button>
          <button onClick={onCancel} className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={busy}
            className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
