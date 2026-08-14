import type { SessionConfig } from "../lib/sessions";
import type { TunnelInfo } from "../hooks/useTunnels";
import { phaseToStatus } from "../hooks/useTunnels";
import type { SessionStatus } from "../types/app";

/**
 * The hosts this app can connect to, and which of them is carrying traffic.
 *
 * A host is a connection — session id, key, coordinator, ports — and **one tunnel at a
 * time**: the identity port binds once, so two tunnels to one host can never both run. That
 * is why this is a row of small controls rather than a workspace-like tab strip; connecting
 * is something you do occasionally, and the rest of the day it should take no space.
 *
 * Separated from the workspace tabs because nothing in lore is per-session: a repository
 * reaches its host over a loopback port, so *whichever* host is listening on that port serves
 * it, whatever is selected here.
 */

const DOT: Record<SessionStatus, string> = {
  connected: "bg-ok",
  relay: "bg-warn",
  connecting: "bg-warn animate-pulse",
  error: "bg-danger",
  disconnected: "bg-ink-2/50",
};

const WORD: Record<SessionStatus, string> = {
  connected: "connected",
  relay: "connected via relay",
  connecting: "connecting…",
  error: "failed",
  disconnected: "not connected",
};

export function HostBar({
  hosts,
  tunnelFor,
  onConnect,
  onDisconnect,
  onEdit,
  onAdd,
  children,
}: {
  hosts: SessionConfig[];
  tunnelFor: (sessionId: string) => TunnelInfo | undefined;
  onConnect: (host: SessionConfig) => void;
  onDisconnect: (host: SessionConfig) => void;
  onEdit: (host: SessionConfig) => void;
  onAdd: () => void;
  /** The sign-in badge, which belongs to the host that is up. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface-1 px-3 py-1.5">
      <span className="text-[11px] uppercase tracking-wide text-ink-2">Hosts</span>

      {hosts.length === 0 && (
        <span className="text-ink-2">No hosts yet — add the details your host gave you.</span>
      )}

      {hosts.map((h) => {
        // A direct host has nothing to connect: it is an address that either answers or does
        // not, and finding out is the job of the next operation rather than a button.
        const direct = (h.kind ?? "p2p") === "direct";
        const t = tunnelFor(h.session_id);
        const status = direct ? "connected" : phaseToStatus(t?.phase, t?.mode);
        const live = status === "connected" || status === "relay";
        const busy = status === "connecting";
        return (
          <span key={h.id} className="flex items-center gap-1.5">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${direct ? "bg-ok/60" : DOT[status]}`}
              aria-hidden
            />
            <span
              className="text-ink-1"
              title={direct ? `${h.name} — direct, ${h.base_url ?? ""}` : `${h.name} — ${WORD[status]}`}
            >
              {h.name}
              {direct && <span className="text-ink-2"> · direct</span>}
            </span>
            {!direct && (
            <button
              onClick={() => (live ? onDisconnect(h) : onConnect(h))}
              disabled={busy}
              className={`rounded border px-1.5 py-0.5 text-[11px] disabled:opacity-50 ${
                live
                  ? "border-danger/40 text-danger hover:bg-danger/10"
                  : "border-accent/40 text-accent hover:bg-accent/15"
              }`}
            >
              {live ? "Disconnect" : busy ? "…" : "Connect"}
            </button>
            )}
            <button
              onClick={() => onEdit(h)}
              aria-label={`Settings for ${h.name}`}
              title="Host settings"
              className="rounded px-1 text-[15px] leading-none text-ink-2 hover:bg-surface-3 hover:text-ink-0"
            >
              ⚙
            </button>
          </span>
        );
      })}

      <button
        onClick={onAdd}
        className="rounded border border-line px-1.5 py-0.5 text-[11px] text-ink-2 hover:bg-surface-2 hover:text-ink-0"
        title="Add a host"
      >
        + Host
      </button>

      <span className="ml-auto flex items-center gap-2">{children}</span>
    </div>
  );
}
