import type { ChangeEntry, ChangeKind } from "./repo";

/**
 * What a commit would include, and what it would not.
 *
 * The distinction exists only in `lore status`'s section headers — `A note.txt` reads
 * identically whether it is staged or untracked — so it is carried on the entry and grouped
 * here rather than inferred anywhere else.
 */

export interface ChangeGroups {
  staged: ChangeEntry[];
  unstaged: ChangeEntry[];
}

export function groupChanges(changes: ChangeEntry[]): ChangeGroups {
  return {
    staged: changes.filter((c) => c.staged),
    unstaged: changes.filter((c) => !c.staged),
  };
}

/**
 * A short, plain word for a change — "M" tells an artist nothing.
 *
 * "modified" becomes "changed" deliberately: it is the word people use, and this list is read
 * at the moment someone decides what to send.
 */
export function describeKind(kind: ChangeKind): string {
  if (kind === "added") return "added";
  if (kind === "modified") return "changed";
  if (kind === "deleted") return "deleted";
  // An unrecognised code is shown as lore wrote it rather than guessed at or hidden.
  return typeof kind === "object" && "other" in kind ? kind.other.toLowerCase() : "changed";
}

/**
 * Toggle one path in a selection.
 *
 * A plain set operation, kept here so the component holds no logic worth testing and the
 * behaviour can be checked without rendering anything.
 */
export function toggleSelected(selected: Set<string>, path: string): Set<string> {
  const next = new Set(selected);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

/** Select all of a group, or clear the selection when everything is already selected. */
export function toggleAll(selected: Set<string>, paths: string[]): Set<string> {
  const allSelected = paths.length > 0 && paths.every((p) => selected.has(p));
  const next = new Set(selected);
  for (const p of paths) {
    if (allSelected) next.delete(p);
    else next.add(p);
  }
  return next;
}

/**
 * What a commit will contain, in a sentence.
 *
 * Deliberately counts *staged* entries and not the selection: the selection is what the next
 * button press will act on, the staged set is what a commit would write. Conflating them is
 * how someone commits more than they meant to.
 */
export function describeCommit(staged: ChangeEntry[]): string {
  if (staged.length === 0) return "Nothing is staged.";
  const byKind = new Map<string, number>();
  for (const c of staged) {
    const k = describeKind(c.kind);
    byKind.set(k, (byKind.get(k) ?? 0) + 1);
  }
  const parts = [...byKind.entries()].map(([k, n]) => `${n} ${k}`);
  const files = `${staged.length} file${staged.length === 1 ? "" : "s"}`;
  return `${files} — ${parts.join(", ")}`;
}
