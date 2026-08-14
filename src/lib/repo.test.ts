import { describe, expect, it } from "vitest";
import {
  changeBadge,
  changeIndex,
  changeLabel,
  directoryHasChanges,
  filterPaths,
  formatSize,
  type ChangeEntry,
  type RepoStatus,
} from "./repo";

const status = (changes: ChangeEntry[]): RepoStatus => ({
  repo_id: "abc",
  branch: "main",
  revision: 21,
  revision_hash: "deadbeef",
    standing: "in_sync",
    pending_merge: false,
    conflicts: [],
  changes,
});

describe("changeBadge / changeLabel", () => {
  it("renders the familiar single letters", () => {
    expect(changeBadge("added")).toBe("A");
    expect(changeBadge("modified")).toBe("M");
    expect(changeBadge("deleted")).toBe("D");
  });

  it("passes an unrecognised code through rather than hiding it", () => {
    // Showing a code we do not understand beats implying the file is unchanged.
    expect(changeBadge({ other: "R" })).toBe("R");
    expect(changeLabel({ other: "R" })).toBe("Change code R");
  });

  it("gives every kind a human label", () => {
    expect(changeLabel("added")).toBe("Added");
    expect(changeLabel("modified")).toBe("Modified");
    expect(changeLabel("deleted")).toBe("Deleted");
  });
});

describe("changeIndex", () => {
  it("maps paths to their change kind", () => {
    const idx = changeIndex(status([
      { kind: "modified", staged: false, path: "a.txt" },
      { kind: "added", staged: false, path: "dir/b.uasset" },
    ]));
    expect(idx.get("a.txt")).toBe("modified");
    expect(idx.get("dir/b.uasset")).toBe("added");
    expect(idx.has("missing.txt")).toBe(false);
  });

  it("handles a null status without throwing", () => {
    // The tree renders before the first status returns; this must not be a crash path.
    expect(changeIndex(null).size).toBe(0);
  });
});

describe("directoryHasChanges", () => {
  const idx = changeIndex(status([
    { kind: "modified", staged: false, path: "Content/Characters/Hero.uasset" },
    { kind: "added", staged: false, path: "README.md" },
  ]));

  it("marks a directory containing a change", () => {
    expect(directoryHasChanges(idx, "Content")).toBe(true);
    expect(directoryHasChanges(idx, "Content/Characters")).toBe(true);
  });

  it("does not mark an unrelated directory", () => {
    expect(directoryHasChanges(idx, "Binaries")).toBe(false);
  });

  it("does not match a directory that is merely a name prefix", () => {
    // "Content2" starts with "Content" as a string but is a different folder — matching on
    // the bare prefix would light up siblings that have nothing in them.
    expect(directoryHasChanges(idx, "Content2")).toBe(false);
  });

  it("treats the root as changed when anything has changed", () => {
    expect(directoryHasChanges(idx, "")).toBe(true);
    expect(directoryHasChanges(new Map(), "")).toBe(false);
  });
});

describe("filterPaths", () => {
  const items = [
    { path: "Content/Characters/Hero.uasset" },
    { path: "Content/Maps/Level01.umap" },
    { path: "README.md" },
  ];

  it("returns everything for an empty query", () => {
    expect(filterPaths(items, "")).toHaveLength(3);
    expect(filterPaths(items, "   ")).toHaveLength(3);
  });

  it("matches case-insensitively on any part of the path", () => {
    expect(filterPaths(items, "hero")).toHaveLength(1);
    expect(filterPaths(items, "CONTENT")).toHaveLength(2);
    expect(filterPaths(items, "umap")).toHaveLength(1);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterPaths(items, "zzz")).toHaveLength(0);
  });

  it("stays fast on a full-repository change set", () => {
    // 2163 entries is the real worst case, and the filter runs on every keystroke.
    const many = Array.from({ length: 2163 }, (_, i) => ({ path: `Content/dir${i}/file${i}.uasset` }));
    const start = performance.now();
    const hit = filterPaths(many, "file2162");
    const elapsed = performance.now() - start;
    expect(hit).toHaveLength(1);
    expect(elapsed).toBeLessThan(50);
  });
});

describe("formatSize", () => {
  it("uses bytes below a kilobyte", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("scales through the units", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1024 * 1024 * 1.5)).toBe("1.5 MB");
    expect(formatSize(1024 ** 3 * 2)).toBe("2.0 GB");
  });

  it("drops the decimal once the number is large enough not to need it", () => {
    expect(formatSize(1024 * 512)).toBe("512 KB");
  });
});
