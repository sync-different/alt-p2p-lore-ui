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
 * **The question is about the machine, not the tab.** `lore` dials a URL; it has no idea which
 * session is on screen. So a repository is reachable when *any* host serves that URL — being
 * on a different tab changes nothing. An earlier version asked only about the active tab and
 * warned about a setup that worked perfectly.
 *
 * **And the question is about a URL, not a port.** Matching on the loopback port alone made
 * every host on 41337 the same host, which is only true while the transport is a tunnel. A
 * host reached directly has a hostname, and that is what distinguishes it.
 */

import { looksLikeUntrustedCa } from "./auth";

/**
 * A host that could serve a working copy, whatever the transport.
 *
 * P2P and direct hosts differ only in what makes them available: a running tunnel, or being
 * configured at all. Past that point the question is the same — does this host's URL match
 * the one the repository dials?
 */
export interface ServingHost {
  name: string;
  /** The URL its working copies dial, e.g. `grpc://127.0.0.1:41400`. */
  baseUrl: string;
  /** For P2P, a live tunnel. For direct, whether it is configured (and reachable if probed). */
  available: boolean;
  /** False for a direct host, where there is nothing to connect. */
  isP2p: boolean;
}

export interface Reach {
  state: "ok" | "port_mismatch" | "not_connected" | "no_remote" | "unknown";
  message?: string;
  repoUrl?: string;
  /** The session carrying this repository's traffic, when one is. */
  servedBy?: string;
}

export function reachability(opts: {
  /** What the working copy dials, verbatim from `.lore/config.toml`. */
  remoteUrl?: string | null;
  /** Every host the app knows about, of either kind. */
  hosts?: ServingHost[];
}): Reach {
  const { remoteUrl, hosts = [] } = opts;

  // A repository created locally has no remote; nothing to reach, nothing to warn about.
  const wanted = authority(remoteUrl);
  if (!wanted) return { state: "no_remote" };

  const matching = hosts.filter((h) => authority(h.baseUrl) === wanted);
  const serving = matching.find((h) => h.available);
  if (serving) {
    return { state: "ok", repoUrl: remoteUrl!, servedBy: serving.name };
  }

  // A host is configured for this URL but is not up. For P2P that is a connection; for a
  // direct host it means it did not answer — different remedies, so different sentences.
  if (matching.length > 0) {
    const h = matching[0];
    return {
      state: "not_connected",
      repoUrl: remoteUrl!,
      message: h.isP2p
        ? `This repository is served by “${h.name}”, which is not connected. Connect it.`
        : `“${h.name}” did not answer at ${h.baseUrl}. Check the host is running and reachable.`,
    };
  }

  // Nothing knows this URL at all.
  const available = hosts.filter((h) => h.available);
  if (available.length === 0) {
    return {
      state: "not_connected",
      repoUrl: remoteUrl!,
      message: `This repository talks to ${wanted}, and no host here serves it. Add or connect one.`,
    };
  }
  return {
    state: "port_mismatch",
    repoUrl: remoteUrl!,
    // Both sides named, because the fix is either a different host or a different address,
    // and which is right depends on what the user knows about their setup.
    message:
      `This repository talks to ${wanted}, but the hosts that are up serve ` +
      `${available.map((h) => authority(h.baseUrl)).join(", ")}. ` +
      `Connect the host that serves ${wanted}, or point that host at it — then reconnect.`,
  };
}

/** `host:port` from a URL: what decides whether two URLs mean the same host. */
function authority(url: string | null | undefined): string | null {
  if (!url) return null;
  const rest = url.includes("://") ? url.split("://")[1] : url;
  return rest.split("/")[0].trim() || null;
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
  // An untrusted-CA failure *contains* "transport error" and "failed to connect", but the host
  // answered — TLS verification failed on our side. Treating it as unreachable misfiled it two
  // ways at once: the message blamed the network, and a failed write was remembered as "worth
  // raising when the host returns", which a trust failure never earns — retry cannot help until
  // the CA is imported. Most specific reading wins.
  if (looksLikeUntrustedCa(text)) return false;
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
