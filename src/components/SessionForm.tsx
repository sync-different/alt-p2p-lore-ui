import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionConfig } from "../lib/sessions";

/**
 * Add or edit a saved session.
 *
 * Written for someone who was handed connection details by whoever runs the host, not for
 * someone who understands them. Every field says what it is for in the user's terms, and
 * the two that are genuinely obscure — the ports — carry the reason they cannot simply be
 * chosen for you.
 *
 * The key is write-only: once stored in the keychain it is never read back into the form,
 * because a password field that helpfully shows you the password is not a secret.
 */

const DEFAULT_LORESERVER_PORT = 41400;

export function SessionForm({
  existing,
  onSaved,
  onDeleted,
  onCancel,
}: {
  existing?: SessionConfig & { hasKey?: boolean };
  onSaved: (s: SessionConfig) => void;
  /** Absent when adding: there is nothing to delete yet. */
  onDeleted?: (s: SessionConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? "");
  const [sessionId, setSessionId] = useState(existing?.session_id ?? "");
  const [server, setServer] = useState(existing?.server ?? "");
  const [psk, setPsk] = useState("");
  const [lorePort, setLorePort] = useState(String(existing?.loreserver_port ?? DEFAULT_LORESERVER_PORT));
  const [identityPort, setIdentityPort] = useState(
    existing?.identity_port != null ? String(existing.identity_port) : "",
  );
  const [allowRelay, setAllowRelay] = useState(existing?.allow_relay ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Two clicks, not a modal-on-a-modal: deleting is reversible only by retyping the details,
  // which is annoying rather than dangerous, so a confirm dialog would be heavier than the
  // mistake it prevents.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const remove = async () => {
    if (!existing) return;
    setError(null);
    setSaving(true);
    try {
      await invoke("delete_session", { id: existing.id });
      onDeleted?.(existing);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Give this session a name you will recognise.");
    if (!sessionId.trim()) return setError("The session name from the host is required.");
    if (!server.trim()) return setError("The coordinator address is required.");
    if (!existing?.hasKey && !psk) return setError("The session key is required to connect.");

    const config: SessionConfig = {
      id: existing?.id ?? `s${Date.now()}`,
      name: name.trim(),
      session_id: sessionId.trim(),
      server: server.trim(),
      loreserver_port: Number(lorePort) || DEFAULT_LORESERVER_PORT,
      identity_port: identityPort.trim() ? Number(identityPort) : null,
      allow_relay: allowRelay,
    };

    setSaving(true);
    try {
      await invoke("save_session", { config, psk: psk || null });
      onSaved(config);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const field = "w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink-0 placeholder:text-ink-2 focus:border-accent focus:outline-none";
  const label = "block text-[11px] uppercase tracking-wide text-ink-2";

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="max-h-full w-[30rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">{existing ? "Edit session" : "Add a session"}</h2>
        <p className="mt-1 text-ink-2">
          Whoever runs the host gives you these details.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>Name</label>
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Studio main" />
          </div>

          <div>
            <label className={label}>Session name from the host</label>
            <input
              className={`${field} font-mono`}
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="lore-studio-main"
            />
          </div>

          <div>
            <label className={label}>Coordinator address</label>
            <input
              className={`${field} font-mono`}
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="coord.example.com:9000"
            />
          </div>

          <div>
            <label className={label}>
              Session key {existing?.hasKey && <span className="text-ok">· saved</span>}
            </label>
            <input
              className={field}
              type="password"
              value={psk}
              onChange={(e) => setPsk(e.target.value)}
              placeholder={existing?.hasKey ? "Leave blank to keep the saved key" : "Shared secret"}
            />
            {/* Said plainly, because a user who knows this will not paste it into chat. */}
            <p className="mt-1 text-[11px] text-ink-2">
              Stored in your keychain, never in a settings file.
            </p>
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className={label}>Local port</label>
              <input className={`${field} font-mono`} value={lorePort} onChange={(e) => setLorePort(e.target.value)} />
              <p className="mt-1 text-[11px] text-ink-2">Any free port on this machine.</p>
            </div>
            <div className="flex-1">
              <label className={label}>Identity port</label>
              <input
                className={`${field} font-mono`}
                value={identityPort}
                onChange={(e) => setIdentityPort(e.target.value)}
                placeholder="9443"
              />
              {/* The one field that cannot be chosen freely, and the reason why. */}
              <p className="mt-1 text-[11px] text-ink-2">
                Must match the host exactly. Blank if it needs no sign-in.
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-ink-1">
            <input type="checkbox" checked={allowRelay} onChange={(e) => setAllowRelay(e.target.checked)} />
            Allow relay if a direct connection is not possible
          </label>
        </div>

        {error && <p className="mt-3 selectable text-danger">{error}</p>}

        <div className="mt-5 flex items-center gap-2">
          {existing && (
            <button
              onClick={() => (confirmingDelete ? void remove() : setConfirmingDelete(true))}
              onBlur={() => setConfirmingDelete(false)}
              disabled={saving}
              className={`mr-auto rounded border px-3 py-1 disabled:opacity-50 ${
                confirmingDelete
                  ? "border-danger/60 bg-danger/20 text-danger"
                  : "border-danger/40 text-danger hover:bg-danger/10"
              }`}
              title="Remove this session from the app. The host is not affected."
            >
              {confirmingDelete ? "Click again to delete" : "Delete"}
            </button>
          )}
          <button onClick={onCancel} className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={saving}
            className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
