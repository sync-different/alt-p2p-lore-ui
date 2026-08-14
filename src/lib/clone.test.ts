import { describe, expect, it } from "vitest";
import { cloneStatus, formatBytes, formatElapsed, formatRate } from "./clone";

/**
 * The rule this is built around: `lore clone` reports nothing until it finishes, so the only
 * honest signal is the folder growing. A percentage is shown only when there is something real
 * to divide by, and never invented.
 */

describe("cloneStatus", () => {
  const base = { startedAt: 1_000, now: 11_000 }; // ten seconds in

  it("has no percentage when there is nothing to divide by", () => {
    // The first clone of a repository. A bar that moves without knowing the total is a lie.
    const s = cloneStatus({ ...base, bytes: 100_000_000 });
    expect(s.percent).toBeNull();
    expect(s.estimated).toBe(false);
  });

  it("still reports bytes and a rate, which is what says it is alive", () => {
    const s = cloneStatus({ ...base, bytes: 100_000_000 });
    expect(s.bytes).toBe(100_000_000);
    expect(s.rate).toBeCloseTo(10_000_000, -3);
    expect(s.elapsedSeconds).toBe(10);
  });

  it("estimates against a previous clone of the same repository", () => {
    const s = cloneStatus({ ...base, bytes: 500_000_000, estimateBytes: 2_000_000_000 });
    expect(s.percent).toBeCloseTo(25, 1);
    expect(s.estimated).toBe(true);
    expect(s.eta).toBeGreaterThan(0);
  });

  it("lets a total the clone reported itself reach 100%", () => {
    // Once lore's own progress bar gives a total, holding the bar at 99 would look stuck at
    // the moment it finishes.
    const s = cloneStatus({
      ...base,
      bytes: 2_000_000_000,
      estimateBytes: 2_000_000_000,
      totalKnown: true,
    });
    expect(s.percent).toBe(100);
    expect(s.estimated).toBe(false);
  });

  it("never lets an estimate reach the end on its own", () => {
    // An estimate that hits 100% while the process is still running looks stuck, and one that
    // overshoots looks broken. Completion is the process's word, not arithmetic.
    const s = cloneStatus({ ...base, bytes: 3_000_000_000, estimateBytes: 2_000_000_000 });
    expect(s.percent).toBe(99);
  });

  it("prefers a reported percentage over any guess", () => {
    // If a future lore does emit one, it is not an estimate and must not be labelled as one.
    const s = cloneStatus({ ...base, bytes: 1, reportedPercent: 42, estimateBytes: 2_000 });
    expect(s.percent).toBe(42);
    expect(s.estimated).toBe(false);
  });

  it("does not compute a rate before there is anything to measure", () => {
    // A rate from the first half-second is noise, and an ETA from it is nonsense.
    expect(cloneStatus({ startedAt: 1_000, now: 1_200, bytes: 5 }).rate).toBeNull();
    expect(cloneStatus({ ...base, bytes: 0 }).rate).toBeNull();
  });
});

describe("formatting", () => {
  it("reads the way a person would say it", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_147_483_648)).toBe("2.0 GB");
    expect(formatBytes(340 * 1024 * 1024)).toBe("340 MB");
    expect(formatRate(21_000_000)).toBe("20 MB/s");
    expect(formatElapsed(45)).toBe("45s");
    expect(formatElapsed(100)).toBe("1m 40s");
  });
});
