import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { describePreview, previewToken } from "../lib/jwt";
import type { AuthIdentity } from "../lib/auth";

/**
 * Signing in with a token the host issued.
 *
 * This is the flow a self-hosted identity provider actually uses: the host runs
 * `token issue <user>` and hands over a JWT. There is no browser and no password — the
 * token *is* the credential, which is why this dialog spends its space on telling you what
 * you pasted rather than on collecting fields.
 *
 * The token is sent straight to `lore`, which owns the credential store. This app keeps no
 * copy: a second one would be another place for it to leak from without being the one
 * anything reads.
 */

const TOKEN_TYPES = ["lore", "api-key", "eg1"];

export function SignInDialog({
  sessionName,
  identityPort,
  identities = [],
  canSignIn = true,
  onDone,
  onCancel,
}: {
  sessionName: string;
  /** The tunnel-forwarded identity port; the auth URL must match the host's exactly. */
  identityPort: number;
  /** Already stored for this host. Signing in adds to these rather than replacing them. */
  identities?: AuthIdentity[];
  /**
   * False when nothing is forwarding this identity port. Signing *out* still works — it only
   * edits the local store — which is why it gates one button rather than the dialog.
   */
  canSignIn?: boolean;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [token, setToken] = useState("");
  const [tokenType, setTokenType] = useState("lore");
  const [authUrl, setAuthUrl] = useState(`https://127.0.0.1:${identityPort}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => {
    if (!token.trim()) return null;
    return describePreview(previewToken(token), Date.now());
  }, [token]);

  const signOut = async (i: AuthIdentity) => {
    setError(null);
    setBusy(true);
    try {
      await invoke("auth_logout", { authUrl: i.auth_url, userId: i.user_id });
      onDone(`Signed ${i.user ?? i.user_id} out of “${sessionName}”.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await invoke("auth_login_token", { token, tokenType, authUrl });
      onDone(`Signed in to “${sessionName}”.`);
    } catch (e) {
      // Whatever lore said, unedited: at this point its message is more specific than
      // anything this dialog could infer — a wrong auth URL and a rejected token look
      // identical from here.
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const field =
    "w-full rounded border border-line bg-surface-2 px-2 py-1 text-ink-0 placeholder:text-ink-2 focus:border-accent focus:outline-none";
  const label = "block text-[11px] uppercase tracking-wide text-ink-2";

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/50 p-6">
      <div className="max-h-full w-[34rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">Sign in to “{sessionName}”</h2>
        <p className="mt-1 text-ink-2">
          Whoever runs the host issues you a token with{" "}
          <code className="selectable text-ink-1">token issue &lt;your-name&gt;</code>. Paste it here.
        </p>

        {identities.length > 0 && (
          // Shown because signing in *adds* an identity: `lore` keeps an array per auth URL,
          // and with more than one it decides which to use. Listing them is what makes that
          // visible, and signing one out is the only way to remove the ambiguity.
          <div className="mt-4 rounded border border-line bg-surface-2 p-2">
            <p className={label}>Signed in on this computer</p>
            <ul className="mt-1 space-y-1">
              {identities.map((i) => (
                <li key={i.user_id ?? i.user} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink-1">
                    {i.user ?? i.user_id}
                    <span className="text-ink-2"> · expires {i.expires_raw ?? "unknown"}</span>
                  </span>
                  <button
                    onClick={() => void signOut(i)}
                    disabled={busy}
                    className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-3 hover:text-ink-0 disabled:opacity-50"
                  >
                    Sign out
                  </button>
                </li>
              ))}
            </ul>
            {/* Said next to the button that does it, because the natural reading of "sign
                out" is "sign out of this tab" and it is not. Identities are stored per auth
                URL for the whole machine. To work as two people, keep both signed in and set
                each workspace's “Acts as” — signing out removes the credential everywhere. */}
            <p className="mt-1.5 text-[11px] text-ink-2">
              Shared by every host and workspace on this computer. To use a different user per
              workspace, keep both signed in and set “Acts as” in workspace settings.
            </p>
            {identities.length > 1 && (
              <p className="mt-1 text-[11px] text-ink-2">
                With more than one stored, a workspace that is not pinned lets Lore choose.
              </p>
            )}
          </div>
        )}

        <div className="mt-4 space-y-3">
          <div>
            <label className={label}>Token</label>
            <textarea
              className={`${field} h-28 resize-none font-mono text-[11px]`}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9…"
              spellCheck={false}
              autoFocus
            />
            {preview && (
              // Read locally, before sending: a token pasted from a chat window is as
              // likely to be last week's as this morning's, and the alternative to saying
              // so here is finding out from a failed clone an hour later.
              <p className={`mt-1 text-[11px] ${preview.bad ? "text-warn" : "text-ink-2"}`}>
                {preview.text}
              </p>
            )}
          </div>

          <div className="flex gap-3">
            <div className="w-40">
              <label className={label}>Token type</label>
              <select
                className={field}
                value={tokenType}
                onChange={(e) => setTokenType(e.target.value)}
              >
                {TOKEN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-ink-2">“lore” for a self-hosted host.</p>
            </div>
            <div className="flex-1">
              <label className={label}>Auth URL</label>
              <input
                className={`${field} font-mono`}
                value={authUrl}
                onChange={(e) => setAuthUrl(e.target.value)}
              />
              {/* The field people get wrong. It is not a free choice: `lore` files the token
                  under this exact string and looks it up by it later. */}
              <p className="mt-1 text-[11px] text-ink-2">
                Must match the host’s auth_url exactly.
              </p>
            </div>
          </div>
        </div>

        {!canSignIn && (
          <p className="mt-3 text-warn">
            No connected host is forwarding this identity port, so a new token cannot be
            checked. Signing an identity out still works.
          </p>
        )}
        {error && <p className="mt-3 selectable text-danger">{error}</p>}

        <p className="mt-4 text-[11px] text-ink-2">
          The token is passed to the Lore CLI, which stores it. This app keeps no copy.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded border border-line px-3 py-1 text-ink-1 hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !token.trim() || !canSignIn}
            title={
              canSignIn
                ? undefined
                : "Connect to this host first — signing in contacts its identity service."
            }
            className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
