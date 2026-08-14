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
const mockPush = vi.fn();

vi.mock("../lib/repo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/repo")>();
  return {
    ...actual,
    openRepo: (...a: unknown[]) => mockOpenRepo(...a),
    repoStatus: (...a: unknown[]) => mockRepoStatus(...a),
    listDir: (...a: unknown[]) => mockListDir(...a),
    listLocks: (...a: unknown[]) => mockListLocks(...a),
    pushRepo: (...a: unknown[]) => mockPush(...a),
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
  mockPush.mockReset();
});

async function openWith(rootEntries: ReturnType<typeof entry>[], identity?: string) {
  mockOpenRepo.mockResolvedValue({
    path: "/repo",
    status: status(),
    branches: { names: ["main"], current: "main", remote_only: [] },
    identity: identity ?? null,
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

    // Per branch, because `lore lock query --path` is rejected outright. The third argument
    // is the identity to attribute ownership to; null with nobody signed in, which the
    // backend reads as "cannot tell" rather than "nobody". The fourth is the accounts this
    // machine knows, used to label a holder with the name the user recognises.
    expect(mockListLocks).toHaveBeenCalledWith("/repo", "main", null, []);
  });

  it("attributes locks to the identity the working copy is pinned to", async () => {
    // A pinned working copy acts as its own user whatever the machine is signed in as —
    // that is the entire point of pinning — so it must win here too. Getting this backwards
    // would show one clone's locks as another person's on the same machine.
    const { result } = await openWith([entry("a.uasset")], "u-99f5f8484b0a47fd");
    mockListLocks.mockResolvedValue([]);

    act(() => result.current.setSignedInAs("u-signed-in"));
    await act(async () => {
      await result.current.refreshLocks();
    });

    expect(mockListLocks).toHaveBeenLastCalledWith("/repo", "main", "u-99f5f8484b0a47fd", []);
  });

  it("sends the raw id for ownership, never the name built for error messages", async () => {
    // The bug this pins, seen live: `setRepoIdentity` carries what `nameForId` produced —
    // "uitest (u-99f5f8484b0a47fd)" — because it exists to be *read*, in a sentence about a
    // sign-in that went wrong. Passed to `lock query --owner` it matches no account, so every
    // lock the user held came back unattributed and was rendered as a colleague's, offering
    // to break locks they already owned.
    const { result } = await openWith([entry("a.uasset")], "u-99f5f8484b0a47fd");
    mockListLocks.mockResolvedValue([]);

    act(() => result.current.setRepoIdentity("uitest (u-99f5f8484b0a47fd)"));
    await act(async () => {
      await result.current.refreshLocks();
    });

    const sent = mockListLocks.mock.lastCall?.[2];
    expect(sent).toBe("u-99f5f8484b0a47fd");
    expect(sent).not.toContain(" ");
  });

  it("falls back to the signed-in identity when the working copy pins none", async () => {
    const { result } = await openWith([entry("a.uasset")]);
    mockListLocks.mockResolvedValue([]);

    act(() => result.current.setSignedInAs("u-signed-in"));
    await act(async () => {
      await result.current.refreshLocks();
    });

    expect(mockListLocks).toHaveBeenLastCalledWith("/repo", "main", "u-signed-in", []);
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

describe("attribution against a host with no identity provider", () => {
  it("asks nobody, even when the working copy is pinned to someone", async () => {
    // Reported from testing, against the LAN host that has no auth:
    //   $ lore lock query --branch main --owner u-99f5f8484b0a47fd   exit 255
    //   [Error] Failed to resolve user id from user name:
    //           Operation not supported: No authentication configured on server
    //
    // ~/demo-fedora was cloned while a ctone account was selected, so its config carries
    // identity = "u-99f5…" — an account that host has never heard of. A pinned identity is
    // meaningless where there is nothing to resolve it against.
    const { result } = await openWith([entry("a.uasset")], "u-99f5f8484b0a47fd");
    mockListLocks.mockResolvedValue([]);

    act(() => result.current.setCanAttribute(false));
    await act(async () => {
      await result.current.refreshLocks();
    });

    expect(mockListLocks).toHaveBeenLastCalledWith("/repo", "main", null, []);
  });

  it("still attributes normally on a host that can resolve users", async () => {
    const { result } = await openWith([entry("a.uasset")], "u-99f5f8484b0a47fd");
    mockListLocks.mockResolvedValue([]);

    act(() => result.current.setCanAttribute(true));
    await act(async () => {
      await result.current.refreshLocks();
    });

    expect(mockListLocks).toHaveBeenLastCalledWith("/repo", "main", "u-99f5f8484b0a47fd", []);
  });
});

describe("overlapping refreshes", () => {
  /**
   * Observed against a host that had gone to sleep:
   *
   *   $ lore status --scan  22.4s exit 0
   *   $ lore status --scan  19.2s exit 0
   *   $ lore status --scan  10.3s exit 0
   *
   * Three reads stacked, each waiting its own deadline, because nothing noticed the first
   * had not returned. Window focus fires a refresh, the refresh button fires one, and every
   * write ends with one — so overlap is the ordinary case, and against an unresponsive host
   * the waits simply add up.
   */
  const deferred = () => {
    let resolve!: (v: unknown) => void;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };

  it("runs one read at a time instead of stacking them", async () => {
    const { result } = await openWith([entry("a.txt")]);
    mockRepoStatus.mockClear();
    mockListDir.mockResolvedValue([entry("a.txt")]);
    mockListLocks.mockResolvedValue([]);

    const slow = deferred();
    mockRepoStatus.mockReturnValue(slow.promise);

    // Three arrive while the first is still outstanding — the reported case exactly.
    await act(async () => {
      void result.current.refreshStatus();
      void result.current.refreshStatus();
      void result.current.refreshStatus();
      await Promise.resolve();
    });

    expect(mockRepoStatus).toHaveBeenCalledTimes(1);

    // Releasing the first runs exactly one follow-up for everything asked meanwhile — not
    // one per caller.
    mockRepoStatus.mockResolvedValue(status());
    await act(async () => {
      slow.resolve(status());
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockRepoStatus).toHaveBeenCalledTimes(2);
  });

  it("does not announce the queued follow-up", async () => {
    // The user asked once; hearing about it twice is noise, and the second is not a thing
    // they did.
    const events: string[] = [];
    mockOpenRepo.mockResolvedValue({
      path: "/repo",
      status: status(),
      branches: { names: ["main"], current: "main", remote_only: [] },
      identity: null,
    });
    mockListDir.mockResolvedValue([entry("a.txt")]);
    mockListLocks.mockResolvedValue([]);
    const hook = renderHook(() => useRepository((_l, m) => void events.push(m)));
    await act(async () => {
      await hook.result.current.open("/repo");
    });

    const slow = deferred();
    mockRepoStatus.mockReturnValue(slow.promise);
    await act(async () => {
      void hook.result.current.refreshStatus(true);
      void hook.result.current.refreshStatus(true);
      await Promise.resolve();
    });
    mockRepoStatus.mockResolvedValue(status());
    await act(async () => {
      slow.resolve(status());
      await new Promise((r) => setTimeout(r, 0));
    });

    // One lock announcement at most, from the read the user actually asked for.
    expect(events.filter((m) => /locked/i.test(m)).length).toBeLessThanOrEqual(1);
  });
});

describe("a write that failed because the host was away", () => {
  it("is remembered, so it can be raised when the host comes back", async () => {
    // Observed: a push made 75 seconds after a service restart silently did not happen.
    // Nothing was lost — the commit stayed local, the branch read "ahead" — but the only
    // account of the failure was one line in a feed, and the host returned minutes later.
    const { result } = await openWith([entry("a.txt")]);
    mockPush.mockRejectedValue(new Error("[Error] Disconnected from server"));

    await act(async () => {
      await result.current.push();
    });

    expect(result.current.pendingWrite).toBe("Push");
  });

  it("is not remembered when the host answered and refused", async () => {
    // A rejected push is not waiting for anything; raising it later would be wrong.
    const { result } = await openWith([entry("a.txt")]);
    mockPush.mockRejectedValue(new Error("Not authorized to access repository"));

    await act(async () => {
      await result.current.push();
    });

    expect(result.current.pendingWrite).toBeNull();
  });

  it("is forgotten once a write succeeds", async () => {
    const { result } = await openWith([entry("a.txt")]);
    mockPush.mockRejectedValue(new Error("Disconnected from server"));
    await act(async () => {
      await result.current.push();
    });
    expect(result.current.pendingWrite).toBe("Push");

    mockPush.mockResolvedValue(status());
    await act(async () => {
      await result.current.push();
    });
    expect(result.current.pendingWrite).toBeNull();
  });
});
