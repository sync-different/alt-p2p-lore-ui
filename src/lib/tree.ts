/**
 * The file-tree model.
 *
 * Deliberately pure: the tree is described as data and flattened to a list, with no React
 * and no `invoke` involved. That is what makes the awkward part — nesting, expansion,
 * lazily-arrived children — testable directly, and it is also what virtualization needs,
 * since a windowed list can only render a flat array.
 */

import type { DirEntry } from "./repo";

/** Children keyed by the directory's repo-relative path; the root is "". */
export type LoadedDirs = Map<string, DirEntry[]>;

export interface VisibleRow {
  entry: DirEntry;
  /** 0 for the repository root's own children. */
  depth: number;
  expanded: boolean;
  /** True for a directory whose children have not arrived yet. */
  loading: boolean;
}

/**
 * Flatten the loaded, expanded parts of the tree into the list the UI renders.
 *
 * Only expanded directories contribute children, so cost is proportional to what is on
 * screen rather than to the repository — which matters when the repository has 1988
 * directories and 2162 files.
 */
export function flattenTree(
  loaded: LoadedDirs,
  expanded: Set<string>,
  loading: Set<string>,
): VisibleRow[] {
  const rows: VisibleRow[] = [];

  const walk = (dirRel: string, depth: number) => {
    const children = loaded.get(dirRel);
    if (!children) return;

    for (const entry of children) {
      const isExpanded = entry.is_dir && expanded.has(entry.rel_path);
      rows.push({
        entry,
        depth,
        expanded: isExpanded,
        loading: entry.is_dir && loading.has(entry.rel_path),
      });
      if (isExpanded) walk(entry.rel_path, depth + 1);
    }
  };

  walk("", 0);
  return rows;
}

/**
 * Toggle a directory, returning new sets.
 *
 * Collapsing also forgets every descendant's expansion state. The alternative — remembering
 * it — means collapsing and reopening a folder silently re-expands a subtree the user
 * closed, which reads as the app ignoring them.
 */
export function toggleExpanded(expanded: Set<string>, rel: string): Set<string> {
  const next = new Set(expanded);
  if (next.has(rel)) {
    next.delete(rel);
    const prefix = `${rel}/`;
    for (const p of next) if (p.startsWith(prefix)) next.delete(p);
  } else {
    next.add(rel);
  }
  return next;
}

/**
 * Every ancestor of a path, outermost first: "a/b/c.txt" -> ["a", "a/b"].
 *
 * Used to reveal a file the user picked from the changes list, which may sit many levels
 * inside collapsed folders.
 */
export function ancestorsOf(rel: string): string[] {
  const parts = rel.split("/");
  parts.pop();
  const out: string[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push(acc);
  }
  return out;
}

/** Directories that must be loaded before `rel` can be shown. */
export function missingAncestors(loaded: LoadedDirs, rel: string): string[] {
  return ancestorsOf(rel).filter((a) => !loaded.has(a));
}

/**
 * Build a synthetic tree from a flat list of changed paths.
 *
 * The changed set spans the whole repository, so it cannot come from directory listings —
 * that would mean walking everything the lazy tree exists to avoid. Instead the paths
 * themselves imply the structure, and directories are inferred rather than read from disk.
 */
export function treeFromPaths(paths: string[]): LoadedDirs {
  const loaded: LoadedDirs = new Map();
  const seen = new Set<string>();

  const ensureDir = (dirRel: string) => {
    if (!loaded.has(dirRel)) loaded.set(dirRel, []);
  };
  ensureDir("");

  for (const path of paths) {
    const parts = path.split("/");
    let parent = "";

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const rel = parent ? `${parent}/${name}` : name;
      const isDir = i < parts.length - 1;
      const key = `${parent}::${rel}`;

      if (!seen.has(key)) {
        seen.add(key);
        ensureDir(parent);
        loaded.get(parent)!.push({
          name,
          rel_path: rel,
          is_dir: isDir,
          size: 0,
          modified_ms: 0,
          // Only meaningful for files; directories are never "binary".
          is_binary: !isDir && /\.[^./]+$/.test(name) ? isBinaryName(name) : false,
        });
      }
      if (isDir) ensureDir(rel);
      parent = rel;
    }
  }

  // Same ordering rule as the real listing, so the two views feel like one control.
  for (const list of loaded.values()) {
    list.sort((a, b) =>
      a.is_dir !== b.is_dir
        ? a.is_dir
          ? -1
          : 1
        : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    );
  }

  return loaded;
}

const BINARY_EXT = new Set([
  "uasset", "umap", "ubulk", "uexp", "blend", "fbx", "obj", "abc", "psd", "ma", "mb",
  "png", "jpg", "jpeg", "tga", "tif", "tiff", "exr", "hdr", "bmp", "gif", "dds", "ico",
  "wav", "mp3", "ogg", "flac", "mp4", "mov", "avi", "webm",
  "pdf", "docx", "xlsx", "pptx", "zip", "7z", "rar", "gz", "tar",
  "dll", "pdb", "exe", "so", "dylib", "lib", "a", "o", "bin", "class", "jar",
]);

/** Mirror of the Rust classifier, for paths that never came from a directory listing. */
export function isBinaryName(name: string): boolean {
  const i = name.lastIndexOf(".");
  if (i < 0) return false;
  return BINARY_EXT.has(name.slice(i + 1).toLowerCase());
}
