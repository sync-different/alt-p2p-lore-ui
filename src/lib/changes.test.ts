import { describe, expect, it } from "vitest";
import { describeCommit, describeKind, groupChanges, toggleAll, toggleSelected } from "./changes";
import type { ChangeEntry } from "./repo";

const c = (path: string, kind: ChangeEntry["kind"], staged: boolean): ChangeEntry => ({
  path,
  kind,
  staged,
});

describe("grouping", () => {
  it("separates what a commit would include from what it would not", () => {
    // The distinction lives only in lore's section headers; everything downstream depends on
    // it having been carried this far.
    const g = groupChanges([c("a.txt", "added", true), c("b.txt", "added", false)]);
    expect(g.staged.map((x) => x.path)).toEqual(["a.txt"]);
    expect(g.unstaged.map((x) => x.path)).toEqual(["b.txt"]);
  });

  it("says what a change is in words an artist would use", () => {
    expect(describeKind("modified")).toBe("changed");
    expect(describeKind("added")).toBe("added");
    expect(describeKind("deleted")).toBe("deleted");
    // An unknown code is passed through rather than guessed at or hidden.
    expect(describeKind({ other: "R" })).toBe("r");
  });
});

describe("selection", () => {
  it("toggles one path", () => {
    const s = toggleSelected(new Set(["a"]), "b");
    expect([...s].sort()).toEqual(["a", "b"]);
    expect([...toggleSelected(s, "a")]).toEqual(["b"]);
  });

  it("selects a whole group, and clears it when it is already whole", () => {
    const paths = ["a", "b"];
    const all = toggleAll(new Set(), paths);
    expect([...all].sort()).toEqual(["a", "b"]);
    expect([...toggleAll(all, paths)]).toEqual([]);
  });

  it("does not disturb a selection outside the group", () => {
    const s = toggleAll(new Set(["keep"]), ["a"]);
    expect(s.has("keep")).toBe(true);
  });
});

describe("what a commit will contain", () => {
  it("counts staged entries, never the selection", () => {
    // The selection is what the next button acts on; the staged set is what a commit writes.
    // Conflating them is how someone commits more than they meant to.
    expect(describeCommit([c("a", "added", true), c("b", "modified", true)]))
      .toBe("2 files — 1 added, 1 changed");
  });

  it("is honest when nothing is staged", () => {
    expect(describeCommit([])).toBe("Nothing is staged.");
  });

  it("uses the singular for one file", () => {
    expect(describeCommit([c("a", "added", true)])).toBe("1 file — 1 added");
  });
});
