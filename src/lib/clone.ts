/**
 * Showing that a clone is moving, when the CLI will not say how far along it is.
 *
 * Established by experiment against ctone: through a pipe, `lore clone` prints five lines and
 * the summary `Cloned 2157/2157 files (2.00 GiB/2.00 GiB)` **only at the end**. There are no
 * carriage returns, `--log-level debug` adds 10,000 lines of other things, lore's own log file
 * records no progress, and `repository info` reports no size. A 2 GiB clone takes 100 seconds
 * and says nothing for 99 of them.
 *
 * So the progress here is *measured*, not reported: the destination folder growing on disk.
 * That gives bytes and a rate honestly, and a percentage only when we have something to divide
 * by — the size of a previous clone of the same repository. Marked as an estimate, because it
 * is one.
 */

const ESTIMATE_KEY = "alt-lore.clone-size";

/** Remember what a repository cost to clone, so the next clone of it can show a bar. */
export function rememberCloneSize(repoId: string, bytes: number) {
  if (!repoId || bytes <= 0) return;
  try {
    const all = JSON.parse(localStorage.getItem(ESTIMATE_KEY) ?? "{}");
    all[repoId] = bytes;
    localStorage.setItem(ESTIMATE_KEY, JSON.stringify(all));
  } catch {
    // A hint that cannot be stored is not worth failing a clone over.
  }
}

export function cloneSizeEstimate(repoId: string): number | null {
  try {
    const all = JSON.parse(localStorage.getItem(ESTIMATE_KEY) ?? "{}");
    const n = all[repoId];
    return typeof n === "number" && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(Math.max(0, Math.round(bytesPerSecond)))}/s`;
}

export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export interface CloneStatus {
  bytes: number;
  /** Null when there is nothing honest to divide by. */
  percent: number | null;
  estimated: boolean;
  rate: number | null;
  elapsedSeconds: number;
  eta: number | null;
}

/**
 * Everything the dialog shows, from a couple of samples.
 *
 * `startedAt` and `now` are passed in rather than read here so this stays a pure function —
 * the alternative is a progress display that can only be tested by waiting.
 */
export function cloneStatus(opts: {
  bytes: number;
  startedAt: number;
  now: number;
  /** A reported percentage, if the CLI ever gives one. It wins: it is not a guess. */
  reportedPercent?: number | null;
  estimateBytes?: number | null;
  /** True when the total came from the clone itself rather than from a previous one. */
  totalKnown?: boolean;
}): CloneStatus {
  const { bytes, startedAt, now, reportedPercent, estimateBytes, totalKnown } = opts;
  const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);
  const rate = elapsedSeconds > 1 && bytes > 0 ? bytes / elapsedSeconds : null;

  if (reportedPercent != null) {
    return { bytes, percent: reportedPercent, estimated: false, rate, elapsedSeconds, eta: null };
  }
  if (estimateBytes && estimateBytes > 0) {
    // Capped below 100: an estimate that reaches the end while the clone is still running
    // looks stuck, and one that overshoots looks broken. It finishes when the process says so.
    // Capped below 100 only while guessing: a known total may legitimately reach the end,
    // and holding it at 99 would look stuck at the moment it finishes.
    const raw = (bytes / estimateBytes) * 100;
    const percent = totalKnown ? Math.min(100, raw) : Math.min(99, raw);
    const remaining = Math.max(0, estimateBytes - bytes);
    return {
      bytes,
      percent,
      estimated: !totalKnown,
      rate,
      elapsedSeconds,
      eta: rate && rate > 0 ? remaining / rate : null,
    };
  }
  return { bytes, percent: null, estimated: false, rate, elapsedSeconds, eta: null };
}
