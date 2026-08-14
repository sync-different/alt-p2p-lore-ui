import { useMemo, useState } from "react";
import type { Notice } from "../types/app";
import { TONE_DOT, noticeTone } from "../lib/status";

/**
 * Activity — the notification feed (v1 right pane).
 *
 * A scannable log rather than toasts, because the events worth surfacing here happen while
 * the user is looking somewhere else: a session dropping to relay, a lock taken by someone
 * else, a token an hour from expiry. Something that disappears after four seconds is the
 * wrong shape for any of those.
 *
 * Newest first, and capped — this pane is fed by long-lived tunnels that emit indefinitely,
 * so an unbounded array here would be a slow memory leak in an app meant to stay open all
 * day.
 */

/** Beyond this, the oldest are dropped. Roughly a day of ordinary activity. */
const MAX_NOTICES = 500;

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function Activity({ notices }: { notices: Notice[] }) {
  const [showProblemsOnly, setShowProblemsOnly] = useState(false);

  const visible = useMemo(() => {
    const list = showProblemsOnly
      ? notices.filter((n) => n.level === "warn" || n.level === "error")
      : notices;
    return list.slice(0, MAX_NOTICES);
  }, [notices, showProblemsOnly]);

  const problemCount = notices.filter(
    (n) => n.level === "warn" || n.level === "error",
  ).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <button
          onClick={() => setShowProblemsOnly(false)}
          className={`rounded px-2 py-0.5 ${!showProblemsOnly ? "bg-surface-3 text-ink-0" : "text-ink-2 hover:text-ink-1"}`}
        >
          All
        </button>
        <button
          onClick={() => setShowProblemsOnly(true)}
          className={`rounded px-2 py-0.5 ${showProblemsOnly ? "bg-surface-3 text-ink-0" : "text-ink-2 hover:text-ink-1"}`}
        >
          Problems{problemCount > 0 ? ` (${problemCount})` : ""}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <p className="px-3 py-3 text-ink-2">
            {showProblemsOnly ? "No problems." : "Nothing yet."}
          </p>
        ) : (
          <ul>
            {visible.map((n) => (
              <li
                key={n.id}
                className="flex gap-2 border-b border-line/50 px-3 py-2 last:border-b-0"
              >
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[noticeTone(n.level)]}`}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="selectable break-words text-ink-1">{n.message}</p>
                  {/* Session first and brighter than the timestamp. Which session a line
                      is about is the thing you scan for when several are open; the time is
                      what you read once you have found it. */}
                  <p className="mt-0.5 text-[11px] text-ink-2">
                    {n.source && (
                      <span className="font-medium text-ink-1">{n.source} · </span>
                    )}
                    {timeOf(n.at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
