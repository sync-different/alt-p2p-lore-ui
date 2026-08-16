import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Notice } from "../types/app";
import {
  LEVEL_COLOUR,
  LEVEL_TAG,
  formatMs,
  mergeFeed,
  outputColour,
  problemCount,
  traceColour,
  tunnelColour,
  type ConsoleFilter,
  type OutputLine,
  type TraceLine,
  type TunnelLine,
} from "../lib/console";

/**
 * The console: what the app did, and what it ran to do it.
 *
 * Across the bottom rather than down the side, because the lines are *long* — a command with
 * a path and flags, or a sentence explaining a failure — and a 288px column turned every one
 * of them into four wrapped fragments. Width is what this content needs; the file tree and
 * the file view both want height, and they were the ones paying for it.
 *
 * Monospace throughout, including the prose. Mixing proportional notices with monospace
 * commands in one feed makes the columns disagree line by line, and the alignment of the
 * level tags is what makes a long feed scannable at all.
 */

const MIN_HEIGHT = 80;
const MAX_HEIGHT = 560;
const DEFAULT_HEIGHT = 200;

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function Console({
  notices,
  traces,
  tunnel = [],
  output = [],
  debugEnabled,
  onClear,
  onOpenSettings,
}: {
  notices: Notice[];
  traces: TraceLine[];
  /** Raw output from tunnel processes. */
  tunnel?: TunnelLine[];
  /** Live per-line output from lore commands (clone/commit/sync/push narration). */
  output?: OutputLine[];
  debugEnabled: boolean;
  onClear: () => void;
  onOpenSettings: () => void;
}) {
  const [filter, setFilter] = useState<ConsoleFilter>("all");
  const [collapsed, setCollapsed] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const drag = useRef<{ y: number; h: number } | null>(null);

  // Debug switched off with the Debug tab showing would leave an empty panel and no clue why.
  useEffect(() => {
    if (!debugEnabled && filter === "debug") setFilter("all");
  }, [debugEnabled, filter]);

  const lines = useMemo(
    () => mergeFeed(notices, traces, filter, debugEnabled, 500, tunnel, output),
    [notices, traces, filter, debugEnabled, tunnel, output],
  );
  const problems = problemCount(notices, traces, debugEnabled, tunnel);

  // Dragging the top edge. Listeners live on the window, not the handle, so the pointer may
  // leave the 4px strip mid-drag without the resize stopping dead.
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      drag.current = { y: e.clientY, h: height };
      e.preventDefault();
    },
    [height],
  );
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!drag.current) return;
      const next = drag.current.h + (drag.current.y - e.clientY);
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, next)));
    };
    const up = () => (drag.current = null);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  const tab = (id: ConsoleFilter, label: string, badge?: number) => (
    <button
      onClick={() => {
        setFilter(id);
        setCollapsed(false);
      }}
      className={`rounded px-2 py-0.5 ${
        filter === id && !collapsed ? "bg-surface-3 text-ink-0" : "text-ink-2 hover:text-ink-1"
      }`}
    >
      {label}
      {badge ? ` (${badge})` : ""}
    </button>
  );

  return (
    <div
      // `relative z-40` lifts the console above the modal backdrop (z-30), so it stays live and
      // scrollable while a dialog is open — a long clone or sync is exactly when you want to
      // read it. Modal dialog boxes are centred and short enough to clear it; the one tall one
      // (CloneDialog) caps its height so it never reaches down into this strip.
      className="relative z-40 flex shrink-0 flex-col border-t border-line bg-surface-1"
      style={{ height: collapsed ? undefined : height }}
    >
      {/* The drag handle doubles as the top border; hidden when collapsed, where there is
          nothing to resize. */}
      {!collapsed && (
        <div
          onPointerDown={onPointerDown}
          className="h-1 shrink-0 cursor-ns-resize hover:bg-accent/40"
          role="separator"
          aria-label="Resize console"
        />
      )}

      <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
        <span className="shrink-0 pr-1 text-[11px] uppercase tracking-wide text-ink-2">
          Console
        </span>

        {tab("all", "All")}
        {tab("problems", "Problems", problems)}
        {/* Present but disabled when debug is off, so the setting is discoverable from the
            place it applies rather than only from a menu. */}
        {debugEnabled ? (
          tab("debug", "Debug")
        ) : (
          <button
            onClick={onOpenSettings}
            title="Show the lore commands the app runs — enable in Settings"
            className="rounded px-2 py-0.5 text-ink-2/50 hover:text-ink-1"
          >
            Debug
          </button>
        )}

        <span className="ml-auto flex items-center gap-1">
          {/* Which build you are actually running.
              Version alone does not answer that — it changes when someone decides it should,
              while the question during testing is always "is this the binary I was just given?"
              Sat by Clear because that is the corner already reserved for things about the
              console rather than about the repository. */}
          <span
            className="px-1 text-ink-2 tabular-nums"
            title={`alt-lore Desktop ${__APP_VERSION__} · build ${__APP_BUILD__}`}
          >
            v{__APP_VERSION__} · build {__APP_BUILD__}
          </span>
          <button
            onClick={onClear}
            title="Clear the console"
            className="rounded px-1.5 py-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink-0"
          >
            Clear
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? "Show the console" : "Hide the console"}
            aria-label={collapsed ? "Show the console" : "Hide the console"}
            className="rounded px-1.5 py-0.5 text-ink-2 hover:bg-surface-2 hover:text-ink-0"
          >
            {collapsed ? "▲" : "▼"}
          </button>
        </span>
      </div>

      {!collapsed && (
        <div className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-mono text-[11px] leading-[1.6]">
          {lines.length === 0 ? (
            <p className="py-2 text-ink-2">
              {filter === "problems"
                ? "No problems."
                : filter === "debug"
                  ? "No commands yet."
                  : "Nothing yet."}
            </p>
          ) : (
            <ul>
              {lines.map((l) =>
                l.kind === "notice" ? (
                  <li key={l.id} className="flex gap-2 whitespace-pre-wrap break-words">
                    <span className="shrink-0 text-ink-2">{timeOf(l.at)}</span>
                    <span className={`shrink-0 ${LEVEL_COLOUR[l.notice.level]}`}>
                      {LEVEL_TAG[l.notice.level]}
                    </span>
                    <span className="selectable min-w-0 text-ink-1">
                      {l.notice.source && <span className="text-ink-2">[{l.notice.source}] </span>}
                      {l.notice.message}
                    </span>
                  </li>
                ) : l.kind === "tunnel" ? (
                  <li key={l.id} className="flex gap-2 whitespace-pre-wrap break-words">
                    <span className="shrink-0 text-ink-2">{timeOf(l.at)}</span>
                    {/* The stream, not a severity: Java logs progress to stderr, so marking
                        every stderr line as a failure would paint a healthy connect red. */}
                    <span className={`shrink-0 ${tunnelColour(l.tunnel)}`}>
                      {l.tunnel.stream === "err" ? "TUN!" : "TUN "}
                    </span>
                    <span className="selectable min-w-0 text-ink-2">
                      {l.tunnel.session_name && (
                        <span className="text-ink-2">[{l.tunnel.session_name}] </span>
                      )}
                      <span className={l.tunnel.level === "info" ? "text-ink-1" : tunnelColour(l.tunnel)}>
                        {l.tunnel.line}
                      </span>
                    </span>
                  </li>
                ) : l.kind === "output" ? (
                  <li key={l.id} className="flex gap-2 whitespace-pre-wrap break-words">
                    <span className="shrink-0 text-ink-2">{timeOf(l.at)}</span>
                    {/* The command's own narration as it runs. The stream, not a severity:
                        lore prints ordinary progress to stdout and warnings to stderr, so an
                        stderr line reads as attention but not as a failure. */}
                    <span className={`shrink-0 ${outputColour(l.output)}`}>
                      {l.output.stream === "err" ? "LOG!" : "LOG "}
                    </span>
                    <span className={`selectable min-w-0 ${l.output.stream === "err" ? "text-warn" : "text-ink-1"}`}>
                      {l.output.line}
                    </span>
                  </li>
                ) : (
                  <li key={l.id} className="flex gap-2 whitespace-pre-wrap break-words">
                    <span className="shrink-0 text-ink-2">{timeOf(l.at)}</span>
                    <span className={`shrink-0 ${traceColour(l.trace)}`}>
                      {l.trace.ok ? "DBG " : "ERR "}
                    </span>
                    <span className="selectable min-w-0 text-ink-2">
                      <span className="text-ink-1">$ lore {l.trace.command}</span>
                      {"  "}
                      {formatMs(l.trace.ms)}
                      {l.trace.code != null && ` exit ${l.trace.code}`}
                      {l.trace.error && (
                        <span className="text-danger">{`\n  ${l.trace.error}`}</span>
                      )}
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
