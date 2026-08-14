import { invoke } from "@tauri-apps/api/core";
import { authorityOf } from "./sessions";
import type { ServingHost } from "./reachability";
import type { WorkspaceHealth } from "../components/WorkspaceTabs";

/**
 * Workspaces: a working copy, plus the identity it acts as.
 *
 * Everything that distinguishes one piece of work from another lives in the repository
 * itself — which host it dials (`remote_url`, a loopback port) and who it acts as
 * (`identity = "u-…"`). So the host is *derived*, never stored: there is no association to
 * keep in step when either side changes.
 */

export interface WorkspaceSummary {
  id: string;
  path: string;
  name: string;
  /** False when the folder has gone; a moved clone must not look healthy. */
  exists: boolean;
  remote_url: string | null;
  remote_port: number | null;
  identity: string | null;
  /** The repository this is a clone of; shared by every clone of it. */
  repository_id: string | null;
  /** This working copy's own id — stable across renaming or moving the folder. */
  instance_id: string | null;
}

/**
 * Workspaces that are clones of the same repository.
 *
 * Lore supports this explicitly — several instances of one repository on one machine, each
 * with its own working tree, branch and identity — and it is the arrangement this app was
 * reshaped around. Saying so turns two confusingly similar tabs into an intended pair.
 */
export function siblingsOf(w: WorkspaceSummary, all: WorkspaceSummary[]): WorkspaceSummary[] {
  if (!w.repository_id) return [];
  return all.filter((o) => o.id !== w.id && o.repository_id === w.repository_id);
}

export const loadWorkspaces = () => invoke<WorkspaceSummary[]>("load_workspaces");
export const addWorkspace = (path: string, name?: string) =>
  invoke<WorkspaceSummary[]>("add_workspace", { path, name: name ?? null });
export const removeWorkspace = (id: string) => invoke<WorkspaceSummary[]>("remove_workspace", { id });
export const renameWorkspace = (id: string, name: string) =>
  invoke<WorkspaceSummary[]>("rename_workspace", { id, name });

/**
 * Pin a workspace to an identity, or unpin it with `null`.
 *
 * The setting that makes two clones of one repository act as two different people — and the
 * reason signing out is the wrong way to switch user: identities are stored per auth URL for
 * the whole machine, so signing out removes a credential everywhere. Both stay signed in;
 * each workspace chooses.
 */
export const setWorkspaceIdentity = (id: string, identity: string | null) =>
  invoke<WorkspaceSummary[]>("set_workspace_identity", { id, identity });

/**
 * Can work happen here?
 *
 * Ordered by what stops you first. A missing folder outranks everything — there is nothing to
 * reach. Then whether any live tunnel serves its port, since that is what `lore` dials. Only
 * then identity, because being signed out is recoverable in seconds while the other two are
 * not.
 */
export function workspaceHealth(
  w: WorkspaceSummary,
  hosts: ServingHost[],
  signedInIds: string[],
  /**
   * Does this workspace's host require signing in at all?
   *
   * A host with no auth URL does not, and a pin on a workspace there is inert — lore has no
   * store to look the identity up in. Judging it as "signed out" put a warning on a workspace
   * that had been committing and pushing all along, which teaches people to ignore the colour.
   */
  requiresSignIn = true,
): WorkspaceHealth {
  if (!w.exists) return "missing";
  if (!w.remote_url) return "unknown";
  const wanted = authorityOf(w.remote_url);
  const served = hosts.some((h) => h.available && authorityOf(h.baseUrl) === wanted);
  if (!served) return "unreachable";
  // A pinned identity that is not signed in fails every call with "No token stored" — true,
  // and nothing about that message points at the repository. But only where signing in is a
  // thing the host asks for.
  if (requiresSignIn && w.identity && !signedInIds.includes(w.identity)) return "signed_out";
  return "ready";
}

/**
 * Labels that tell workspaces apart.
 *
 * Two clones of one repository default to the same folder name — "demo" and "demo" — which
 * makes the tabs, the settings dialog and every line in the Activity feed ambiguous. The
 * usual fix, and the one editors use for same-named files: keep the short name when it is
 * unique, and when it is not, add just enough of the path to separate them.
 *
 * `demo` · `demo`  →  `demo-ctone/demo` · `demo-ctone2/demo`
 *
 * A name the user typed is left alone unless it collides, because renaming to something
 * memorable is the better fix and this should not fight it.
 */
export function displayLabels(list: WorkspaceSummary[]): Map<string, string> {
  const out = new Map<string, string>();
  const groups = new Map<string, WorkspaceSummary[]>();
  for (const w of list) {
    groups.set(w.name, [...(groups.get(w.name) ?? []), w]);
  }

  for (const [name, members] of groups) {
    if (members.length === 1) {
      out.set(members[0].id, name);
      continue;
    }
    // Take one more parent directory at a time until the labels differ, or until there is no
    // more path to take — two workspaces on the same path are the same folder, and no amount
    // of prefix will separate them.
    const parts = members.map((w) => w.path.split("/").filter(Boolean));
    for (let depth = 1; ; depth++) {
      const labels = members.map((_, i) => {
        const p = parts[i];
        // Skip the leaf when it already matches the name: "demo-ctone/demo", not
        // "demo-ctone/demo/demo".
        const tail = p[p.length - 1] === name ? p.slice(0, -1) : p;
        return [...tail.slice(Math.max(0, tail.length - depth)), name].join("/");
      });
      const distinct = new Set(labels).size === labels.length;
      const exhausted = depth >= Math.max(...parts.map((p) => p.length));
      if (distinct || exhausted) {
        members.forEach((w, i) => out.set(w.id, labels[i]));
        break;
      }
    }
  }
  return out;
}
