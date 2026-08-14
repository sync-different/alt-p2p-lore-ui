import type { BranchStanding, RepoStatus } from "./repo";

/**
 * What to say about a branch, and what to offer, *before* anything is attempted.
 *
 * The alternative — let the user press Push and translate the failure — was the old shape of
 * this app and it is worse: "Branch has diverged, sync to merge remote changes" arrives after
 * a wasted round trip, and only tells you what you could have been told beforehand.
 *
 * Standing comes from lore's own sentence rather than from comparing revision numbers, which
 * are equal in both the in-sync and diverged cases.
 */

export interface BranchAdvice {
  /** One line, always true, safe to show permanently. */
  summary: string;
  canPush: boolean;
  canSync: boolean;
  /** Pressing Push here would fail; say so instead of offering it. */
  pushBlockedReason?: string;
  tone: "ok" | "info" | "warn" | "danger";
}

export function adviseBranch(status: RepoStatus | null | undefined): BranchAdvice {
  if (!status) {
    return { summary: "No repository open.", canPush: false, canSync: false, tone: "info" };
  }

  // A merge outranks everything: nothing can be pushed until it is finished, and the files
  // on disk contain conflict markers that must not be committed by accident.
  if (status.pending_merge) {
    const n = status.conflicts.length;
    return {
      summary:
        n > 0
          ? `Merging — ${n} file${n === 1 ? "" : "s"} in conflict. Resolve ${n === 1 ? "it" : "them"}, then commit.`
          : "Merging — commit to finish it.",
      canPush: false,
      canSync: false,
      pushBlockedReason: "Finish the merge first.",
      tone: n > 0 ? "danger" : "warn",
    };
  }

  const standing: BranchStanding = status.standing ?? "unknown";
  switch (standing) {
    case "in_sync":
      return { summary: "Up to date with the host.", canPush: false, canSync: true, tone: "ok" };
    case "ahead":
      return { summary: "You have work the host does not.", canPush: true, canSync: true, tone: "info" };
    case "behind":
      return {
        summary: "The host has work you do not. Sync to get it.",
        canPush: false,
        canSync: true,
        pushBlockedReason: "There is nothing here the host does not already have.",
        tone: "info",
      };
    case "diverged":
      return {
        // Said before Push is pressed, not after it is refused.
        summary: "Both you and the host have new work. Sync to merge before pushing.",
        canPush: false,
        canSync: true,
        pushBlockedReason: "The branch has diverged — sync first, and resolve any conflicts.",
        tone: "warn",
      };
    default:
      // Never assume it is safe to push on no information.
      return {
        summary: "Not known — connect to the host to find out.",
        canPush: false,
        canSync: true,
        pushBlockedReason: "How this branch stands is unknown until the host answers.",
        tone: "info",
      };
  }
}
