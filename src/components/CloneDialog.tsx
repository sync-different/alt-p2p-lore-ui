import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type { AuthIdentity } from "../lib/auth";
import {
  cloneSizeEstimate,
  cloneStatus,
  formatBytes,
  formatElapsed,
  formatRate,
  rememberCloneSize,
} from "../lib/clone";

/**
 * Clone a repository into a new working copy.
 *
 * The identity field is the reason this dialog is more than a wrapper for one command: `lore`
 * records the identity a clone was made with into that working copy's config, so the choice
 * made here is what the workspace will act as from then on. It is also how one person keeps
 * two clones of one repository as two different users — the thing that "sign out and back in"
 * cannot do, because identities are stored for the whole machine.
 */

interface RemoteRepo {
  name: string;
  id: string;
}

interface Progress {
  id: string;
  line: string;
  percent?: number | null;
  bytes?: number | null;
  /** The clone's own total, read from the progress bar it draws to its terminal. */
  total_bytes?: number | null;
  files_done?: number | null;
  files_total?: number | null;
  /** True while lore is still discovering files, so the file total is a floor. */
  files_growing?: boolean | null;
  /** How long it took, from the clone's own closing line. */
  seconds?: number | null;
  done?: boolean | null;
  error?: string | null;
}

export interface CloneHost {
  id: string;
  name: string;
  /** Where its repositories live, e.g. `grpc://127.0.0.1:41400` — derived for P2P, given for direct. */
  baseUrl: string;
  /** Where its tokens are filed, deciding which identities apply. Null when it needs none. */
  authUrl: string | null;
}

export function CloneDialog({
  hosts,
  defaultHostId,
  defaultIdentity,
  onCloned,
  onCancel,
}: {
  /**
   * Every connected host.
   *
   * More than one is possible whenever they are genuinely different hosts — two sessions to
   * *one* host cannot both run, because its identity port binds once. Which one to clone from
   * is then a real question, and the answer decides both the repository list and the
   * identities available, so it is asked first rather than guessed from whichever tunnel came
   * back first.
   */
  hosts: CloneHost[];
  defaultHostId?: string | null;
  defaultIdentity?: string | null;
  onCloned: (path: string) => void;
  onCancel: () => void;
}) {
  const [hostId, setHostId] = useState(defaultHostId ?? hosts[0]?.id ?? "");
  const host = hosts.find((h) => h.id === hostId) ?? hosts[0] ?? null;
  /** Identities for *this* host's auth URL — a different host may have a different store. */
  const [identities, setIdentities] = useState<AuthIdentity[]>([]);
  const [repo, setRepo] = useState("");
  /**
   * What the host says this identity may clone.
   *
   * `null` while unknown — which covers both "not asked yet" and "asking failed", and is why
   * the text field stays: a list that cannot be fetched must not become a dead end.
   */
  const [available, setAvailable] = useState<RemoteRepo[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [dest, setDest] = useState("");
  const [identity, setIdentity] = useState(defaultIdentity ?? "");
  const [sharedStore, setSharedStore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [bytes, setBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState<number | null>(null);
  const [files, setFiles] = useState<{ done: number; total: number; growing: boolean } | null>(null);
  const [reported, setReported] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  // Read by the event handler, which outlives the render that started the clone.
  const startedRef = useRef<number | null>(null);
  const destRef = useRef("");
  /**
   * What the clone ended up being.
   *
   * Kept so the dialog can stay open afterwards: closing on success threw away the only
   * summary there was — how big it turned out, how many files, how long it took — at the
   * exact moment someone would look at it. The workspace is added either way; this only
   * decides when the window goes.
   */
  const [result, setResult] = useState<{
    path: string;
    bytes: number;
    files: number | null;
    seconds: number;
  } | null>(null);
  const [now, setNow] = useState(Date.now());

  // A clock, because the useful numbers — rate, elapsed, ETA — change with time and not with
  // events, and a 2 GiB clone can go a minute between lines.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [busy]);

  // One id per dialog, so two clones at once cannot read each other's progress.
  const id = useMemo(() => `c${Math.random().toString(36).slice(2, 10)}`, []);
  const url = `${host?.baseUrl ?? ""}/${repo.trim()}`;

  useEffect(() => {
    const un = listen<Progress>("clone://progress", (e) => {
      if (e.payload.id !== id) return;
      if (e.payload.bytes != null) setBytes(e.payload.bytes);
      if (e.payload.total_bytes != null) setTotalBytes(e.payload.total_bytes);
      if (e.payload.percent != null) setReported(e.payload.percent);
      if (e.payload.done === true) {
        // Built here, from the event: reading component state in the click handler meant
        // reading the values captured before the clone started, which reported zeroes beside
        // a console box showing the real totals.
        setResult({
          path: destRef.current,
          bytes: e.payload.total_bytes ?? e.payload.bytes ?? 0,
          files: e.payload.files_total ?? null,
          seconds: e.payload.seconds ?? (startedRef.current ? (Date.now() - startedRef.current) / 1000 : 0),
        });
      }
      if (e.payload.files_done != null && e.payload.files_total != null) {
        setFiles({
          done: e.payload.files_done,
          total: e.payload.files_total,
          growing: e.payload.files_growing ?? false,
        });
      }
      // Byte samples carry no text; adding a blank line per sample would push the real output
      // out of view.
      if (e.payload.line) setLines((prev) => [...prev.slice(-200), e.payload.line]);
    });
    return () => void un.then((f) => f());
  }, [id]);

  // Asked for on open, and again whenever the identity changes: listing is per-identity, so
  // the same host shows different repositories to different people.
  // Identities are filed per auth URL, so switching host can change who you may act as.
  useEffect(() => {
    if (!host?.authUrl) {
      setIdentities([]);
      return;
    }
    let live = true;
    invoke<{ identities: AuthIdentity[] }>("auth_status", {
      authUrl: host.authUrl,
      identity: null,
      nowMs: Date.now(),
    })
      .then((s) => live && setIdentities(s.identities ?? []))
      .catch(() => live && setIdentities([]));
    return () => {
      live = false;
    };
  }, [host?.authUrl]);

  useEffect(() => {
    if (host == null) return;
    let live = true;
    setListing(true);
    setListError(null);
    setRepo("");
    invoke<RemoteRepo[]>("list_repositories", {
      url: host.baseUrl,
      identity: identity || null,
    })
      .then((list) => {
        if (!live) return;
        setAvailable(list);
        // Choose the only one there is; with several, choosing for the user would be a guess.
        if (list.length === 1) setRepo(list[0].name);
      })
      .catch((e) => live && (setAvailable(null), setListError(String(e))))
      .finally(() => live && setListing(false));
    return () => {
      live = false;
    };
  }, [host?.baseUrl, identity]);

  const pick = async () => {
    const chosen = await openDialog({ directory: true, multiple: false, title: "Clone into…" });
    if (typeof chosen === "string") setDest(chosen);
  };

  const start = async () => {
    setError(null);
    setBusy(true);
    setLines([]);
    setBytes(0);
    setTotalBytes(null);
    setFiles(null);
    setReported(null);
    setStartedAt(Date.now());
    startedRef.current = Date.now();
    destRef.current = dest;
    try {
      const path = await invoke<string>("clone_repo", {
        id,
        url,
        dest,
        identity: identity || null,
        sharedStore,
      });
      // What this repository cost, so a second clone of it can show a real bar. The two-clone
      // workflow is the common case here, which is exactly when the estimate exists.
      // The summary is set by the terminating event; this only ensures a result exists even
      // if that event were missed, so the dialog never closes on a blank.
      setResult((prev) => prev ?? { path, bytes: totalBytes ?? bytes, files: null, seconds: 0 });
      const chosen = available?.find((r) => r.name === repo.trim());
      if (chosen && totalBytes) rememberCloneSize(chosen.id, totalBytes);
      // The workspace appears now; the dialog stays until it is dismissed.
      onCloned(path);
    } catch (e) {
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
      <div className="max-h-full w-[36rem] overflow-auto rounded border border-line bg-surface-1 p-5">
        <h2 className="text-ink-0">Clone a repository</h2>
        <p className="mt-1 text-ink-2">
          A second clone of the same repository is fine — that is how one person works as two
          identities.
        </p>
        {hosts.length === 0 && (
          <p className="mt-3 text-warn">
            No host is connected. Connect one first — cloning reads from it.
          </p>
        )}

        <div className="mt-4 space-y-3">
          {hosts.length > 1 && (
            // Only when there is a choice. One connected host is the common case, and a
            // select with one option is a question nobody needs asked.
            <div>
              <label className={label}>Host</label>
              <select
                className={field}
                value={hostId}
                onChange={(e) => setHostId(e.target.value)}
                disabled={busy}
              >
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} · {h.baseUrl}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-ink-2">
                Decides which repositories are offered, and who you can act as.
              </p>
            </div>
          )}

          <div>
            <label className={label}>Repository</label>
            {available && available.length > 0 ? (
              // A list, so nobody has to know a name — let alone an id. It shows what *this
              // identity* is granted, which is also why an empty list is not an error.
              <select
                className={field}
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                disabled={busy}
              >
                <option value="">Choose a repository…</option>
                {available.map((r) => (
                  <option key={r.id} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={`${field} font-mono`}
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="demo"
                disabled={busy}
              />
            )}
            {/* Typed rather than chosen from a list because listing is unavailable: it needs
                LookupUserPermissions, which this identity provider does not implement.
                Whatever is typed goes into the URL verbatim — the name is what people know,
                and an id works too for anyone who has one. */}
            {listing && <p className="mt-1 text-[11px] text-ink-2">Asking the host…</p>}
            {!listing && available?.length === 0 && (
              // Not an error: the host answered, and the answer is "nothing for you".
              <p className="mt-1 text-[11px] text-warn">
                This identity has no repositories on that host. Ask whoever runs it for access,
                or switch identity above.
              </p>
            )}
            {!listing && listError && (
              // The list is a convenience; losing it must not stop someone who knows the name.
              <p className="mt-1 text-[11px] text-ink-2">
                Could not list repositories, so type the name your host gave you.
              </p>
            )}
            <p className="mt-1 selectable text-[11px] text-ink-2">{url}</p>
          </div>

          <div>
            <label className={label}>Clone into</label>
            <div className="flex gap-2">
              <input
                className={`${field} font-mono`}
                value={dest}
                onChange={(e) => setDest(e.target.value)}
                placeholder="/Users/you/work/demo"
                disabled={busy}
              />
              <button
                onClick={() => void pick()}
                disabled={busy}
                className="shrink-0 rounded border border-line px-2 text-ink-1 hover:bg-surface-2 disabled:opacity-50"
              >
                Choose…
              </button>
            </div>
            <p className="mt-1 text-[11px] text-ink-2">An empty folder, or one that does not exist yet.</p>
          </div>

          <label className="flex items-start gap-2 text-ink-1">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={sharedStore}
              onChange={(e) => setSharedStore(e.target.checked)}
              disabled={busy}
            />
            <span>
              Share storage with other clones on this machine
              {/* Measured, not assumed. Two clones of the same 2 GiB repository, one with the
                  store and one without: 141s vs 138s, and 2064 MB vs 2050 MB on disk. The
                  bulk is the materialised working tree, which every clone writes in full —
                  the store held 12 MB of index. Claiming a speed-up here would be inventing
                  one, and a feature that promises what it cannot deliver gets written off. */}
              <span className="mt-0.5 block text-[11px] text-ink-2">
                Shares the fragment index between clones. Measured on a 2 GB repository it
                saved about 13 MB and no time — the files themselves are written in full every
                time. It may help more on repositories with a large local cache.
              </span>
            </span>
          </label>

          <div>
            <label className={label}>Act as</label>
            <select
              className={field}
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              disabled={busy}
            >
              <option value="">whoever is signed in</option>
              {identities.map((i) => (
                <option key={i.user_id ?? ""} value={i.user_id ?? ""}>
                  {i.user ?? i.user_id}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-ink-2">
              Recorded in the new working copy, so this clone keeps acting as them.
            </p>
          </div>
        </div>

        {result && (
          <div className="mt-4 rounded border border-ok/40 bg-ok/10 p-3">
            <p className="text-ok">Cloned {repo.trim()}</p>
            <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-1">
              <span>{formatBytes(result.bytes)}</span>
              {result.files != null && <span>{result.files} files</span>}
              <span>in {formatElapsed(result.seconds)}</span>
              {result.seconds > 1 && <span>{formatRate(result.bytes / result.seconds)} average</span>}
            </p>
            <p className="selectable mt-1 break-all text-[11px] text-ink-2">{result.path}</p>
            <p className="mt-1 text-[11px] text-ink-2">
              It is open as a workspace{identity ? ", acting as the identity you chose" : ""}.
            </p>
          </div>
        )}

        {busy && startedAt != null && !result && (() => {
          const chosen = available?.find((r) => r.name === repo.trim());
          const status = cloneStatus({
            bytes,
            startedAt,
            now,
            reportedPercent: reported,
            // The clone's own total when it has told us one; the remembered size of a
            // previous clone only until then.
            estimateBytes: totalBytes ?? (chosen ? cloneSizeEstimate(chosen.id) : null),
            totalKnown: totalBytes != null,
          });
          return (
            <div className="mt-4">
              <div className="h-1.5 w-full overflow-hidden rounded bg-surface-2">
                {status.percent != null ? (
                  <div
                    className="h-full bg-accent transition-[width] duration-500"
                    style={{ width: `${status.percent}%` }}
                  />
                ) : (
                  // Indeterminate on purpose: without a total, a bar that fills would be
                  // inventing progress. This says "working" and the numbers say how fast.
                  <div className="h-full w-1/3 animate-pulse bg-accent/60" />
                )}
              </div>
              <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-ink-2">
                {status.percent != null && (
                  <span className="text-ink-1">
                    {Math.round(status.percent)}%{status.estimated ? " (estimated)" : ""}
                  </span>
                )}
                <span>
                  {formatBytes(status.bytes)}
                  {totalBytes != null && ` of ${formatBytes(totalBytes)}`} copied
                </span>
                {files && (
                  <span>
                    {files.done}/{files.total}
                    {files.growing && "+"} files
                  </span>
                )}
                {status.rate != null && <span>{formatRate(status.rate)}</span>}
                <span>{formatElapsed(status.elapsedSeconds)} elapsed</span>
                {status.eta != null && status.eta > 1 && (
                  <span>about {formatElapsed(status.eta)} left</span>
                )}
              </p>
              {status.percent == null && (
                <p className="mt-1 text-[11px] text-ink-2">Starting…</p>
              )}
            </div>
          );
        })()}

        {lines.length > 0 && (
          // The CLI's own output, unedited: a clone can take minutes, and silence is
          // indistinguishable from a hang.
          <pre className="selectable mt-4 max-h-40 overflow-auto rounded border border-line bg-surface-0 p-2 text-[11px] text-ink-2">
            {lines.slice(-12).join("\n")}
          </pre>
        )}

        {error && <p className="mt-3 selectable whitespace-pre-wrap text-danger">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className={`rounded border px-3 py-1 disabled:opacity-50 ${
              result
                ? "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25"
                : "border-line text-ink-1 hover:bg-surface-2"
            }`}
          >
            {busy ? "Cloning…" : result ? "Done" : "Cancel"}
          </button>
          {!result && (
            <button
              onClick={() => void start()}
              disabled={busy || !repo.trim() || !dest.trim() || !host}
              className="rounded border border-accent/40 bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25 disabled:opacity-50"
            >
              {busy ? "Cloning…" : "Clone"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
