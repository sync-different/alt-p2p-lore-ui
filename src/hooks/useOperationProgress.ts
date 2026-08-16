import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * A sample from the backend's operation monitor (see `src-tauri/src/lore/progress.rs`), emitted
 * every ~800ms while a `sync` or `commit` runs — the two long, data-moving operations that,
 * unlike clone, print nothing parseable while they work. Without this a large sync is
 * indistinguishable from a hang, which was a real report.
 */
export interface OperationProgress {
  /** Working-copy path, so two operations at once cannot be confused. */
  path: string;
  op: "sync" | "commit" | "reset" | "switch" | "abort" | "resolve" | "scan";
  /** Bytes on disk in the working copy. Grows through a sync; roughly flat through a commit. */
  bytes: number;
  /** `.~loretemp` files in flight — files being written but not yet renamed into place. */
  temp_files: number;
  elapsed_ms: number;
  done: boolean;
}

/**
 * The live view of a sync/commit in flight for one workspace: elapsed time, bytes landed, files
 * in flight, and — for a sync, where bytes actually grow — a smoothed transfer rate derived from
 * the change between samples (the backend reports no rate; the CLI reports nothing at all).
 */
export interface OperationView {
  op: "sync" | "commit" | "reset" | "switch" | "abort" | "resolve" | "scan";
  /** Total working-copy bytes on disk right now (includes files already present before sync). */
  bytes: number;
  /**
   * Bytes that have landed *since this operation started* — the working copy's growth from the
   * first sample. This, not the absolute size, is what the user reads as "downloaded so far": a
   * 6.8 GB working copy pulling a 300 MB delta should show 300 MB, not 6.8 GB. A sync that only
   * deletes files leaves this at 0, which is honest — nothing was received.
   */
  received: number;
  tempFiles: number;
  elapsedSeconds: number;
  /** Bytes/second over the last few samples, or null before there is a delta to divide. */
  rate: number | null;
}

/**
 * Subscribe to `operation://progress` for one workspace path and operation, returning the latest
 * view or null when nothing is in flight. Clears on the terminal `done` event — the status panel
 * updates itself the moment the command returns, so a finished operation should stop showing
 * progress rather than freeze on its last frame.
 *
 * The rate is smoothed here rather than in the backend: it needs the *history* of samples, which
 * is state the monitor deliberately does not keep (it is stateless and re-measures each tick).
 */
export function useOperationProgress(
  path: string | undefined,
  op: "sync" | "commit" | "reset" | "switch" | "abort" | "resolve" | "scan",
): OperationView | null {
  const [view, setView] = useState<OperationView | null>(null);
  // Working-copy size at the first sample of THIS operation — the floor "received" grows from.
  const baseline = useRef<number | null>(null);
  // Highest bytes-on-disk seen this operation. The disk measurement can dip for a tick when it
  // races a file being renamed (a `.~loretemp` vanishing mid-walk); a received counter must
  // never go backwards, so everything reads from this high-water mark.
  const peak = useRef(0);
  // The last elapsed time seen. A new operation restarts its clock near zero, which is how a
  // fresh run is told apart from the same one continuing — keyed to the operation, not to the
  // React subscription, so a re-render/re-subscribe can never reset the counter mid-run.
  const lastElapsed = useRef(Infinity);

  useEffect(() => {
    if (!path) return;
    // Deliberately NOT resetting baseline/peak/view here. The workspace re-reads its status at
    // the end of every write, which re-renders this component; resetting on that re-subscribe
    // zeroed the counter and blanked the whole line for a tick — the "appears and disappears"
    // reported live. A genuinely new operation is detected by its elapsed clock below.
    const un = listen<OperationProgress>("operation://progress", (e) => {
      const p = e.payload;
      if (p.path !== path || p.op !== op) return;

      if (p.done) {
        setView(null);
        baseline.current = null;
        peak.current = 0;
        lastElapsed.current = Infinity;
        return;
      }

      // New operation: its elapsed restarted below what we last saw → fresh baseline and peak.
      if (p.elapsed_ms < lastElapsed.current) {
        baseline.current = p.bytes;
        peak.current = 0;
      }
      lastElapsed.current = p.elapsed_ms;
      if (baseline.current === null) baseline.current = p.bytes;

      peak.current = Math.max(peak.current, p.bytes);
      const bytes = peak.current;
      const received = Math.max(0, bytes - baseline.current);
      const elapsedSeconds = p.elapsed_ms / 1000;

      // Cumulative average, the same shape clone uses: a sliding window went null on every tick
      // the host stalled and reappeared on the next burst, which read as the speed flickering in
      // and out. received/elapsed is always a number once data has moved — it drifts down
      // honestly during a stall rather than blinking. Commit (flat bytes) stays null.
      const rate =
        op !== "commit" && op !== "scan" && received > 0 && elapsedSeconds > 0.5 ? received / elapsedSeconds : null;

      setView({ op: p.op, bytes, received, tempFiles: p.temp_files, elapsedSeconds, rate });
    });

    return () => void un.then((f) => f());
  }, [path, op]);

  return path ? view : null;
}
