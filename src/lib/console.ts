/**
 * The console feed: what it contains, in what order, and in what colour.
 *
 * Two streams end up on one screen — the app's own notices, and a trace of every `lore`
 * process it spawns — and they answer different questions. A notice says what happened in the
 * user's terms ("Locked 1 file"); a trace says what the app actually did about it
 * (`lock acquire Daniel/Test.txt`, 214ms, exit 0). Read together they turn "it didn't work"
 * into a report somebody can act on, which is the entire reason for the panel.
 *
 * Kept pure and separate from the component so the merge, the cap and the colours can be
 * tested without a DOM — the same reason the rest of `lib/` exists.
 */

import type { Notice, NoticeLevel } from "../types/app";

/** One `lore` invocation, as the backend reports it on `lore://command`. */
export interface LoreTrace {
  /** Already redacted in Rust — never re-derive this from raw arguments. */
  command: string;
  cwd: string;
  ms: number;
  code: number | null;
  ok: boolean;
  /** First line of stderr, when it failed. */
  error: string | null;
}

export interface TraceLine extends LoreTrace {
  id: string;
  at: number;
}

/**
 * One raw line from a tunnel process, as the supervisor forwards it on `tunnel://output`.
 *
 * The supervisor parses stdout into typed events and keeps a bounded stderr tail for the exit
 * message; everything else used to be discarded, so a connection that failed in an unfamiliar
 * way left only the app's own summary. Reported from testing: "The connection to the host
 * ended" with nothing to act on.
 */
export interface TunnelLine {
  id: string;
  at: number;
  session_name: string;
  stream: "out" | "err";
  level: "info" | "warn" | "error";
  /** Already scrubbed in Rust. */
  line: string;
}

/**
 * One line of a `lore` command's own output, streamed live on `lore://output`.
 *
 * The trace is one line *per command* — what ran and how it ended. This is the command's own
 * narration *while* it runs: `Fragmenting files…`, `Synchronizing to revision…`, a warning. For
 * the long flows (clone, commit, sync) that is the difference between a console that explains a
 * minute-long operation and one that goes quiet until it is over.
 */
export interface LoreOutputLine {
  /** The redacted command these lines belong to, so they can be attributed. */
  command: string;
  stream: "out" | "err";
  /** Already scrubbed in Rust. */
  line: string;
}

export interface OutputLine extends LoreOutputLine {
  id: string;
  at: number;
}

export type ConsoleLine =
  | { kind: "notice"; id: string; at: number; notice: Notice }
  | { kind: "trace"; id: string; at: number; trace: TraceLine }
  | { kind: "tunnel"; id: string; at: number; tunnel: TunnelLine }
  | { kind: "output"; id: string; at: number; output: OutputLine };

/** Which stream a line belongs to, for the filter tabs. */
export type ConsoleFilter = "all" | "problems" | "debug";

/**
 * Colour for a line, as Tailwind text classes.
 *
 * Three colours carry meaning and everything else is deliberately quiet: red is *this failed*,
 * amber is *this needs your attention*, green is *this worked*. A palette where everything is
 * coloured is one where nothing stands out, which defeats the point of a feed people scan.
 */
export const LEVEL_COLOUR: Record<NoticeLevel, string> = {
  error: "text-danger",
  warn: "text-warn",
  success: "text-ok",
  info: "text-ok",
};

/** The four-letter tag at the start of a line. Fixed width, so the messages align. */
export const LEVEL_TAG: Record<NoticeLevel, string> = {
  error: "ERR ",
  warn: "WARN",
  success: "INFO",
  info: "INFO",
};

/** A failed command is an error line even though the trace stream is otherwise dim. */
export function traceColour(t: LoreTrace): string {
  return t.ok ? "text-ink-2" : "text-danger";
}

/**
 * Merge the two streams, newest first.
 *
 * Newest-first rather than terminal order, because this panel is short and usually not
 * scrolled: the line you want is almost always the last thing that happened, and putting it
 * at the top means never having to chase it. The existing Activity feed made the same choice
 * for the same reason, and having two panels disagree about direction would be worse than
 * either convention.
 */
export function mergeFeed(
  notices: Notice[],
  traces: TraceLine[],
  filter: ConsoleFilter,
  debugEnabled: boolean,
  cap = 500,
  tunnel: TunnelLine[] = [],
  output: OutputLine[] = [],
): ConsoleLine[] {
  const lines: ConsoleLine[] = [];

  if (filter !== "debug") {
    for (const n of notices) {
      if (filter === "problems" && n.level !== "warn" && n.level !== "error") continue;
      lines.push({ kind: "notice", id: n.id, at: n.at, notice: n });
    }
  }

  // Debug streams appear only with debug on — except a *failed* command or an error line from
  // a tunnel, which are problems in their own right and are exactly what someone filtering for
  // problems is looking for.
  if (debugEnabled) {
    if (filter === "problems") {
      for (const t of traces) {
        if (!t.ok) lines.push({ kind: "trace", id: t.id, at: t.at, trace: t });
      }
      for (const t of tunnel) {
        if (t.level === "error") lines.push({ kind: "tunnel", id: t.id, at: t.at, tunnel: t });
      }
      // A line lore sent to stderr is the command telling you something went wrong as it ran —
      // exactly what a problems filter is for. Its stdout narration is not.
      for (const o of output) {
        if (o.stream === "err") lines.push({ kind: "output", id: o.id, at: o.at, output: o });
      }
    } else {
      for (const t of traces) lines.push({ kind: "trace", id: t.id, at: t.at, trace: t });
      for (const t of tunnel) lines.push({ kind: "tunnel", id: t.id, at: t.at, tunnel: t });
      for (const o of output) lines.push({ kind: "output", id: o.id, at: o.at, output: o });
    }
  }

  lines.sort((a, b) => b.at - a.at);
  return lines.slice(0, cap);
}

/** Colour for a streamed output line: stderr reads as attention, stdout stays quiet. */
export function outputColour(o: LoreOutputLine): string {
  return o.stream === "err" ? "text-warn" : "text-ink-2";
}

/** Colour for a tunnel line: quiet unless its own logger said otherwise. */
export function tunnelColour(t: TunnelLine): string {
  if (t.level === "error") return "text-danger";
  if (t.level === "warn") return "text-warn";
  return "text-ink-2";
}

/** `214ms` / `1.4s` — a duration that reads at a glance rather than one that is precise. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** How many lines a "problems" badge should count. */
export function problemCount(
  notices: Notice[],
  traces: TraceLine[],
  debugEnabled: boolean,
  tunnel: TunnelLine[] = [],
): number {
  const bad = notices.filter((n) => n.level === "warn" || n.level === "error").length;
  if (!debugEnabled) return bad;
  return (
    bad + traces.filter((t) => !t.ok).length + tunnel.filter((t) => t.level === "error").length
  );
}
