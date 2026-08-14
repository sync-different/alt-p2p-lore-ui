import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RECENTS,
  forgetRecent,
  loadRecents,
  rememberRecent,
  repoName,
  shortenPath,
} from "./recents";

/** An in-memory Storage, so these tests never touch the real localStorage. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

let storage: Storage;
beforeEach(() => {
  storage = fakeStorage();
});

describe("recents", () => {
  it("remembers a path", () => {
    rememberRecent("/a/demo", storage, 100);
    expect(loadRecents(storage).map((r) => r.path)).toEqual(["/a/demo"]);
  });

  it("moves an existing path to the front rather than duplicating it", () => {
    rememberRecent("/a", storage, 1);
    rememberRecent("/b", storage, 2);
    rememberRecent("/a", storage, 3);

    const paths = loadRecents(storage).map((r) => r.path);
    expect(paths).toEqual(["/a", "/b"]);
    expect(paths.filter((p) => p === "/a")).toHaveLength(1);
  });

  it("orders most recent first", () => {
    rememberRecent("/old", storage, 1);
    rememberRecent("/new", storage, 999);
    expect(loadRecents(storage)[0].path).toBe("/new");
  });

  it("caps the list", () => {
    for (let i = 0; i < MAX_RECENTS + 5; i++) rememberRecent(`/r${i}`, storage, i);
    expect(loadRecents(storage)).toHaveLength(MAX_RECENTS);
    // The oldest fell off, the newest survived.
    expect(loadRecents(storage)[0].path).toBe(`/r${MAX_RECENTS + 4}`);
  });

  it("forgets a path", () => {
    rememberRecent("/a", storage, 1);
    rememberRecent("/b", storage, 2);
    forgetRecent("/a", storage);
    expect(loadRecents(storage).map((r) => r.path)).toEqual(["/b"]);
  });

  it("survives corrupt storage instead of throwing", () => {
    // This is user-writable storage; a previous version may have written another shape.
    expect(loadRecents(fakeStorage({ "alt-lore.recent-repos": "not json" }))).toEqual([]);
    expect(loadRecents(fakeStorage({ "alt-lore.recent-repos": '{"not":"an array"}' }))).toEqual([]);
  });

  it("drops malformed entries but keeps good ones", () => {
    const s = fakeStorage({
      "alt-lore.recent-repos": JSON.stringify([
        { path: "/good", at: 5 },
        { nonsense: true },
        { path: 42, at: "x" },
      ]),
    });
    expect(loadRecents(s).map((r) => r.path)).toEqual(["/good"]);
  });

  it("does not fail an open when storage refuses to write", () => {
    // A quota error must not propagate: remembering is a convenience, and failing the
    // repository open over it would be absurd.
    const hostile = {
      ...fakeStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    } as unknown as Storage;
    expect(() => rememberRecent("/a", hostile, 1)).not.toThrow();
  });
});

describe("repoName / shortenPath", () => {
  it("uses the last path component as the name", () => {
    expect(repoName("/Users/ale/demo-ctone2/demo")).toBe("demo");
    expect(repoName("/Users/ale/demo/")).toBe("demo");
  });

  it("abbreviates the home directory", () => {
    expect(shortenPath("/Users/ale/demo", "/Users/ale")).toBe("~/demo");
    expect(shortenPath("/opt/other", "/Users/ale")).toBe("/opt/other");
    expect(shortenPath("/Users/ale/demo")).toBe("/Users/ale/demo");
  });
});
