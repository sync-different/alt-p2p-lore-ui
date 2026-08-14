import type { Repo, Session } from "../types/app";

/**
 * The action cluster, right-aligned in the context bar.
 *
 * Which buttons exist is driven by state rather than by disabling a fixed row, because the
 * two situations are genuinely different tasks: a repository that is not on this machine
 * can only be cloned, and showing Sync/Push greyed out beside it invites the question "why
 * can't I?" for something that was never applicable.
 *
 * Connect/Disconnect is session-level and always present — it is the one control that is
 * meaningful whatever the repository state, including when there is no repository at all.
 */

function Button({
  label,
  onClick,
  variant = "normal",
  disabled = false,
  title,
}: {
  label: string;
  onClick?: () => void;
  variant?: "normal" | "primary" | "quiet" | "danger";
  disabled?: boolean;
  title?: string;
}) {
  const styles = {
    primary: "border-accent/40 bg-accent/15 text-accent hover:bg-accent/25",
    normal: "border-line bg-surface-2 text-ink-1 hover:bg-surface-3 hover:text-ink-0",
    quiet: "border-transparent bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink-1",
    // Same red the session vocabulary uses for a broken connection: this is the control
    // that ends one, and it should read as the destructive half of the pair.
    danger: "border-danger/40 bg-danger/10 text-danger hover:bg-danger/20",
  }[variant];

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded border px-2.5 py-1 disabled:cursor-not-allowed disabled:opacity-40 ${styles}`}
    >
      {label}
    </button>
  );
}

export function Actions({
  session,
  repo,
  onConnect,
  onDisconnect,
  canConnect = false,
}: {
  session: Session | null;
  repo: Repo | null;
  onConnect?: () => void;
  onDisconnect?: () => void;
  /** False when no session is selected — there is nothing to connect to. */
  canConnect?: boolean;
}) {
  const connected = session?.status === "connected" || session?.status === "relay";
  const busy = session?.status === "connecting";
  const cloned = !!repo?.localPath;

  return (
    <div className="flex items-center gap-1.5">
      {connected && repo && (
        <>
          {cloned ? (
            <>
              <Button label="Sync" title="Pull the latest changes from the host" />
              <Button label="Push" title="Send your commits to the host" />
            </>
          ) : (
            <Button
              label="Clone"
              variant="primary"
              title="Copy this repository to a folder on this machine"
            />
          )}
          <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        </>
      )}

      <Button
        label={connected ? "Disconnect" : busy ? "Connecting…" : "Connect"}
        variant={connected ? "danger" : "primary"}
        disabled={busy || !canConnect}
        onClick={connected ? onDisconnect : onConnect}
        title={
          !canConnect
            ? "Add a session first"
            : connected
              ? "Close the connection to this host"
              : "Connect to this host"
        }
      />
    </div>
  );
}
