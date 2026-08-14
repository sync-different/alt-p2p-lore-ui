/**
 * Sign-in state for a session, as the UI talks about it.
 *
 * The point of this milestone is the *warning*, not the display: identity tokens last 12
 * hours and running out mid-work has cost real interruptions. So the vocabulary here is
 * built around how much time is left, and the one rule it must never break is that an
 * expiry we could not read is never shown as fine.
 */

export type ExpiryState = "missing" | "valid" | "soon" | "expired" | "unknown";

export interface Expiry {
  state: ExpiryState;
  /** Minutes remaining (valid/soon) or minutes since expiry (expired). */
  minutes?: number;
}

export interface AuthIdentity {
  auth_url: string;
  resource: string | null;
  user: string | null;
  user_id: string | null;
  domains: string[];
  expires_raw: string | null;
  expires_ms: number | null;
}

export interface AuthStatus {
  /**
   * Every identity filed under this session's auth URL.
   *
   * More than one is normal: `lore` stores `[[remotes.token]]` as an array, so signing in as
   * a second user *adds* an identity instead of replacing the first.
   */
  identities: AuthIdentity[];
  /** The soonest expiry among them — we cannot know which `lore` will use. */
  expiry: Expiry;
  all: AuthIdentity[];
}

/** How to name the account(s) in the badge. */
export function whoLabel(identities: AuthIdentity[]): string | undefined {
  const names = identities.map((i) => i.user ?? i.user_id ?? "unknown");
  if (names.length === 0) return undefined;
  if (names.length === 1) return names[0];
  // Ambiguity stated rather than hidden. Which identity `lore` picks for an operation is its
  // decision, so naming one of them would be a guess presented as fact — and the guess is
  // exactly what makes a later permission error impossible to explain.
  return `${names.join(", ")} (${names.length} identities)`;
}

/** Serde's `tag`/`content` shape arrives as `{state, minutes}` — unit variants omit minutes. */
export function toExpiry(raw: unknown): Expiry {
  if (raw && typeof raw === "object" && "state" in raw) {
    const r = raw as { state: ExpiryState; minutes?: number };
    return { state: r.state, minutes: r.minutes };
  }
  return { state: "unknown" };
}

/** Rounded to the unit a person would use, never to zero while time remains. */
export function humanDuration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * @param user who the token belongs to. Named in the label rather than hidden in a tooltip:
 * with several sessions open, *which account* is signed in is as much a part of the state as
 * how long it lasts — and it is the thing that explains a permission error.
 */
export function expiryLabel(e: Expiry, user?: string | null): string {
  const who = user ? `Signed in as ${user}` : "Signed in";
  switch (e.state) {
    case "missing":
      return "Not signed in";
    case "valid":
      return `${who} · ${humanDuration(e.minutes ?? 0)} left`;
    case "soon":
      return `${who} · expires in ${humanDuration(e.minutes ?? 0)}`;
    case "expired":
      return `Expired ${humanDuration(e.minutes ?? 0)} ago`;
    case "unknown":
      // Said out loud rather than smoothed over: this is the state where the app cannot
      // vouch for anything, and pretending otherwise is how someone starts a long push
      // against a dead token.
      return "Sign-in state unknown";
  }
}

/** The shared colour vocabulary: green connected, yellow warning, red error, grey idle. */
export function expiryTone(e: Expiry): "ok" | "warn" | "danger" | "idle" {
  switch (e.state) {
    case "valid":
      return "ok";
    case "soon":
      return "warn";
    case "expired":
      return "danger";
    case "unknown":
      return "warn";
    case "missing":
      return "idle";
  }
}

/** Does this state call for a sign-in before starting work? */
export function needsSignIn(e: Expiry): boolean {
  return e.state === "expired" || e.state === "missing";
}

/**
 * Turn a failure into something a person can act on.
 *
 * lore reports an expired token several layers from the cause — as a storage error, or as
 * "authentication requires a configured auth endpoint". Relayed verbatim it sends people to
 * check the network, the tunnel and the repository: every place except the one that is
 * wrong. The raw text is kept, not discarded, and belongs under Details.
 */
/**
 * Two failures that look alike and need opposite remedies.
 *
 * *Who you are* has stopped working — the token expired, or none is stored. Sign in again.
 *
 * *What you may do* — you are signed in perfectly well, as an account with no grant for this
 * repository. Observed live: uitest, freshly issued and valid for twelve hours, gets
 * "Not authorized to access repository". Telling that user to sign in again would send them
 * round a loop that cannot help; what they need is for the host to grant them the repository.
 */
const IDENTITY_SIGNS = [
  "unauthenticated",
  "token expired",
  "token has expired",
  "expired token",
  "authentication required",
  "requires a configured auth endpoint",
  "not authenticated",
  "401",
];

/**
 * Someone else is holding the file.
 *
 * Not a permission problem and not a sign-in problem: the account is fine, the operation is
 * fine, and another person is working on that file. The only useful response names them, and
 * neither signing in again nor asking for a grant would change anything.
 */
const LOCK_SIGNS = ["locked by", "is locked", "lock held", "file is locked"];

const PERMISSION_SIGNS = [
  "not authorized",
  "not authorised",
  "unauthorized",
  "unauthorised",
  "permission denied",
  "403",
];

export function looksLikeAuthFailure(text: string): boolean {
  const t = text.toLowerCase();
  return IDENTITY_SIGNS.some((s) => t.includes(s));
}

export function looksLikeLockFailure(text: string): boolean {
  const t = text.toLowerCase();
  return LOCK_SIGNS.some((s) => t.includes(s));
}

export function looksLikePermissionFailure(text: string): boolean {
  const t = text.toLowerCase();
  return PERMISSION_SIGNS.some((s) => t.includes(s));
}

/**
 * lore's wording when the identity it was told to use is not in the store.
 *
 * Kept apart from an expired session because it is *not* one, and the remedies differ: this
 * is fixed by signing in as that specific user, or by changing what the repository is pinned
 * to. Observed live — a clone carrying `identity = "u-87c4…"` in `.lore/config.toml` while
 * that user was signed out. "Sign in again" as the user who *is* signed in would never have
 * fixed it.
 */
export function looksLikeMissingIdentity(text: string): boolean {
  return text.toLowerCase().includes("no token stored");
}

/**
 * The loopback port in an auth URL — which host's store an identity belongs to.
 *
 * Identities are filed per auth URL (I2/I3 in MODEL.md), so "is this user signed in?" is only
 * answerable *for a host*. Asking it globally is how a workspace on one host came to be judged
 * against another host's identities.
 */
export function portOfAuthUrl(url: string): number | null {
  const rest = url.split("://").pop() ?? url;
  const authority = rest.split("/")[0];
  const port = authority.split(":").pop();
  const n = Number.parseInt(port ?? "", 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The identities signed in at one host's auth URL. Resource tokens are not identities.
 *
 * Keyed by the auth URL itself, which is how `lore` keys `tokens.toml` — not by a loopback
 * port, which only distinguishes hosts while the transport happens to be a tunnel.
 */
export function identitiesAt(all: AuthIdentity[], authUrl: string | null | undefined): string[] {
  const wanted = authorityOfUrl(authUrl);
  if (!wanted) return [];
  return all
    .filter((i) => !i.resource && authorityOfUrl(i.auth_url) === wanted)
    .map((i) => i.user_id ?? "")
    .filter(Boolean);
}

function authorityOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const rest = url.includes("://") ? url.split("://")[1] : url;
  return rest.split("/")[0].trim() || null;
}

/** Prefer a name over an opaque id when we hold one. */
export function nameForId(id: string, known: { user?: string | null; user_id?: string | null }[]): string {
  const hit = known.find((k) => k.user_id === id);
  return hit?.user ? `${hit.user} (${id})` : id;
}

export interface Explained {
  message: string;
  /** The original text, for the Details disclosure. Absent when it adds nothing. */
  detail?: string;
  /** True when clearing the cached authorization could plausibly fix it. */
  canRefreshAccess?: boolean;
}

export function explainError(
  raw: string,
  signedInAs?: string | null,
  /** What this repository is pinned to act as, if anything. */
  repoIdentity?: string | null,
): Explained {
  // Checked before the auth cases: a lock message can mention a user, and reading it as an
  // identity problem would send someone to sign in over a colleague's open file.
  if (looksLikeLockFailure(raw)) {
    return {
      message:
        "Someone else has this file locked. Ask them to release it, or work on something else — " +
        "signing in again will not help.",
      detail: raw,
    };
  }
  if (looksLikeMissingIdentity(raw)) {
    return {
      message: repoIdentity
        ? `This repository is set to act as ${repoIdentity}, and that identity is not signed in. ` +
          `Sign in as that user, or change what this repository acts as.`
        : `The identity this repository needs is not signed in.`,
      detail: raw,
    };
  }
  // Permission first: "Not authorized" contains neither "unauthenticated" nor "expired", but
  // checking identity first would still be wrong if the lists ever overlapped — the costlier
  // mistake is sending a validly signed-in user to sign in again.
  if (looksLikePermissionFailure(raw)) {
    const who = signedInAs ? `You are signed in as ${signedInAs}, but that account has` : "Your account has";
    return {
      // The second sentence matters as much as the first. A denial is cached like any other
      // answer, for the authorization token's lifetime (15 minutes by default), so a host
      // that has just fixed the problem still looks broken — and nothing suggests waiting.
      message:
        `${who} no access to this repository. Ask whoever runs the host to grant it. ` +
        `If it was just granted, use “Refresh access” — a refusal stays cached for about 15 minutes.`,
      detail: raw,
      canRefreshAccess: true,
    };
  }
  if (looksLikeAuthFailure(raw)) {
    return {
      message: "Your access to this host has expired. Sign in again to continue.",
      detail: raw,
    };
  }
  return { message: raw };
}

/**
 * The badge label for a whole set of identities.
 *
 * With one, it reads as before. With several, the time shown belongs to **one** of them — the
 * soonest, because we cannot know which `lore` will use — so the label has to say whose it is.
 * "ale, uitest · 6h 27m left" invites reading the number as applying to both, and the other
 * one may have twelve hours or none.
 */
export function badgeLabel(
  identities: AuthIdentity[],
  e: Expiry,
  /** What the workspace in front of the user acts as, when it has chosen. */
  pinned?: string | null,
): string {
  if (pinned) {
    // The workspace has chosen, so the set is irrelevant: this is the identity every call
    // from it will use, and the only clock worth showing.
    const hit = identities.find((i) => i.user_id === pinned);
    const who = hit?.user ?? pinned;
    return e.state === "missing"
      ? `Acting as ${who} · not signed in`
      : expiryLabel(e, who);
  }
  if (identities.length <= 1) return expiryLabel(e, identities[0]?.user ?? undefined);

  const names = identities.map((i) => i.user ?? i.user_id ?? "unknown").join(", ");
  if (e.state === "missing" || e.state === "unknown") {
    return `${names} · ${e.state === "unknown" ? "expiry unknown" : "not signed in"}`;
  }

  // Whose clock this is. Ties keep the first, which is the order `lore auth list` printed.
  const dated = identities.filter((i) => i.expires_ms != null);
  const soonest = dated.reduce<AuthIdentity | undefined>(
    (best, i) => (best == null || i.expires_ms! < best.expires_ms! ? i : best),
    undefined,
  );
  const who = soonest?.user ?? soonest?.user_id ?? "one of them";
  const time = humanDuration(e.minutes ?? 0);
  return e.state === "expired"
    ? `${names} · ${who} expired ${time} ago`
    : `${names} · ${who} expires in ${time}`;
}
