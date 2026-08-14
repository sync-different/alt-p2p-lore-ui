import { badgeLabel, expiryTone, needsSignIn, type AuthStatus } from "../lib/auth";

/**
 * Sign-in state for the active session, in the toolbar beside the connection actions.
 *
 * Placed there deliberately: an expiring token stops the same work a dropped connection
 * stops, and someone about to start a long push should meet both facts in the same glance.
 */

/** Text colour only — a filled, bordered chip beside two buttons reads as a third one. */
const TONE: Record<string, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  idle: "text-ink-2",
};

const DOT: Record<string, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  idle: "bg-ink-2/50",
};

export function AuthBadge({
  status,
  error,
  /**
   * Whether a *sign-in* can happen: something must be forwarding this identity port, by
   * whichever host. Reading the state needs nothing, and signing out is local — so this
   * gates one button, not the badge.
   */
  connected = false,
  identityPort,
  pinnedIdentity,
  hostName,
  onSignIn,
  onConfigure,
}: {
  status: AuthStatus | null;
  error?: string | null;
  /** Sign-in state is only meaningful once the host is reachable. */
  connected?: boolean;
  /** Null when this session has no identity port set. */
  identityPort?: number | null;
  /** The identity the active workspace acts as, when it is pinned to one. */
  pinnedIdentity?: string | null;
  /**
   * Which host this describes, when that is not obvious.
   *
   * Sign-in is per auth URL and so per host. With one host connected the answer is unambiguous
   * and naming it is noise; with several it is the difference between a true statement and a
   * misleading one, because the badge is about *a* store and the user cannot tell which.
   */
  hostName?: string | null;
  onSignIn?: () => void;
  onConfigure?: () => void;
}) {
  // A session with no identity port cannot sign in to anything. Saying so is better than
  // showing nothing — an empty toolbar reads as a broken feature, and this is the one place
  // someone would look to find out that the port is missing.
  if (identityPort == null) {
    return (
      <button
        onClick={onConfigure}
        className={`flex items-center gap-1.5 text-[11px] ${TONE.idle} hover:text-ink-0`}
        title={
          "This session has no identity port set, so it cannot sign in.\n" +
          "If the host requires signing in, add its identity port in session settings — " +
          "it must match the port in the host's auth_url exactly."
        }
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT.idle}`} aria-hidden />
        No sign-in configured
      </button>
    );
  }

  if (!status && !error) return null;

  if (error) {
    // Failing to *read* the state is its own thing, and must not read as "signed out" —
    // that would send someone to re-authenticate over a local fault.
    return (
      <span className={`flex items-center gap-1.5 text-[11px] ${TONE.warn}`} title={error}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT.warn}`} aria-hidden />
        Sign-in state unavailable
      </span>
    );
  }

  const expiry = status!.expiry;
  const tone = expiryTone(expiry);
  const identities = status!.identities ?? [];
  // Every identity's exact expiry, since the label can only carry the soonest.
  const raw = identities
    .map((i) => `${i.user ?? i.user_id ?? "?"} — expires ${i.expires_raw ?? "unknown"}`)
    .join("\n");

  return (
    <span className="flex items-center gap-1.5">
      {/* Clickable in every state, not only when a sign-in is overdue: renewing early and
          switching to a different user are both things people do while a token still works,
          and a control that appears only on expiry cannot be used to avoid one. */}
      <button
        onClick={onSignIn}
        className={`flex items-center gap-1.5 text-[11px] hover:underline ${TONE[tone]}`}
        // The exact time under the hover, so the rounded label never has to be trusted for
        // a decision that turns on minutes.
        title={[
          identities[0]?.auth_url,
          raw,
          pinnedIdentity
            ? "This workspace is pinned to one identity, so this is its clock — other stored identities may differ."
            : identities.length > 1
              ? "More than one identity is stored for this host. Lore chooses which to use; pin a workspace with “Acts as” to make it definite."
              : null,
          connected
            ? "Click to sign in, or to sign an identity out."
            : "Click to sign an identity out. Signing in needs a connection to the host.",
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden />
        {hostName && <span className="text-ink-2">{hostName} · </span>}
        {badgeLabel(identities, expiry, pinnedIdentity)}
      </button>
      {needsSignIn(expiry) && onSignIn && (
        <button
          onClick={onSignIn}
          disabled={!connected}
          title={connected ? "Sign in with a token from your host" : "Connect to the host first — signing in contacts its identity service"}
          className="rounded border border-accent/40 bg-accent/15 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Sign in
        </button>
      )}
    </span>
  );
}
