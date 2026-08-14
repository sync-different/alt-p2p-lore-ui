/**
 * Front-end view models.
 *
 * Distinct from `ipc.ts`, which mirrors the Rust wire format exactly. These are what the
 * UI renders; the boundary between the two is where snake_case becomes camelCase, so the
 * wire shape never leaks into components.
 *
 * ## Cardinality
 *
 *   N sessions      — one per tab
 *   1 session : N repos     — a single tunnel to a host serves every repo that host has
 *   1 repo    : N branches
 *
 * The middle relation is the one that shapes the UI: connecting is a *host*-level act, not
 * a repository-level one, so a user connects once and then moves between that host's
 * repositories without reconnecting. Both lists are discoverable rather than typed —
 * `lore repository list <url>` against the session's tunnel, then `lore branch list`.
 */

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "relay"
  | "error";

/** A repository offered by the host a session is connected to. */
export interface Repo {
  id: string;
  name: string;
  /**
   * Where this repo is cloned on disk, or null if it exists only on the host.
   *
   * This is the field that decides which actions apply: a repo with no local path can
   * only be cloned; one with a path can sync, commit and push. The user picks the
   * location per repo (spec Q6), so it cannot be derived.
   */
  localPath: string | null;
  branches: string[];
  activeBranch: string | null;
}

/** One Lore session — a connection to a host, shown as a tab. */
export interface Session {
  id: string;
  /** What the user calls it, e.g. "Studio main". Never the session id or PSK. */
  name: string;
  status: SessionStatus;
  /** Repositories this host offers. Empty until connected and listed. */
  repos: Repo[];
  activeRepoId: string | null;
}

export type NoticeLevel = "info" | "success" | "warn" | "error";

/**
 * One line in the Activity pane.
 *
 * Deliberately not a toast: these are a log the user can scan after the fact, because the
 * events that matter here — a session dropping, a lock being taken by someone else, a
 * token about to expire — happen while attention is elsewhere. A toast that vanishes is
 * exactly the wrong shape for those.
 */
export interface Notice {
  id: string;
  level: NoticeLevel;
  /** Epoch millis; formatted at render so the list stays sortable. */
  at: number;
  message: string;
  /** Which session it came from, when it came from one. */
  /**
   * What this line is about: a workspace for repository work, a host for connection events.
   *
   * Was `sessionName`, when a tab meant a session. Both kinds now appear in one feed, and an
   * unlabelled line is worse than no line — with several tabs open it invites acting on the
   * wrong one.
   */
  source?: string;
}

/** The repo currently in view, if any. */
export function activeRepo(session: Session | null): Repo | null {
  if (!session) return null;
  return session.repos.find((r) => r.id === session.activeRepoId) ?? null;
}
