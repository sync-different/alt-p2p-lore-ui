import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toExpiry, type AuthStatus, type Expiry, type ExpiryState } from "../lib/auth";
import type { NoticeLevel } from "../types/app";

/**
 * Sign-in state for the host in front of the user.
 *
 * Read whether or not anything is connected: `lore auth list` reads a local file, so who is
 * signed in and when their token expires are knowable offline. Only *signing in* needs the
 * tunnel, because that contacts the auth service. Gating the whole badge on a live connection
 * hid the answer exactly when someone was most likely to be looking for it.
 *
 * Polled rather than pushed: nothing tells us when a token expires, and the CLI holds the
 * only copy. A minute is frequent enough that the hour-ahead warning is never more than a
 * minute late, and cheap — `lore auth list` reads a local file.
 *
 * The warning fires **on transition**, once per state. A notice every minute for an hour
 * would be ignored by the second one, and the whole point is that this one gets read.
 */

const POLL_MS = 60_000;

export function useAuth(
  /** Where this host's tokens are filed, or null when it needs no sign-in. */
  authUrl: string | null | undefined,
  /** What the workspace in front of the user is pinned to, if anything. */
  pinnedIdentity: string | null | undefined,
  sessionName: string | undefined,
  onEvent?: (level: NoticeLevel, message: string, session?: string) => void,
) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  // What was last announced, so a state is reported once and not once a minute.
  const announced = useRef<ExpiryState | null>(null);
  // Reset the announcement when the session changes: the same state on a different host is
  // different news.
  const watching = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const raw = await invoke<AuthStatus>("auth_status", {
        authUrl: authUrl ?? null,
        identity: pinnedIdentity ?? null,
        nowMs: Date.now(),
      });
      const next: AuthStatus = { ...raw, expiry: toExpiry(raw.expiry) };
      setStatus(next);
      setError(null);
      return next;
    } catch (e) {
      // A failure to *read* sign-in state is not a sign-in problem, and must not be shown
      // as one — it would send someone to re-authenticate for no reason.
      setError(String(e));
      setStatus(null);
      return null;
    } finally {
      setChecking(false);
    }
  }, [authUrl, pinnedIdentity]);

  useEffect(() => {
    if (watching.current !== sessionName) {
      watching.current = sessionName;
      announced.current = null;
    }
    // Read the store even for a host with no identity port.
    //
    // `all` is the whole of `lore auth list` — every identity on this machine — and it is
    // what turns a `u-…` id into a name. Skipping the read while a host without sign-in was
    // selected left every *other* tab showing raw ids, because the only place their names
    // could come from had not been loaded. What stays per-host is membership and expiry;
    // a name is just a label.
    let live = true;
    const tick = async () => {
      const s = await refresh();
      if (!live || !s) return;
      announce(s.expiry);
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUrl, pinnedIdentity, sessionName, refresh]);

  const announce = (e: Expiry) => {
    if (announced.current === e.state) return;
    announced.current = e.state;
    switch (e.state) {
      case "soon":
        onEvent?.(
          "warn",
          `Your sign-in expires in about ${Math.max(1, e.minutes ?? 0)} minutes. Finish and push what is open, or sign in again now.`,
          sessionName,
        );
        break;
      case "expired":
        onEvent?.("error", "Your sign-in has expired. Sign in again to continue.", sessionName);
        break;
      case "unknown":
        onEvent?.(
          "warn",
          "The sign-in expiry could not be read, so it cannot be relied on.",
          sessionName,
        );
        break;
      default:
        // Valid and missing are states, not news. "Signed in" every time a session opens is
        // noise, and it is the badge's job to say so anyway.
        break;
    }
  };

  return { status, error, checking, refresh };
}
