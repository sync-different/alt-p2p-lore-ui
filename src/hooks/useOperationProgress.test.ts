import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOperationProgress, type OperationProgress } from "./useOperationProgress";

/**
 * The rate and "received" derivations, and the clear-on-done behaviour.
 *
 * These are the parts with logic: the backend reports absolute bytes-on-disk and no rate, and
 * this hook turns that into "downloaded this sync" (growth from a baseline) and a smoothed
 * bytes/second. Both are easy to get subtly wrong — showing the whole 6.8 GB working copy as if
 * it were the download, or a rate that swings every tick — so both are pinned here.
 */

const handlers: Array<(e: { payload: OperationProgress }) => void> = [];
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (e: { payload: OperationProgress }) => void) => {
    handlers.push(handler);
    return Promise.resolve(unlisten);
  },
}));

function emit(p: Partial<OperationProgress> & Pick<OperationProgress, "path" | "op">) {
  const payload: OperationProgress = {
    bytes: 0,
    temp_files: 0,
    elapsed_ms: 0,
    done: false,
    ...p,
  };
  act(() => {
    for (const h of handlers) h({ payload });
  });
}

beforeEach(() => {
  handlers.length = 0;
  unlisten.mockClear();
});

describe("useOperationProgress", () => {
  it("reports bytes received as growth from the first sample, not the absolute size", () => {
    const { result } = renderHook(() => useOperationProgress("/wc", "sync"));

    // A 6.8 GB working copy that has just started pulling a delta.
    emit({ path: "/wc", op: "sync", bytes: 6_800_000_000, elapsed_ms: 800 });
    expect(result.current?.received).toBe(0);

    // 300 MB has landed since.
    emit({ path: "/wc", op: "sync", bytes: 6_800_000_000 + 300_000_000, elapsed_ms: 1600 });
    expect(result.current?.received).toBe(300_000_000);
    expect(result.current?.bytes).toBe(6_800_000_000 + 300_000_000);
  });

  it("derives a transfer rate from the change between samples on a sync", () => {
    const { result } = renderHook(() => useOperationProgress("/wc", "sync"));
    emit({ path: "/wc", op: "sync", bytes: 0, elapsed_ms: 0 });
    // 10 MB over 1 second → 10 MB/s.
    emit({ path: "/wc", op: "sync", bytes: 10_000_000, elapsed_ms: 1000 });
    expect(result.current?.rate).toBeCloseTo(10_000_000, -3);
  });

  it("reports no rate for a commit, whose bytes do not grow", () => {
    const { result } = renderHook(() => useOperationProgress("/wc", "commit"));
    emit({ path: "/wc", op: "commit", bytes: 5_000, elapsed_ms: 800 });
    emit({ path: "/wc", op: "commit", bytes: 5_000, elapsed_ms: 1600 });
    expect(result.current?.rate).toBeNull();
    expect(result.current?.received).toBe(0);
    // Elapsed still advances, which is a commit's only honest signal.
    expect(result.current?.elapsedSeconds).toBeCloseTo(1.6);
  });

  it("ignores events for other workspaces and other operations", () => {
    const { result } = renderHook(() => useOperationProgress("/wc", "sync"));
    emit({ path: "/other", op: "sync", bytes: 999, elapsed_ms: 800 });
    emit({ path: "/wc", op: "commit", bytes: 999, elapsed_ms: 800 });
    expect(result.current).toBeNull();
  });

  it("clears when the terminal done event arrives", () => {
    const { result } = renderHook(() => useOperationProgress("/wc", "sync"));
    emit({ path: "/wc", op: "sync", bytes: 100, elapsed_ms: 800 });
    expect(result.current).not.toBeNull();
    emit({ path: "/wc", op: "sync", bytes: 200, elapsed_ms: 1600, done: true });
    expect(result.current).toBeNull();
  });

  it("resets the baseline for a second run so received starts from zero again", () => {
    const { result } = renderHook(() => useOperationProgress("/wc", "sync"));
    // First sync.
    emit({ path: "/wc", op: "sync", bytes: 1_000, elapsed_ms: 800 });
    emit({ path: "/wc", op: "sync", bytes: 1_500, elapsed_ms: 1600, done: true });
    // Second sync of the same, now-larger working copy: received must measure from the new
    // baseline, not from the first run's, or every later sync would look enormous.
    emit({ path: "/wc", op: "sync", bytes: 1_500, elapsed_ms: 800 });
    expect(result.current?.received).toBe(0);
    emit({ path: "/wc", op: "sync", bytes: 1_700, elapsed_ms: 1600 });
    expect(result.current?.received).toBe(200);
  });

  it("never lets received go backwards on a transient measurement dip (no flicker)", () => {
    // Reported live: the byte counter "appears and disappears". The backend's disk measurement
    // dips for one tick when it races a file being renamed, which used to drop received to a
    // value that read as a blink. A download counter must be monotonic.
    const { result } = renderHook(() => useOperationProgress("/wc", "sync"));
    emit({ path: "/wc", op: "sync", bytes: 1_000, elapsed_ms: 800 }); // baseline 1000
    emit({ path: "/wc", op: "sync", bytes: 1_000 + 500_000, elapsed_ms: 1600 });
    expect(result.current?.received).toBe(500_000);
    // A dip below the peak — a temp mid-rename. Must hold, not blink to 200k.
    emit({ path: "/wc", op: "sync", bytes: 1_000 + 200_000, elapsed_ms: 2400 });
    expect(result.current?.received).toBe(500_000);
    // Then it climbs past the previous peak.
    emit({ path: "/wc", op: "sync", bytes: 1_000 + 800_000, elapsed_ms: 3200 });
    expect(result.current?.received).toBe(800_000);
  });
});
