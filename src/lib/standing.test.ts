import { describe, expect, it } from "vitest";
import { adviseBranch } from "./standing";
import type { RepoStatus } from "./repo";

const status = (over: Partial<RepoStatus> = {}): RepoStatus =>
  ({
    changes: [],
    standing: "in_sync",
    pending_merge: false,
    conflicts: [],
    ...over,
  }) as RepoStatus;

/**
 * The point of this module: say where the branch stands *before* a button is pressed. Letting
 * someone press Push and then translating "Branch has diverged" tells them, after a wasted
 * round trip, what they could have been told beforehand.
 */
describe("adviseBranch", () => {
  it("offers a push only when there is something to push", () => {
    expect(adviseBranch(status({ standing: "ahead" })).canPush).toBe(true);
    expect(adviseBranch(status({ standing: "in_sync" })).canPush).toBe(false);
    expect(adviseBranch(status({ standing: "behind" })).canPush).toBe(false);
  });

  it("refuses a diverged push and says why, before it is attempted", () => {
    const a = adviseBranch(status({ standing: "diverged" }));
    expect(a.canPush).toBe(false);
    expect(a.summary).toMatch(/sync to merge before pushing/i);
    expect(a.pushBlockedReason).toMatch(/diverged/i);
  });

  it("treats an open merge as outranking everything", () => {
    // Nothing can be pushed until it is finished, and the files on disk contain conflict
    // markers that must not be committed by accident.
    const a = adviseBranch(status({ standing: "ahead", pending_merge: true, conflicts: ["note.txt"] }));
    expect(a.canPush).toBe(false);
    expect(a.canSync).toBe(false);
    expect(a.summary).toMatch(/1 file in conflict/i);
    expect(a.tone).toBe("danger");
  });

  it("distinguishes a merge with conflicts from one merely uncommitted", () => {
    const clean = adviseBranch(status({ pending_merge: true, conflicts: [] }));
    expect(clean.summary).toMatch(/commit to finish it/i);
    expect(clean.tone).toBe("warn");
  });

  it("never assumes it is safe to push on no information", () => {
    // Unknown is the default, and reaching for a push there would produce exactly the
    // failure this module exists to pre-empt.
    expect(adviseBranch(status({ standing: "unknown" })).canPush).toBe(false);
    expect(adviseBranch(null).canPush).toBe(false);
  });
});
