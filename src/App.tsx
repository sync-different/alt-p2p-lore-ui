import { useCallback, useEffect, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Prerequisites } from "./components/Prerequisites";
import { RepoPanel } from "./components/RepoPanel";
import { FileView } from "./components/FileView";
import { HostBar } from "./components/HostBar";
import { WorkspaceForm } from "./components/WorkspaceForm";
import { CloneDialog } from "./components/CloneDialog";
import { CommitDialog } from "./components/CommitDialog";
import { DiscardDialog } from "./components/DiscardDialog";
import { SwitchBlockedDialog } from "./components/SwitchBlockedDialog";
import { NewBranchDialog } from "./components/NewBranchDialog";
import { WorkspaceTabs } from "./components/WorkspaceTabs";
import { Activity } from "./components/Activity";
import { Actions } from "./components/Actions";
import { Dropdown } from "./components/Dropdown";
import { useRepository } from "./hooks/useRepository";
import { useNotices } from "./hooks/useNotices";
import { SessionForm } from "./components/SessionForm";
import { useTunnels, phaseToStatus } from "./hooks/useTunnels";
import { useAuth } from "./hooks/useAuth";
import { AuthBadge } from "./components/AuthBadge";
import { SignInDialog } from "./components/SignInDialog";
import { connectSession, hasPsk, loadSessions, type SessionConfig } from "./lib/sessions";
import { activeRepo, type Session } from "./types/app";
import {
  addWorkspace,
  displayLabels,
  siblingsOf,
  loadWorkspaces,
  removeWorkspace,
  workspaceHealth,
  type WorkspaceSummary,
} from "./lib/workspaces";
import { reachability } from "./lib/reachability";
import { identitiesAt, nameForId } from "./lib/auth";
import { hostAuthUrl, hostBaseUrl, hostServes } from "./lib/sessions";

/**
 * M2: one real local repository, driven by the `lore` CLI.
 *
 * Sessions are still illustrative — they become real in M3, when the tunnel registry built
 * in M1 starts holding actual connections. Everything in the left and centre columns is
 * real data from disk and from `lore`.
 */

function Pane({ title, children, className = "", actions }: {
  title: string;
  children?: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
}) {
  return (
    <section className={`flex min-h-0 flex-col ${className}`}>
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-2">{title}</span>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}

export default function App() {
  const [saved, setSaved] = useState<SessionConfig[]>([]);
  /** The host in focus for sign-in and settings; derived from the active workspace. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editing, setEditing] = useState<(SessionConfig & { hasKey?: boolean }) | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [editingWorkspace, setEditingWorkspace] = useState<WorkspaceSummary | null>(null);
  const [cloning, setCloning] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [discarding, setDiscarding] = useState<string[] | null>(null);
  const [switchBlocked, setSwitchBlocked] = useState<{ branch: string; files: string[] } | null>(null);
  const [newBranch, setNewBranch] = useState(false);
  /**
   * The working copies on this machine, and which one is in front of the user.
   *
   * A tab is a workspace now, not a connection: the repository carries its own host (a
   * loopback port) and its own identity, so two clones acting as two people are two tabs
   * served by one tunnel.
   */
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);

  const { notices, push } = useNotices();
  // A stable callback: the hook depends on it, and a new identity each render would make
  // its effects re-subscribe on every keystroke elsewhere in the tree.
  const onEvent = useCallback(
    (level: Parameters<typeof push>[0], message: string, source?: string) =>
      void push(level, message, source),
    [push],
  );

  /**
   * Repository events are about the workspace in front of the user, and the hook that raises
   * them has no idea which that is.
   *
   * Read through a ref rather than captured, so the label is the workspace that was active
   * when the event happened — and so this callback stays stable, which the hook's effects
   * depend on.
   */
  const activeWorkspaceName = useRef<string | undefined>(undefined);
  const repoEvent = useCallback(
    (level: Parameters<typeof push>[0], message: string, source?: string) =>
      void push(level, message, source ?? activeWorkspaceName.current),
    [push],
  );
  const repo = useRepository(repoEvent);
  // The same stable callback as the repository hook. An inline arrow here re-created the
  // subscription on every render — see useTunnels.
  const tunnels = useTunnels(onEvent);

  const refreshWorkspaces = useCallback(async () => {
    const list = await loadWorkspaces();
    setWorkspaces(list);
    setActiveWorkspaceId((prev) => prev ?? list[0]?.id ?? null);
    return list;
  }, []);
  useEffect(() => void refreshWorkspaces(), [refreshWorkspaces]);
  useEffect(() => {
    void loadSessions().then((list) => {
      setSaved(list);
      setActiveId((prev) => prev ?? list[0]?.id ?? null);

      // Saving a duplicate is refused now, but configurations written before that check
      // still exist — and they are invisible until two tabs start moving together, which
      // reads as a bug in the app rather than as two names for one connection.
      const bySession = new Map<string, string[]>();
      for (const s of list) {
        bySession.set(s.session_id, [...(bySession.get(s.session_id) ?? []), s.name]);
      }
      for (const [sid, names] of bySession) {
        if (names.length > 1) {
          push(
            "warn",
            `${names.map((n) => `“${n}”`).join(" and ")} both use the session name “${sid}”. ` +
              `That is one connection, not two — they will always show the same status. ` +
              `Delete one from its settings.`,
          );
        }
      }
    });
  }, [push]);

  // Saved configuration plus whatever its tunnel is currently doing. The tunnel is the
  // authority on status; the config only says what to connect to.
  const sessions: Session[] = saved.map((s) => {
    const t = tunnels.forSession(s.session_id);
    return {
      id: s.id,
      name: s.name,
      status: phaseToStatus(t?.phase, t?.mode),
      activeRepoId: null,
      repos: [],
    };
  });

  const session = sessions.find((s) => s.id === activeId) ?? null;
  /**
   * The host the sign-in badge and settings act on.
   *
   * The workspace in front of the user names it, but often nothing does — no workspace open,
   * or one whose port no host matches. Falling back to the host that is *connected* is what
   * a person means by "am I signed in?": there is only one tunnel, and it is the thing the
   * question is about. Without this the badge simply vanished, which read as the feature
   * being gone rather than as having nothing to describe.
   */
  const connectedHosts = saved.filter(
    (h) => tunnels.forSession(h.session_id)?.phase === "connected",
  );
  const activeConfig = saved.find((s) => s.id === activeId) ?? connectedHosts[0] ?? null;
  /**
   * Whether the badge has to name its host.
   *
   * Only when the choice was not forced: several hosts connected and nothing on screen saying
   * which one the sign-in state belongs to. With one host, or when the active workspace picked
   * it, the name is noise.
   */
  const badgeHostName =
    connectedHosts.length > 1 && !saved.some((s) => s.id === activeId)
      ? (activeConfig?.name ?? null)
      : null;
  const activeTunnel = activeConfig ? tunnels.forSession(activeConfig.session_id) : undefined;

  // Sign-in is only meaningful once the tunnel is up: before that, `lore` would be asked
  // about a host it cannot reach, and "not signed in" would be an artefact of the tunnel
  // being down rather than a fact about the token.
  const tunnelUp = !!activeTunnel && activeTunnel.phase === "connected";
  /**
   * Can a sign-in happen at all?
   *
   * Not "is the selected host connected" — tokens are filed per auth URL, so *any* live
   * tunnel forwarding this identity port can carry the exchange. Tying it to the selected
   * host disabled the control whenever the user was looking at a host other than the one
   * that was up.
   */
  const activeAuthUrl = activeConfig ? hostAuthUrl(activeConfig) : null;
  /**
   * Can a sign-in happen at all?
   *
   * Not "is the selected host connected" — tokens are filed per auth URL, so any host serving
   * that URL can carry the exchange. A direct host needs no tunnel at all.
   */
  const identityServed =
    activeAuthUrl != null &&
    ((activeConfig && (activeConfig.kind ?? "p2p") === "direct") ||
      [...tunnels.tunnels.values()].some(
        (t) => t.phase === "connected" && t.identity_port === activeConfig?.identity_port,
      ));
  const activePin =
    workspaces.find((w) => w.id === activeWorkspaceId)?.identity ?? null;
  const auth = useAuth(
    activeAuthUrl,
    activePin,
    activeConfig?.name,
    (level, message, who) => void push(level, message, who),
  );
  // A token-paste sign-in, not a browser one: a self-hosted identity provider issues a JWT
  // with `token issue <user>`, and the browser flow this started as would not reach it.
  const [signingIn, setSigningIn] = useState(false);

  // Can the open repository actually be reached from the session on screen? A working copy
  // pins its remote to a loopback port, so the answer is not "is the tunnel up".
  /**
   * Every host, as something that either serves a URL or does not.
   *
   * A P2P host is available when its tunnel is up; a direct host is available because it was
   * configured — whether it answers is a question for the operation, and its failure is
   * translated rather than predicted.
   */
  const servingHosts = saved.map((h) => ({
    name: h.name,
    baseUrl: hostBaseUrl(h),
    available:
      (h.kind ?? "p2p") === "direct"
        ? true
        : tunnels.forSession(h.session_id)?.phase === "connected",
    isP2p: (h.kind ?? "p2p") !== "direct",
  }));
  /**
   * Who is signed in **at a given workspace's host**.
   *
   * Not globally: identities are filed per auth URL, so a workspace on one host must
   * be judged against that host's store. Reading the whole store made a workspace look
   * signed in because the same person was signed in somewhere else entirely.
   */
  const signedInFor = (w: WorkspaceSummary) => {
      const h = hostFor(w);
      return identitiesAt(auth.status?.all ?? [], h ? hostAuthUrl(h) : null);
    };

  // Every tunnel, not just this tab's: `lore` dials a loopback port and has no idea which
  // session is on screen, so a repository served by another tab's tunnel is reachable.
  const reach = reachability({ remoteUrl: repo.info?.remote_url, hosts: servingHosts });
  // The hook reports failures; it needs the current answer, not the one that held when its
  // callbacks were created.
  useEffect(() => repo.setReach(reach), [repo, reach.state, reach.repoUrl, reach.servedBy]);
  // Only meaningful with exactly one identity; with several, lore chooses and naming one
  // would put a specific account into a message that might be about a different one.
  const soleIdentity =
    auth.status?.identities.length === 1
      ? (auth.status.identities[0].user ?? auth.status.identities[0].user_id ?? null)
      : null;
  useEffect(() => repo.setSignedInAs(soleIdentity), [repo, soleIdentity]);
  // Named where we can: "u-87c4…" alone tells the user nothing about who to sign in as.
  const pinned = repo.info?.identity
    ? nameForId(repo.info.identity, auth.status?.all ?? [])
    : null;
  useEffect(() => repo.setRepoIdentity(pinned), [repo, pinned]);

  const connectHost = async (h: SessionConfig) => {
    try {
      push("info", `Connecting to “${h.name}”…`, h.name);
      await connectSession(h.id);
    } catch (e) {
      // Reported here as well as through the event stream: a refusal before the process
      // starts (a port collision, a missing key) never produces a tunnel event at all.
      push("error", String(e), h.name);
    }
  };

  const disconnectHost = async (h: SessionConfig) => {
    const t = tunnels.forSession(h.session_id);
    if (!t) return;
    await tunnels.stop(t.id);
    push("info", `Disconnected from “${h.name}”.`, h.name);
  };
  const problems = notices.filter((n) => n.level === "warn" || n.level === "error").length;


  /**
   * Which host serves a workspace — derived from the repository's port, never stored.
   *
   * That is exactly how `lore` resolves it: it dials a loopback port, and whoever listens
   * there answers. Storing a link would be a second answer to keep in step with the first.
   */
  const hostFor = useCallback(
    (w: WorkspaceSummary | null) => {
      if (!w?.remote_url) return null;
      const candidates = saved.filter((h) => hostServes(h, w.remote_url));
      // Nothing stops two hosts being configured on one local port — only one can be
      // *connected*, and that one is the one actually serving this working copy. Picking the
      // first configured would name a host that is not carrying the traffic.
      return (
        candidates.find(
          (h) =>
            (h.kind ?? "p2p") === "direct" ||
            tunnels.forSession(h.session_id)?.phase === "connected",
        ) ??
        candidates[0] ??
        null
      );
    },
    [saved, tunnels],
  );

  const openWorkspace = useCallback(
    async (w: WorkspaceSummary | null) => {
      if (!w) {
        repo.close();
        return;
      }
      if (!w.exists) {
        push("error", `This folder is no longer at ${w.path}.`, labelOf(w));
        repo.close();
        return;
      }
      // Focus the host that serves it, so sign-in and settings act on the right one.
      const host = hostFor(w);
      setActiveId(host?.id ?? null);
      await repo.open(w.path);
    },
    [repo, hostFor, push],
  );

  /**
   * Labels that tell workspaces apart — two clones of one repository default to the same
   * folder name, which made the tabs *and* every line in the Activity feed ambiguous.
   */
  const labels = displayLabels(workspaces);
  const labelOf = (w: WorkspaceSummary) => labels.get(w.id) ?? w.name;
  activeWorkspaceName.current = activeWorkspaceId ? labels.get(activeWorkspaceId) : undefined;

  const selectWorkspace = async (id: string) => {
    if (id === activeWorkspaceId) return;
    setActiveWorkspaceId(id);
    await openWorkspace(workspaces.find((w) => w.id === id) ?? null);
  };

  const addFolder = async (path: string) => {
    try {
      const list = await addWorkspace(path);
      setWorkspaces(list);
      const added = list.find((w) => w.path === path);
      if (added) {
        setActiveWorkspaceId(added.id);
        await openWorkspace(added);
        push("success", "Added to the app.", added.name);
      }
    } catch (e) {
      push("error", String(e));
    }
  };

  const dropWorkspace = async (w: WorkspaceSummary) => {
    const list = await removeWorkspace(w.id);
    setWorkspaces(list);
    // Removing a workspace does not touch the folder: it is a working copy someone cloned,
    // and deleting their files because they closed a tab would be indefensible.
    push("info", "Removed from the app. The folder on disk is untouched.", labelOf(w));
    if (activeWorkspaceId === w.id) {
      const next = list[0] ?? null;
      setActiveWorkspaceId(next?.id ?? null);
      await openWorkspace(next);
    }
  };

  const pickFolder = async () => {
    const chosen = await openDialog({
      directory: true,
      multiple: false,
      title: "Choose a Lore repository folder",
    });
    if (typeof chosen === "string") await addFolder(chosen);
  };


  return (
    <div className="flex h-full flex-col bg-surface-0">
      {/* Hosts are connections; workspaces are the work. Kept apart because nothing in lore
          is per-session — a repository is reached over a loopback port, so whichever host is
          listening on it serves that working copy whatever is selected here. */}
      <HostBar
        hosts={saved}
        tunnelFor={(sid) => tunnels.forSession(sid)}
        onConnect={(h) => void connectHost(h)}
        onDisconnect={(h) => void disconnectHost(h)}
        onEdit={(h) => void hasPsk(h.id).then((k) => setEditing({ ...h, hasKey: k }))}
        onAdd={() => setAddingNew(true)}
      >
        <AuthBadge
          status={auth.status}
          error={auth.error}
          connected={identityServed}
          authUrl={activeAuthUrl}
          pinnedIdentity={activePin}
          hostName={badgeHostName}
          onSignIn={() => setSigningIn(true)}
          onConfigure={() =>
            activeConfig &&
            void hasPsk(activeConfig.id).then((k) => setEditing({ ...activeConfig, hasKey: k }))
          }
        />
      </HostBar>

      <WorkspaceTabs
        workspaces={workspaces}
        label={labelOf}
        activeId={activeWorkspaceId}
        health={(w) => workspaceHealth(w, servingHosts, signedInFor(w))}
        identityName={(w) =>
          w.identity
            ? (auth.status?.all.find((i) => i.user_id === w.identity)?.user ?? w.identity)
            : null
        }
        onSelect={(id) => void selectWorkspace(id)}
        onAdd={() => void pickFolder()}
        onClone={() => setCloning(true)}
        onEdit={(w) => setEditingWorkspace(w)}
      />

      <header className="flex shrink-0 items-center gap-5 border-b border-line bg-surface-1 px-3 py-2">
        <Dropdown
          label="Branch"
          value={repo.info?.branches.current ?? "—"}
          hint="Branches in this repository"
          items={[
            ...(repo.info ? [{ id: "__new__", label: "New branch…" }] : []),
            ...(repo.info?.branches.names ?? []).map((n) => ({
            id: n,
            label: n,
            // Read-only in M2: switching rewrites the working copy, which belongs with the
            // other mutating actions in M3.
            detail:
              n === repo.info?.branches.current
                ? "current"
                : repo.info?.branches.remote_only.includes(n)
                  ? "on host only"
                  : undefined,
            disabled: n === repo.info?.branches.current,
          })),
          ]}
          emptyMessage="Open a repository first."
          onSelect={(name) => {
            if (name === "__new__") {
              setNewBranch(true);
              return;
            }
            void repo.switchTo(name).then((blocked) => {
              // Blocked means nothing happened: lore refused, and the user is asked what to
              // do rather than told what went wrong.
              if (blocked.length > 0) setSwitchBlocked({ branch: name, files: blocked });
            });
          }}
        />

        {/* Sign-in sits with the things it describes — repo, branch, who you are — rather
            than beside Connect/Disconnect, where it read as a third button. */}
        <AuthBadge
          status={auth.status}
          error={auth.error}
          connected={identityServed}
          authUrl={activeAuthUrl}
          pinnedIdentity={activePin}
          hostName={badgeHostName}
          onSignIn={() => setSigningIn(true)}
          onConfigure={() =>
            activeConfig &&
            void hasPsk(activeConfig.id).then((k) => setEditing({ ...activeConfig, hasKey: k }))
          }
        />

        <div className="ml-auto flex items-center gap-2">
          {/* Connecting is a host action and lives in the host bar; what is left
              here is what you do *to a repository*. */}
          <Actions session={session} repo={activeRepo(session)} />
        </div>
      </header>

      {repo.info && reach.state === "ok" && reach.servedBy && activeConfig
        && reach.servedBy !== activeConfig.name && (
        // Not a warning: this works. But it contradicts the tab, which is grey because
        // *this* session has no tunnel — and the tab is the louder signal. A repository is
        // reached over a loopback port, so whichever session is listening on it serves every
        // working copy that dials it, whatever tab you are looking at.
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface-1 px-3 py-1 text-ink-2">
          <span aria-hidden>↔</span>
          <span>
            {tunnelUp
              ? `This repository is served by “${reach.servedBy}”, not by the host selected above.`
              : `“${activeConfig.name}” is not connected, but this repository is served by “${reach.servedBy}” — it will work.`}
          </span>
        </div>
      )}

      {repo.info && (reach.state === "port_mismatch" || reach.state === "not_connected") && (
        // A strip rather than a notice: this is a standing condition, not an event, and it
        // explains every failure that follows until it is resolved.
        <div className="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-warn">
          <span aria-hidden>⚠</span>
          <span className="selectable">{reach.message}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex w-72 shrink-0 flex-col border-r border-line bg-surface-1">
          <Pane title="Files" className="flex-1">
            <RepoPanel repo={repo} onPickFolder={pickFolder} onCommit={() => setCommitting(true)}
              onDiscard={(paths) => setDiscarding(paths)}
            />
          </Pane>
          <Prerequisites />
        </div>

        <Pane title="Content" className="min-w-0 flex-1 bg-surface-0">
          {repo.info ? (
            <FileView root={repo.info.path} rel={repo.selected} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <div className="max-w-md text-center">
                <h1 className="text-base text-ink-0">alt-lore Desktop</h1>
                <p className="mt-2 text-ink-2">Open a repository to begin.</p>
              </div>
            </div>
          )}
        </Pane>

        <Pane
          title="Activity"
          className="w-72 shrink-0 border-l border-line bg-surface-1"
          actions={
            problems > 0 ? (
              <span className="ml-auto rounded bg-danger/15 px-1.5 py-0.5 text-[11px] text-danger">
                {problems}
              </span>
            ) : null
          }
        >
          <Activity notices={notices} />
        </Pane>
      </div>

      {signingIn && activeConfig && activeAuthUrl && (
        <SignInDialog
          sessionName={activeConfig.name}
          authUrl={activeAuthUrl}
          identities={auth.status?.identities ?? []}
          canSignIn={identityServed}
          onCancel={() => setSigningIn(false)}
          onDone={(message) => {
            setSigningIn(false);
            push("success", message, activeConfig.name);
            void auth.refresh();
          }}
        />
      )}

      {newBranch && repo.info && (
        <NewBranchDialog
          currentBranch={repo.info.branches.current}
          existing={repo.info.branches.names}
          onCancel={() => setNewBranch(false)}
          onCreate={(name) => {
            setNewBranch(false);
            void repo.newBranch(name);
          }}
        />
      )}

      {switchBlocked && (
        <SwitchBlockedDialog
          branch={switchBlocked.branch}
          files={switchBlocked.files}
          onCancel={() => setSwitchBlocked(null)}
          onCommit={() => {
            setSwitchBlocked(null);
            setCommitting(true);
          }}
          onDiscard={() => {
            const files = switchBlocked.files;
            setSwitchBlocked(null);
            setDiscarding(files);
          }}
        />
      )}

      {discarding && repo.info && (
        <DiscardDialog
          path={repo.info.path}
          entries={repo.info.status.changes.filter((c) => discarding.includes(c.path))}
          onCancel={() => setDiscarding(null)}
          onDone={(status, summary) => {
            setDiscarding(null);
            repo.adoptStatus(status);
            push("info", `Discarded — ${summary}.`, activeWorkspaceName.current);
          }}
        />
      )}

      {committing && repo.info && (
        <CommitDialog
          path={repo.info.path}
          staged={repo.info.status.changes.filter((c) => c.staged)}
          onCancel={() => setCommitting(false)}
          onCommitted={(status, message) => {
            setCommitting(false);
            repo.adoptStatus(status);
            push("success", `Committed: ${message}`, activeWorkspaceName.current);
          }}
        />
      )}

      {cloning && (
        <CloneDialog
          // Every connected host, not the first one found: with two of them, which to clone
          // from decides both the repository list and the identities available.
          hosts={saved
            // Direct hosts need no connection to clone from; P2P hosts do.
            .filter(
              (h) =>
                (h.kind ?? "p2p") === "direct" ||
                tunnels.forSession(h.session_id)?.phase === "connected",
            )
            .map((h) => ({
              id: h.id,
              name: h.name,
              baseUrl: hostBaseUrl(h),
              authUrl: hostAuthUrl(h),
            }))}
          defaultHostId={activeConfig?.id ?? null}
          defaultIdentity={activePin}
          onCancel={() => setCloning(false)}
          onCloned={(path) => {
            // The dialog stays open to show what the clone came to; it closes itself when
            // dismissed. Adding the workspace now means it is ready by the time it does.
            void addFolder(path);
          }}
        />
      )}

      {editingWorkspace && (
        <WorkspaceForm
          workspace={editingWorkspace}
          identityName={
            editingWorkspace.identity
              ? (auth.status?.all.find((i) => i.user_id === editingWorkspace.identity)?.user ?? null)
              : null
          }
          hostName={hostFor(editingWorkspace)?.name ?? null}
          known={(auth.status?.all ?? []).filter((i) => !i.resource)}
          siblings={siblingsOf(editingWorkspace, workspaces)}
          onRenamed={(list) => {
            setWorkspaces(list);
            setEditingWorkspace(null);
          }}
          onRemove={() => {
            const w = editingWorkspace;
            setEditingWorkspace(null);
            void dropWorkspace(w);
          }}
          onCancel={() => setEditingWorkspace(null)}
        />
      )}

      {(addingNew || editing) && (
        <SessionForm
          existing={editing ?? undefined}
          onSaved={(cfg) => {
            setAddingNew(false);
            setEditing(null);
            void loadSessions().then(setSaved);
            setActiveId(cfg.id);
            push("success", `Saved “${cfg.name}”.`, cfg.name);
          }}
          onCancel={() => {
            setAddingNew(false);
            setEditing(null);
          }}
          onDeleted={(cfg) => {
            setEditing(null);
            setAddingNew(false);
            setSaved((prev) => prev.filter((x) => x.id !== cfg.id));
            // Workspaces are untouched: they belong to a repository, not to a host,
            // and a host removed by mistake would otherwise take the work with it.
            // Move off the tab that no longer exists rather than leaving a blank selection.
            setActiveId((prev) => (prev === cfg.id ? null : prev));
            push("info", `Removed “${cfg.name}”.`);
          }}
        />
      )}
    </div>
  );
}
