import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

/**
 * Tests for the repository hook.
 *
 * The commands are mocked, so these check the hook's *decisions* — what it re-reads, what
 * it keeps, what it throws away. That is where the refresh bug lived: every individual
 * command worked, and the hook simply never called the one that mattered.
 */

const mockOpenRepo = vi.fn();
const mockRepoStatus = vi.fn();
const mockListDir = vi.fn();
const mockListLocks = vi.fn();

vi.mock("../lib/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/repo")>();
  return {
    ...actual,
    openRepo: (...a: unknown[]) => mockOpenRepo(...a),
    repoStatus: (...a: unknown[]) => mockRepoStatus(...a),
    listDir: (...a: unknown[]) => mockListDir(...a),
    listLocks: (...a: unknown[]) => mockListLocks(...a),
  };
});

import { useRepository } from "./useRepository";

const entry = (name: string, is_dir = false, parent = "") => ({
  name,
  rel_path: parent ? `${parent}/${name}` : name,
  is_dir,
  size: 1,
  modified_ms: 1,
  is_binary: name.endsWith(".png"),
});

const status = (paths: string[] = []) => ({
  repo_id: "abc",
  branch: "main",
  revision: 21,
  revision_hash: "deadbeef",
  changes: paths.map((p) => ({ kind: "modified" as const, path: p })),
});

beforeEach(() => {
  mockOpenRepo.mockReset();
  mockRepoStatus.mockReset();
  mockListDir.mockReset();
  mockListLocks.mockReset();
});

async function openWith(rootEntries: ReturnType<typeof entry>[]) {
  mockOpenRepo.mockResolvedValue({
    path: "/repo",
    status: status(),
    branches: { names: ["main"], current: "main", remote_only: [] },
  });
  mockListDir.mockResolvedValue(rootEntries);

  const hook = renderHook(() => useRepository());
  await act(async () => {
    await hook.result.current.open("/repo");
  });
  return hook;
}

describe("useRepository", () => {
  it("loads the root when a repository is opened", async () => {
    const { result } = await openWith([entry("test", true), entry("README.md")]);

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.rows.map((r) => r.entry.name)).toEqual(["test", "README.md"]);
    expect(result.current.info?.status.branch).toBe("main");
  });

  it("re-reads directory listings on refresh, not just status", async () => {
    // THE bug: refresh only re-ran `lore status`, so a file created on disk could never
    // appear in the all-files tree. The changed view hid it, being derived from status.
    const { result } = await openWith([entry("test", true)]);

    mockListDir.mockClear();
    mockRepoStatus.mockResolvedValue(status(["test/new.png"]));
    mockListDir.mockResolvedValue([entry("test", true), entry("new.png")]);

    await act(async () => {
      await result.current.refreshStatus();
    });

    expect(mockListDir).toHaveBeenCalled();
    await waitFor(() =>
      expect(result.current.rows.map((r) => r.entry.name)).toContain("new.png"),
    );
  });

  it("shows a file added inside an expanded subdirectory", async () => {
    // The reported case: a .png added to a folder that was already open, which stayed
    // stubbornly empty.
    const { result } = await openWith([entry("test", true)]);

    mockListDir.mockResolvedValue([]); // "test" is empty at first
    await act(async () => {
      await result.current.toggle(entry("test", true));
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    // A file appears on disk; refresh must find it.
    mockRepoStatus.mockResolvedValue(status());
    mockListDir.mockImplementation((_root: string, rel: string) =>
      Promise.resolve(rel === "test" ? [entry("shot.png", false, "test")] : [entry("test", true)]),
    );

    await act(async () => {
      await result.current.refreshStatus();
    });

    await waitFor(() =>
      expect(result.current.rows.map((r) => r.entry.name)).toContain("shot.png"),
    );
  });

  it("keeps folders expanded across a refresh", async () => {
    // Refresh must not collapse the tree the user is working in.
    const { result } = await openWith([entry("test", true)]);

    mockListDir.mockResolvedValue([entry("a.txt", false, "test")]);
    await act(async () => {
      await result.current.toggle(entry("test", true));
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(2));

    mockRepoStatus.mockResolvedValue(status());
    mockListDir.mockImplementation((_root: string, rel: string) =>
      Promise.resolve(rel === "test" ? [entry("a.txt", false, "test")] : [entry("test", true)]),
    );
    await act(async () => {
      await result.current.refreshStatus();
    });

    await waitFor(() => expect(result.current.rows).toHaveLength(2));
    expect(result.current.expanded.has("test")).toBe(true);
  });

  it("only re-reads directories that are actually loaded", async () => {
    // Cost must track what is on screen, not the repository's 1988 directories.
    const { result } = await openWith([entry("a", true), entry("b", true), entry("c", true)]);

    mockListDir.mockClear();
    mockRepoStatus.mockResolvedValue(status());
    mockListDir.mockResolvedValue([]);

    await act(async () => {
      await result.current.refreshStatus();
    });

    // Only the root was ever loaded, so only the root is re-read.
    expect(mockListDir).toHaveBeenCalledTimes(1);
    expect(mockListDir).toHaveBeenCalledWith("/repo", "");
  });

  it("refresh re-reads locks as well as status and listings", async () => {
    // Locks are part of the repository's state; refreshing without them leaves the padlocks
    // on screen describing a moment that has passed.
    const { result } = await openWith([entry("a.uasset")]);
    mockRepoStatus.mockResolvedValue(status());
    mockListDir.mockResolvedValue([entry("a.uasset")]);
    mockListLocks.mockClear();
    mockListLocks.mockResolvedValue([{ path: "a.uasset", owner: "daniel", since: null }]);

    await act(async () => {
      await result.current.refreshStatus(true);
    });

    await waitFor(() => expect(mockListLocks).toHaveBeenCalled());
    await waitFor(() => expect(result.current.locks.get("a.uasset")?.owner).toBe("daniel"));
  });

  it("marks locks unknown when they cannot be read, not 'none held'", async () => {
    // The safety-critical distinction. Locks live on the host, so a disconnected session
    // cannot answer — and reporting "no locks" would tell an artist a file is free when a
    // colleague may be holding it.
    const { result } = await openWith([entry("a.uasset")]);
    mockListLocks.mockRejectedValue(new Error("Disconnected from server"));

    await act(async () => {
      await result.current.refreshLocks();
    });

    expect(result.current.locksAvailable).toBe(false);
    expect(result.current.locks.size).toBe(0);
  });

  it("indexes locks by path once they can be read", async () => {
    const { result } = await openWith([entry("a.uasset")]);
    mockListLocks.mockResolvedValue([
      { path: "a.uasset", owner: "daniel", since: null },
    ]);

    await act(async () => {
      await result.current.refreshLocks();
    });

    expect(result.current.locksAvailable).toBe(true);
    expect(result.current.locks.get("a.uasset")?.owner).toBe("daniel");
  });

  it("does not repeat the same lock warning on every automatic refresh", async () => {
    // The focus handler refreshes automatically. Announcing an offline lock failure each
    // time would bury every other event in the feed.
    const events: string[] = [];
    mockOpenRepo.mockResolvedValue({
      path: "/repo",
      status: status(),
      branches: { names: ["main"], current: "main", remote_only: [] },
    });
    mockListDir.mockResolvedValue([entry("a.uasset")]);
    const hook = renderHook(() => useRepository((_l, m) => void events.push(m)));
    await act(async () => {
      await hook.result.current.open("/repo");
    });

    mockListLocks.mockRejectedValue(new Error("Disconnected from server"));

    await act(async () => {
      await hook.result.current.refreshLocks(false);
    });
    const afterFirst = events.filter((m) => m.includes("Could not check locks")).length;

    await act(async () => {
      await hook.result.current.refreshLocks(false);
      await hook.result.current.refreshLocks(false);
    });
    const afterMore = events.filter((m) => m.includes("Could not check locks")).length;

    expect(afterMore).toBe(afterFirst);
  });

  it("still reports a lock failure when the user asks explicitly", async () => {
    const events: string[] = [];
    mockOpenRepo.mockResolvedValue({
      path: "/repo",
      status: status(),
      branches: { names: ["main"], current: "main", remote_only: [] },
    });
    mockListDir.mockResolvedValue([entry("a.uasset")]);
    const hook = renderHook(() => useRepository((_l, m) => void events.push(m)));
    await act(async () => {
      await hook.result.current.open("/repo");
    });

    mockListLocks.mockRejectedValue(new Error("Disconnected from server"));
    await act(async () => {
      await hook.result.current.refreshLocks(true);
      await hook.result.current.refreshLocks(true);
    });

    // Silence on an explicit click would look like the button did nothing.
    expect(events.filter((m) => m.includes("Could not check locks")).length).toBe(2);
  });

  it("queries locks for the current branch", async () => {
    const { result } = await openWith([entry("a.uasset")]);
    mockListLocks.mockResolvedValue([]);

    await act(async () => {
      await result.current.refreshLocks();
    });

    // Per branch, because `lore lock query --path` is rejected outright.
    expect(mockListLocks).toHaveBeenCalledWith("/repo", "main");
  });

  it("closing clears the repository and everything derived from it", async () => {
    const { result } = await openWith([entry("a.txt")]);
    mockListLocks.mockResolvedValue([{ path: "a.txt", owner: "ale", since: null }]);
    await act(async () => {
      await result.current.refreshLocks();
    });
    act(() => result.current.setSelected("a.txt"));

    act(() => result.current.close());

    expect(result.current.info).toBeNull();
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.selected).toBeNull();
    // Lock state must not survive the repository it described — stale locks shown against
    // a different repo would be worse than none.
    expect(result.current.locks.size).toBe(0);
    expect(result.current.locksAvailable).toBe(false);
  });

  it("a listing still in flight when the repository closes does not repopulate it", async () => {
    // The generation guard. Without it a slow directory read lands after the close and
    // resurrects a tree for a repository the user has left.
    const { result } = await openWith([entry("a.txt")]);

    let release!: (v: unknown) => void;
    mockListDir.mockImplementation(() => new Promise((r) => (release = r)));

    const pending = act(async () => {
      await result.current.toggle(entry("dir", true));
    });
    act(() => result.current.close());
    release([entry("late.txt")]);
    await pending;

    expect(result.current.info).toBeNull();
    expect(result.current.rows).toHaveLength(0);
  });

  it("reports an open failure instead of leaving a half-open repository", async () => {
    mockOpenRepo.mockRejectedValue("/nope is not a Lore repository — it has no .lore folder.");

    const { result } = renderHook(() => useRepository());
    await act(async () => {
      await result.current.open("/nope");
    });

    expect(result.current.info).toBeNull();
    expect(result.current.error).toContain("not a Lore repository");
    expect(result.current.rows).toHaveLength(0);
  });

  it("builds the changed view from status paths rather than directory listings", async () => {
    const { result } = await openWith([entry("README.md")]);

    mockRepoStatus.mockResolvedValue(status(["Content/Characters/Hero.uasset"]));
    mockListDir.mockResolvedValue([entry("README.md")]);
    await act(async () => {
      await result.current.refreshStatus();
    });

    act(() => result.current.setMode("changed"));

    await waitFor(() =>
      expect(result.current.rows.map((r) => r.entry.name)).toEqual(["Content"]),
    );
  });
});
