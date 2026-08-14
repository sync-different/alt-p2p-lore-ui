import { describe, expect, it } from "vitest";
import {
  describeBreak,
  describeOutcome,
  displayOwner,
  explainBlocked,
  holderOf,
  lockActions,
  lockState,
} from "./locks";
import type { FileLock, LockOutcome } from "./repo";

/**
 * The facts these tests are built on, all established against a live host rather than assumed:
 *
 * - releasing another person's lock succeeds, and does not need `--force`;
 * - a refused acquire names neither the file nor the holder;
 * - the printed owner is a display name that differs between workspaces for the same lock.
 */

const lock = (
  path: string,
  owner: string,
  mine: boolean | null = null,
  known_as: string | null = null,
): FileLock => ({ path, owner, since: null, known_as, mine });

const index = (...ls: FileLock[]) => new Map(ls.map((l) => [l.path, l]));

const MINE = lock("Daniel/Test.txt", "Alejandro", true);
const THEIRS = lock("Feedback.txt", "uitest", false);

describe("lockState", () => {
  it("reads ownership from the resolved flag, never from the name", () => {
    // The same lock prints "Alejandro" in one workspace and "ale" in another, so the name
    // cannot decide this. Both of these are owned by us and named differently.
    expect(lockState("Daniel/Test.txt", index(MINE), true)).toBe("mine");
    expect(lockState("a.txt", index(lock("a.txt", "ale", true)), true)).toBe("mine");
  });

  it("treats an unattributable lock as somebody else's", () => {
    // The safe direction: an extra confirmation on our own lock costs a click, while the
    // reverse hands a colleague's file away silently.
    expect(lockState("x.txt", index(lock("x.txt", "someone")), true)).toBe("theirs");
  });

  it("says unknown rather than free when locks could not be read", () => {
    // Offline, `lore` reports "Unable to check lock status while offline". Rendering that as
    // "no locks" invites an edit to a file a colleague is holding.
    expect(lockState("Daniel/Test.txt", index(MINE), false)).toBe("unknown");
    expect(lockState("anything.txt", undefined, false)).toBe("unknown");
  });

  it("is free only when locks were read and it is absent", () => {
    expect(lockState("free.txt", index(MINE, THEIRS), true)).toBe("free");
  });

  it("names the holder for a message", () => {
    expect(holderOf("Feedback.txt", index(THEIRS))).toBe("uitest");
    expect(holderOf("free.txt", index(THEIRS))).toBeNull();
  });
});

describe("displayOwner", () => {
  it("prefers the name this app knows over whatever the host rendered", () => {
    // Reported from testing: a lock held by `ale` read "Locked by Alejandro". Same account —
    // the host returns a display name — but every other panel calls it `ale`, which is what
    // the user signs in as, so two names for one person appeared on one screen.
    const held = lock("Daniel/Test.txt", "Alejandro", false, "ale");
    expect(displayOwner(held)).toBe("ale");
    expect(holderOf("Daniel/Test.txt", index(held))).toBe("ale");
  });

  it("falls back to the host's string for somebody we have never signed in as", () => {
    // A real colleague on another machine. We genuinely do not know that account, and
    // inventing a name for it would be worse than showing the one the host gave.
    expect(displayOwner(lock("a.uasset", "dana", false))).toBe("dana");
  });

  it("uses the known name even when the host returns a raw id", () => {
    // The third rendering seen live, and the least readable of them.
    expect(displayOwner(lock("a", "u-87c4b8c8b7f44fc1", false, "ale"))).toBe("ale");
  });

  it("carries the known name into the messages that name people", () => {
    const held = lock("Daniel/Test.txt", "Alejandro", false, "ale");
    expect(explainBlocked([held])).toContain("ale");
    expect(explainBlocked([held])).not.toContain("Alejandro");
    expect(describeBreak([held])).toContain("ale");
    expect(describeBreak([held])).not.toContain("Alejandro");
  });
});

describe("lockActions", () => {
  const locks = index(MINE, THEIRS);

  it("splits a mixed selection instead of blocking it", () => {
    const a = lockActions(["free.txt", "Daniel/Test.txt", "Feedback.txt"], locks, true);
    expect(a.takeable).toEqual(["free.txt"]);
    expect(a.releasable).toEqual(["Daniel/Test.txt"]);
    expect(a.breakable).toEqual(["Feedback.txt"]);
  });

  it("keeps breaking a lock separate from releasing one", () => {
    // The CLI does not distinguish these — `lock release` on someone else's lock simply
    // works — so the distinction exists only here, and everything downstream depends on it.
    const a = lockActions(["Feedback.txt"], locks, true);
    expect(a.releasable).toEqual([]);
    expect(a.breakable).toEqual(["Feedback.txt"]);
  });

  it("offers nothing at all when the lock list could not be read", () => {
    const a = lockActions(["free.txt", "Daniel/Test.txt"], locks, false);
    expect(a).toEqual({ takeable: [], releasable: [], breakable: [], known: false });
  });
});

describe("explainBlocked", () => {
  it("names the person, which the CLI never does", () => {
    // The whole output of a refused acquire is:
    //   [Error] Failed to lock-acquire 1 batch(es) out of 1
    const s = explainBlocked([lock("test2.txt", "uitest", false)]);
    expect(s).toContain("test2.txt");
    expect(s).toContain("uitest");
  });

  it("includes when it was taken, when that is known", () => {
    const held: FileLock = { ...lock("t.txt", "uitest", false), since: "Fri, 14 Aug 2026 14:14:13 +0000" };
    expect(explainBlocked([held])).toContain("Fri, 14 Aug 2026");
  });

  it("summarises several without listing every path", () => {
    const s = explainBlocked([
      lock("a.uasset", "uitest", false),
      lock("b.uasset", "uitest", false),
      lock("c.uasset", "uitest", false),
    ]);
    expect(s).toContain("3 files");
    expect(s).toContain("uitest");
  });

  it("counts distinct people when a batch spans several", () => {
    const s = explainBlocked([lock("a", "uitest", false), lock("b", "dana", false)]);
    expect(s).toMatch(/2 other people/);
  });

  it("says nothing when nothing was blocked", () => {
    expect(explainBlocked([])).toBe("");
  });
});

describe("describeOutcome", () => {
  const outcome = (o: Partial<LockOutcome>): LockOutcome => ({
    acquired: [],
    already_owned: [],
    released: [],
    blocked: [],
    ...o,
  });

  it("does not claim to have locked what was already ours", () => {
    // `lore` reports these separately for a reason: nothing changed on the host.
    const s = describeOutcome(outcome({ acquired: ["a"], already_owned: ["b", "c"] }));
    expect(s).toContain("Locked 1 file");
    expect(s).toContain("2 files already yours");
  });

  it("reports a release", () => {
    expect(describeOutcome(outcome({ released: ["a", "b"] }))).toBe("Released 2 files");
  });

  it("admits when a call changed nothing", () => {
    expect(describeOutcome(outcome({}))).toBe("Nothing to do");
  });
});

describe("describeBreak", () => {
  it("names whose work is at stake", () => {
    // A confirmation that does not say whose file it is becomes one people click through.
    const s = describeBreak([lock("Feedback.txt", "uitest", false)]);
    expect(s).toContain("Feedback.txt");
    expect(s).toContain("uitest");
    expect(s).toMatch(/still be working/i);
  });

  it("names every holder when a batch spans two", () => {
    const s = describeBreak([lock("a", "uitest", false), lock("b", "dana", false)]);
    expect(s).toContain("uitest");
    expect(s).toContain("dana");
    expect(s).toContain("2 files");
  });
});
