import { useEffect, useRef, useState } from "react";

/**
 * A small picker for the one-to-many relations in the top bar: repositories within a
 * session, branches within a repository.
 *
 * Closes on outside click and on Escape. Both matter more here than they might elsewhere:
 * this sits in a toolbar an artist passes through constantly, and a menu that needs a
 * second precise click to dismiss becomes a small irritation repeated all day.
 */

export interface DropdownItem {
  id: string;
  label: string;
  /** Shown dimmed after the label — a branch's role, a repo's path. */
  detail?: string;
  disabled?: boolean;
}

export function Dropdown({
  label,
  value,
  items,
  onSelect,
  emptyMessage = "Nothing to choose from.",
  hint,
}: {
  label: string;
  value: string;
  items: DropdownItem[];
  onSelect: (id: string) => void;
  emptyMessage?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-ink-2">{label}</span>
      <button
        onClick={() => setOpen((v) => !v)}
        title={hint}
        className="flex items-center gap-2 rounded border border-line bg-surface-2 px-2.5 py-1 text-ink-1 hover:bg-surface-3"
      >
        <span className="max-w-44 truncate">{value}</span>
        {/* The count tells the user there are others without making them open the menu. */}
        {items.length > 1 && <span className="text-[11px] text-ink-2">{items.length}</span>}
        <span className="text-ink-2">▾</span>
      </button>

      {open && (
        <div className="absolute top-full left-0 z-20 mt-1 max-h-80 min-w-56 overflow-auto rounded border border-line bg-surface-2 py-1 shadow-lg">
          {items.length === 0 ? (
            <p className="px-3 py-2 text-ink-2">{emptyMessage}</p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                disabled={item.disabled}
                onClick={() => {
                  onSelect(item.id);
                  setOpen(false);
                }}
                className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left disabled:opacity-40 ${
                  item.label === value ? "bg-accent/15 text-ink-0" : "text-ink-1 hover:bg-surface-3"
                }`}
              >
                <span className="truncate">{item.label}</span>
                {item.detail && (
                  <span className="ml-auto shrink-0 text-[11px] text-ink-2">{item.detail}</span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
