import type { Session } from "../types/app";
import { SESSION_LABEL, TONE_DOT, sessionTone } from "../lib/status";

/**
 * One tab per Lore session.
 *
 * The tab strip is always shown, even with a single session, because it carries the "+"
 * that adds the next one — hiding it until a second session exists would leave no way to
 * create one. With one tab it stays visually quiet.
 *
 * Status is a dot rather than a word: with several tabs open the user is scanning for the
 * one that has gone wrong, and colour finds it faster than reading.
 *
 * The colours come from the shared convention in lib/status, so a tab and an Activity line
 * describing the same condition are the same colour.
 */

export function SessionTabs({
  sessions,
  activeId,
  onSelect,
  onAdd,
  onEdit,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** Edit a session's details. Reachable from the tab itself, since that is where the
      user is already thinking about that session. */
  onEdit?: (id: string) => void;
}) {
  return (
    <div className="flex shrink-0 items-end gap-px border-b border-line bg-surface-0 px-2 pt-1.5">
      {sessions.map((s) => {
        const active = s.id === activeId;
        return (
          <div
            key={s.id}
            onDoubleClick={() => onEdit?.(s.id)}
            title={`${SESSION_LABEL[s.status]} — double-click to edit`}
            className={`group flex max-w-56 items-center gap-2 rounded-t border border-b-0 py-1.5 pl-3 pr-1.5 ${
              active
                ? "border-line bg-surface-1 text-ink-0"
                : "border-transparent bg-transparent text-ink-2 hover:bg-surface-1/50 hover:text-ink-1"
            }`}
          >
            <button onClick={() => onSelect(s.id)} className="flex min-w-0 items-center gap-2">
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[sessionTone(s.status)]}`}
                aria-hidden
              />
              <span className="truncate">{s.name}</span>
            </button>
            {/* Visible on the active tab, and on hover elsewhere: editing was previously
                behind a single icon in the toolbar that testers did not find. */}
            {/* Always visible, not hover-revealed: testers could not find it when it only
                appeared on the active tab, and a control you must discover by accident is
                one most people never find. */}
            <button
              onClick={() => onEdit?.(s.id)}
              title="Session settings"
              aria-label={`Settings for ${s.name}`}
              className="shrink-0 rounded px-1.5 py-0.5 text-[15px] leading-none text-ink-1 hover:bg-surface-3 hover:text-ink-0"
            >
              ⚙
            </button>
          </div>
        );
      })}

      <button
        onClick={onAdd}
        title="Add a session"
        className="mb-0.5 ml-1 rounded px-2 py-1 text-ink-2 hover:bg-surface-2 hover:text-ink-0"
      >
        +
      </button>
    </div>
  );
}
