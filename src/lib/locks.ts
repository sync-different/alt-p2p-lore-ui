/**
 * What the app may offer to do about a lock, and what it should say.
 *
 * Locks are the only thing here that reaches across to another person: taking one stops a
 * colleague editing, and releasing one takes a file back off them whether or not they were
 * done. Two facts from the CLI shape every rule below, both established against a live host:
 *
 * - **Anyone can release anyone's lock, and `--force` is not needed.** There is no ownership
 *   check underneath. Whatever protects a colleague's work is here.
 * - **The owner as printed is a display name, not an identity.** One lock reads `Alejandro`
 *   in the workspace that holds it and `ale` in another on the same machine — so ownership is
 *   resolved by the server and arrives as `mine`, which may be `null` for "could not tell".
 *
 * `null` is treated as *not mine* for the purpose of offering actions. That is the safe
 * direction: the cost of being wrong is an extra confirmation on a lock that turns out to be
 * your own, against silently presenting a colleague's lock as yours to drop.
 */

import type { FileLock, LockOutcome } from "./repo";

export type LockState =
  /** Nobody holds it. */
  | "free"
  /** Held by us. */
  | "mine"
  /** Held by someone else, or by an owner we could not attribute. */
  | "theirs"
  /** We could not read locks at all — offline, most likely. */
  | "unknown";

/**
 * The state of one path.
 *
 * `available` is whether the lock list could be read at all. Without it every file looks
 * unlocked, which is the one wrong answer that loses work: an artist edits a file a colleague
 * is holding because the app said it was free while it simply could not see.
 */
export function lockState(
  path: string,
  locks: Map<string, FileLock> | undefined,
  available: boolean,
): LockState {
  if (!available || !locks) return "unknown";
  const l = locks.get(path);
  if (!l) return "free";
  return l.mine === true ? "mine" : "theirs";
}

/**
 * What to call the holder of a lock.
 *
 * The host's own string is a last resort. It is not stable — one unchanged lock has printed as
 * `Alejandro`, `ale` and `u-87c4b8c8b7f44fc1` — and the user knows that account by the name
 * they sign in as, which is what every other panel shows. Where the backend recognised the
 * holder, `known_as` carries that name; otherwise it is genuinely somebody we do not know, and
 * the host's string is the only honest thing to show.
 */
export function displayOwner(lock: FileLock): string {
  return lock.known_as ?? lock.owner;
}

/** Who to name in the UI for a held file. */
export function holderOf(path: string, locks: Map<string, FileLock> | undefined): string | null {
  const l = locks?.get(path);
  return l ? displayOwner(l) : null;
}

/**
 * Which of the actions to show for a selection of paths.
 *
 * A selection is rarely uniform — some free, some yours, some a colleague's — so this reports
 * each group rather than picking a single verb. Buttons are enabled per group, so a mixed
 * selection still does something sensible instead of being blocked wholesale.
 */
export interface LockActions {
  /** Free files, which may be taken. */
  takeable: string[];
  /** Ours, which may be released with no ceremony. */
  releasable: string[];
  /** Someone else's: releasing these is *breaking* a lock and must be confirmed. */
  breakable: string[];
  /** Whether locks could be read at all; nothing may be acted on if not. */
  known: boolean;
}

export function lockActions(
  paths: string[],
  locks: Map<string, FileLock> | undefined,
  available: boolean,
): LockActions {
  const actions: LockActions = { takeable: [], releasable: [], breakable: [], known: available };
  if (!available) return actions;

  for (const p of paths) {
    switch (lockState(p, locks, available)) {
      case "free":
        actions.takeable.push(p);
        break;
      case "mine":
        actions.releasable.push(p);
        break;
      case "theirs":
        actions.breakable.push(p);
        break;
    }
  }
  return actions;
}

/**
 * The sentence for a refused acquire.
 *
 * `lore` says only `Failed to lock-acquire 1 batch(es) out of 1`, which names neither the file
 * nor the person — so the backend re-queries and the holders arrive in `blocked`. Naming them
 * is the entire point: the remedy for a held file is to talk to somebody.
 */
export function explainBlocked(blocked: FileLock[]): string {
  if (blocked.length === 0) return "";
  if (blocked.length === 1) {
    const b = blocked[0];
    return `${b.path} is locked by ${displayOwner(b)}${b.since ? ` (since ${b.since})` : ""}.`;
  }
  const owners = [...new Set(blocked.map(displayOwner))];
  const who = owners.length === 1 ? owners[0] : `${owners.length} other people`;
  return `${blocked.length} files are locked by ${who}.`;
}

/**
 * What to say after a lock call succeeded.
 *
 * Re-taking a lock you already hold is reported separately by the CLI, and saying "locked 3
 * files" when two of them were already yours claims a change that did not happen.
 */
export function describeOutcome(o: LockOutcome): string {
  const parts: string[] = [];
  if (o.acquired.length) parts.push(`Locked ${count(o.acquired.length, "file")}`);
  if (o.already_owned.length) parts.push(`${count(o.already_owned.length, "file")} already yours`);
  if (o.released.length) parts.push(`Released ${count(o.released.length, "file")}`);
  if (parts.length === 0 && o.blocked.length === 0) return "Nothing to do";
  return parts.join(", ");
}

/**
 * The warning shown before breaking someone else's lock.
 *
 * Names the person, because a confirmation that does not say whose work is at stake is a
 * dialog people learn to click through.
 */
export function describeBreak(locks: FileLock[]): string {
  const owners = [...new Set(locks.map(displayOwner))];
  const who = owners.length === 1 ? owners[0] : owners.join(" and ");
  const what = locks.length === 1 ? locks[0].path : count(locks.length, "file");
  return `${what} is locked by ${who}. Breaking the lock lets you edit it while they may still be working on it.`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
