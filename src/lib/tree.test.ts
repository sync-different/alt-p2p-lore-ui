import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  flattenTree,
  isBinaryName,
  missingAncestors,
  toggleExpanded,
  treeFromPaths,
  type LoadedDirs,
} from "./tree";
import type { DirEntry } from "./repo";

const file = (rel: string): DirEntry => ({
  name: rel.split("/").pop()!,
  rel_path: rel,
  is_dir: false,
  size: 10,
  modified_ms: 1,
  is_binary: false,
});

const dir = (rel: string): DirEntry => ({ ...file(rel), is_dir: true, size: 0 });

describe("flattenTree", () => {
  const loaded: LoadedDirs = new Map([
    ["", [dir("Content"), file("README.md")]],
    ["Content", [dir("Content/Characters"), file("Content/note.txt")]],
    ["Content/Characters", [file("Content/Characters/Hero.uasset")]],
  ]);

  it("shows only the root when nothing is expanded", () => {
    const rows = flattenTree(loaded, new Set(), new Set());
    expect(rows.map((r) => r.entry.rel_path)).toEqual(["Content", "README.md"]);
  });

  it("includes children of expanded directories, in order", () => {
    const rows = flattenTree(loaded, new Set(["Content"]), new Set());
    expect(rows.map((r) => r.entry.rel_path)).toEqual([
      "Content",
      "Content/Characters",
      "Content/note.txt",
      "README.md",
    ]);
  });

  it("nests depth so indentation is derivable", () => {
    const rows = flattenTree(loaded, new Set(["Content", "Content/Characters"]), new Set());
    const hero = rows.find((r) => r.entry.name === "Hero.uasset")!;
    expect(hero.depth).toBe(2);
    expect(rows.find((r) => r.entry.name === "Content")!.depth).toBe(0);
  });

  it("does not descend into an expanded directory whose children have not arrived", () => {
    // Lazy loading means expansion and data are separate events; flattening must cope with
    // the gap rather than assuming children exist.
    const rows = flattenTree(loaded, new Set(["Content", "Content/Missing"]), new Set());
    expect(rows.some((r) => r.entry.rel_path.startsWith("Content/Missing/"))).toBe(false);
  });

  it("marks directories that are still loading", () => {
    const rows = flattenTree(loaded, new Set(["Content"]), new Set(["Content/Characters"]));
    expect(rows.find((r) => r.entry.rel_path === "Content/Characters")!.loading).toBe(true);
    expect(rows.find((r) => r.entry.rel_path === "Content/note.txt")!.loading).toBe(false);
  });

  it("returns nothing when the root has not loaded", () => {
    expect(flattenTree(new Map(), new Set(), new Set())).toEqual([]);
  });
});

describe("toggleExpanded", () => {
  it("expands and collapses", () => {
    let e = toggleExpanded(new Set(), "a");
    expect(e.has("a")).toBe(true);
    e = toggleExpanded(e, "a");
    expect(e.has("a")).toBe(false);
  });

  it("forgets descendants when collapsing", () => {
    // Otherwise reopening a folder silently restores a subtree the user closed, which
    // reads as the app ignoring them.
    const e = new Set(["a", "a/b", "a/b/c", "other"]);
    const next = toggleExpanded(e, "a");
    expect(next.has("a")).toBe(false);
    expect(next.has("a/b")).toBe(false);
    expect(next.has("a/b/c")).toBe(false);
    expect(next.has("other")).toBe(true);
  });

  it("does not collapse a sibling that merely shares a name prefix", () => {
    const e = new Set(["Content", "Content2", "Content2/sub"]);
    const next = toggleExpanded(e, "Content");
    expect(next.has("Content2")).toBe(true);
    expect(next.has("Content2/sub")).toBe(true);
  });

  it("does not mutate the set it was given", () => {
    const original = new Set(["a"]);
    toggleExpanded(original, "b");
    expect(original.has("b")).toBe(false);
  });
});

describe("ancestorsOf / missingAncestors", () => {
  it("lists ancestors outermost first", () => {
    expect(ancestorsOf("a/b/c.txt")).toEqual(["a", "a/b"]);
  });

  it("gives nothing for a root-level file", () => {
    expect(ancestorsOf("README.md")).toEqual([]);
  });

  it("reports only the ancestors not yet loaded", () => {
    const loaded: LoadedDirs = new Map([["", []], ["a", []]]);
    expect(missingAncestors(loaded, "a/b/c.txt")).toEqual(["a/b"]);
  });
});

describe("treeFromPaths", () => {
  it("infers directories from paths alone", () => {
    // The changed set spans the whole repo, so its tree cannot come from directory reads.
    const loaded = treeFromPaths([
      "Content/Characters/Hero.uasset",
      "Content/note.txt",
      "README.md",
    ]);
    expect(loaded.get("")!.map((e) => e.name)).toEqual(["Content", "README.md"]);
    expect(loaded.get("Content")!.map((e) => e.name)).toEqual(["Characters", "note.txt"]);
    expect(loaded.get("Content/Characters")!.map((e) => e.name)).toEqual(["Hero.uasset"]);
  });

  it("marks inferred directories as directories and leaves as files", () => {
    const loaded = treeFromPaths(["a/b/c.txt"]);
    expect(loaded.get("")![0].is_dir).toBe(true);
    expect(loaded.get("a/b")![0].is_dir).toBe(false);
  });

  it("does not duplicate a shared directory", () => {
    const loaded = treeFromPaths(["a/one.txt", "a/two.txt", "a/b/three.txt"]);
    expect(loaded.get("")!.filter((e) => e.name === "a")).toHaveLength(1);
    expect(loaded.get("a")!.map((e) => e.name)).toEqual(["b", "one.txt", "two.txt"]);
  });

  it("classifies binaries by extension", () => {
    const loaded = treeFromPaths(["art/hero.PNG", "src/main.rs"]);
    expect(loaded.get("art")![0].is_binary).toBe(true);
    expect(loaded.get("src")![0].is_binary).toBe(false);
  });

  it("handles the full-repository change set at speed", () => {
    // 2163 changed paths is the real worst case, rebuilt whenever status refreshes.
    const paths = Array.from(
      { length: 2163 },
      (_, i) => `Content/Group${i % 50}/Sub${i % 7}/asset${i}.uasset`,
    );
    const start = performance.now();
    const loaded = treeFromPaths(paths);
    const elapsed = performance.now() - start;

    expect(loaded.get("")!.length).toBe(1);
    expect(elapsed).toBeLessThan(200);
  });

  it("produces an empty root for no changes", () => {
    const loaded = treeFromPaths([]);
    expect(loaded.get("")).toEqual([]);
  });
});

describe("isBinaryName", () => {
  it("agrees with the Rust classifier on the common cases", () => {
    expect(isBinaryName("Hero.uasset")).toBe(true);
    expect(isBinaryName("shot.TGA")).toBe(true);
    expect(isBinaryName("notes.txt")).toBe(false);
    expect(isBinaryName("Makefile")).toBe(false);
  });
});
