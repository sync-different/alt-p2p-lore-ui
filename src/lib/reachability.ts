/**
 * Whether the repository in front of you can actually be reached.
 *
 * A working copy pins its remote to a **loopback port** — `.lore/config.toml` holds
 * `remote_url = "grpc://127.0.0.1:41400"` — not to a session. Get it wrong and `lore` says:
 *
 *   [Error] Disconnected from server … connect: grpc://127.0.0.1:41400
 *   Unable to check lock status while offline
 *
 * which reads as a network fault. It is not: the tunnel is healthy and listening elsewhere.
 *
 * **The question is about the machine, not the tab.** `lore` dials a loopback port; it has no
 * idea which session is on screen. So a repository is reachable when *any* live tunnel
 * forwards its port — being on a different tab changes nothing. An earlier version asked only
 * about the active tab and warned about a setup that worked perfectly.
 */

export interface Tunnel {
  sessionName: string;
  /** The local port this tunnel forwards loreserver on. */
  port: number;
  connected: boolean;
}

export interface Reach {
  state: "ok" | "port_mismatch" | "not_connected" | "no_remote" | "unknown";
  message?: string;
  repoPort?: number;
  /** The session carrying this repository's traffic, when one is. */
  servedBy?: string;
}

export function reachability(opts: {
  remotePort?: number | null;
  /** Every tunnel the app knows about, whatever tab is on screen. */
  tunnels?: Tunnel[];
}): Reach {
  const { remotePort, tunnels = [] } = opts;

  // A repository created locally has no remote; nothing to reach, nothing to warn about.
  if (remotePort == null) return { state: "no_remote" };

  const live = tunnels.filter((t) => t.connected);
  const serving = live.find((t) => t.port === remotePort);
  if (serving) {
    return { state: "ok", repoPort: remotePort, servedBy: serving.sessionName };
  }

  if (live.length === 0) {
    return {
      state: "not_connected",
      repoPort: remotePort,
      message: `This repository talks to port ${remotePort}. Connect the session that forwards it.`,
    };
  }

  // Connected, but nothing on the port this repository dials.
  const ports = [...new Set(live.map((t) => t.port))].sort((a, b) => a - b);
  const names = live.map((t) => `“${t.sessionName}”`).join(", ");
  return {
    state: "port_mismatch",
    repoPort: remotePort,
    // Both numbers named, and both ways out given: the fix is either a different session or a
    // different local port, and which is right depends on whether they reach the same host —
    // something only the user knows.
    message:
      `This repository talks to port ${remotePort}, but ${names} ` +
      `${live.length === 1 ? "forwards" : "forward"} ${ports.join(", ")}. ` +
      `Connect the session that forwards ${remotePort}, or set a connected session's local ` +
      `port to ${remotePort} if it reaches the same host — then reconnect it.`,
  };
}

/** Errors that mean "nothing answered", as lore phrases them. */
const UNREACHABLE = [
  "disconnected from server",
  "while offline",
  "connection refused",
  "transport error",
  "failed to connect",
];

export function looksUnreachable(text: string): boolean {
  const t = text.toLowerCase();
  return UNREACHABLE.some((s) => t.includes(s));
}

/**
 * Replace an unreachable-server error with the reason, when we know it.
 *
 * Only when the port is genuinely unserved — inventing this explanation for an ordinary
 * dropped connection would send someone to change a port that was always correct.
 */
export function explainUnreachable(raw: string, reach: Reach): string {
  if (!looksUnreachable(raw)) return raw;
  if (reach.state === "port_mismatch" || reach.state === "not_connected") {
    return reach.message!;
  }
  return raw;
}
