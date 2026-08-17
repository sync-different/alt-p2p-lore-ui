import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceSummary } from "../lib/workspaces";

/**
 * One tab per working copy — the unit people actually work in.
 *
 * Not one per connection, which is what this used to be. A day of testing established that
 * nothing in lore is per-session: a repository reaches its host over a loopback port, and the
 * identity it acts as lives in its own config. So two clones of one repository, acting as two
 * different people, are two workspaces served by one tunnel — and a tab that meant "session"
 * could not express that.
 *
 * The colour answers "can I work here?", which is a question about the repository, not about
 * the tab you happen to be looking at.
 *
 * The strip scrolls. With ten workspaces open the tabs outgrew the window and the ones past the
 * edge simply ceased to exist — no arrows, no scrollbar, and the + Clone / + Open buttons went
 * with them. Now the tabs live in their own scrollable region with arrows that appear only when
 * something is actually hidden, the active tab keeps itself in view, and the label and action
 * buttons are pinned outside the scroll area so they can never fall off.
 */

export type WorkspaceHealth = "ready" | "unreachable" | "signed_out" | "missing" | "unknown";

const DOT: Record<WorkspaceHealth, string> = {
  ready: "bg-ok",
  unreachable: "bg-ink-2/50",
  signed_out: "bg-warn",
  missing: "bg-danger",
  unknown: "bg-ink-2/50",
};

const WHY: Record<WorkspaceHealth, string> = {
  ready: "Reachable",
  unreachable: "No connected host is serving this repository's port",
  signed_out: "The identity this repository acts as is not signed in",
  missing: "The folder is gone",
  unknown: "Not known yet",
};

export function WorkspaceTabs({
  workspaces,
  label,
  health,
  identityName,
  activeId,
  onSelect,
  onEdit,
  onAdd,
  onClone,
}: {
  workspaces: WorkspaceSummary[];
  /** What to call it — disambiguated when two clones share a name. */
  label: (w: WorkspaceSummary) => string;
  health: (w: WorkspaceSummary) => WorkspaceHealth;
  /** The identity a workspace acts as, named where the id is known. */
  identityName: (w: WorkspaceSummary) => string | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  onEdit: (w: WorkspaceSummary) => void;
  /** Add a working copy that already exists on this machine. */
  onAdd: () => void;
  /** Make a new one from a host. */
  onClone: () => void;
}) {
  const strip = useRef<HTMLDivElement | null>(null);
  // Which arrows are needed right now. Split rather than a single "overflowing" flag so each
  // arrow can disable itself at its own end of the strip.
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const update = useCallback(() => {
    const el = strip.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    // -1 absorbs fractional pixel widths, which otherwise leave a permanently-lit arrow.
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Re-measure when tabs come and go and when the window resizes. A ResizeObserver on the strip
  // itself covers both the window and layout shifts (a long repo name, an identity chip).
  useEffect(() => {
    update();
    const el = strip.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, workspaces.length]);

  // Keep the active tab visible: selecting via keyboard/code, or opening a new workspace at the
  // end of the strip, must not land on a tab that is off-screen.
  useEffect(() => {
    if (!activeId) return;
    const el = strip.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeId)}"]`);
    el?.scrollIntoView({ inline: "nearest", block: "nearest" });
    update();
  }, [activeId, update]);

  const nudge = (dir: -1 | 1) => {
    // Most of a viewport per press: enough to feel like paging, small enough to keep context.
    strip.current?.scrollBy({ left: dir * Math.max(160, (strip.current.clientWidth * 2) / 3), behavior: "smooth" });
  };

  const arrowClass = (enabled: boolean) =>
    `shrink-0 self-stretch px-1 text-ink-2 ${
      enabled ? "hover:bg-surface-1 hover:text-ink-0" : "pointer-events-none opacity-0"
    }`;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-line bg-surface-0 px-3">
      {/* Labelled to match the Hosts row above it, so the two strips read as a pair: what you
          can reach, and what you are working in. The row's own padding matches too (px-3), or
          the two labels start four pixels apart and the rows look misaligned. */}
      <span className="shrink-0 pr-2 text-[11px] uppercase tracking-wide text-ink-2">Repos</span>
      {workspaces.length === 0 && (
        <span className="px-1 py-2 text-ink-2">
          No workspaces yet — clone one from a host, or open a folder you cloned earlier.
        </span>
      )}

      {/* Arrows sit outside the scroll region and only render as visible when there is hidden
          content on their side — ten tabs get arrows, three tabs see nothing new. */}
      <button
        onClick={() => nudge(-1)}
        aria-label="Scroll tabs left"
        aria-hidden={!canLeft}
        tabIndex={canLeft ? 0 : -1}
        className={arrowClass(canLeft)}
      >
        ‹
      </button>

      <div
        ref={strip}
        onScroll={update}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {workspaces.map((w) => {
          const active = w.id === activeId;
          const state = health(w);
          const who = identityName(w);
          return (
            <div
              key={w.id}
              data-tab-id={w.id}
              onClick={() => onSelect(w.id)}
              onDoubleClick={() => onEdit(w)}
              className={`group flex shrink-0 cursor-pointer items-center gap-2 border-b-2 px-2.5 py-2 ${
                active
                  ? "border-accent bg-surface-1 text-ink-0"
                  : "border-transparent text-ink-2 hover:bg-surface-1 hover:text-ink-1"
              }`}
              title={`${w.path}\n${WHY[state]}`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} aria-hidden />
              <span className="max-w-[16rem] truncate">{label(w)}</span>
              {/* The identity is part of what a workspace *is*, so it is on the tab rather than
                  hidden in a panel — with two clones of one repository it is the only thing
                  that tells them apart. */}
              {who && (
                <span className="shrink-0 rounded bg-surface-2 px-1 text-[11px] text-ink-2">
                  {who}
                </span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(w);
                }}
                aria-label={`Settings for ${w.name}`}
                title="Workspace settings"
                className={`shrink-0 rounded px-1 text-[13px] leading-none text-ink-2 hover:bg-surface-3 hover:text-ink-0 ${
                  active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
              >
                ⚙
              </button>
            </div>
          );
        })}
      </div>

      <button
        onClick={() => nudge(1)}
        aria-label="Scroll tabs right"
        aria-hidden={!canRight}
        tabIndex={canRight ? 0 : -1}
        className={arrowClass(canRight)}
      >
        ›
      </button>

      {/* Both ways to get work, at the end of the list of work — pinned outside the scroll
          region, because "add a workspace" disappearing once you have many workspaces is
          exactly backwards. They were in a "Repo" dropdown in the row below once, which
          duplicated this strip and which a tester could not find. */}
      <button
        onClick={onClone}
        className="ml-1 shrink-0 rounded border border-accent/40 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/15"
        title="Clone a repository from a host into a new folder"
      >
        + Clone
      </button>
      <button
        onClick={onAdd}
        className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] text-ink-2 hover:bg-surface-1 hover:text-ink-0"
        title="Add a working copy already on this machine"
      >
        + Open
      </button>
    </div>
  );
}
