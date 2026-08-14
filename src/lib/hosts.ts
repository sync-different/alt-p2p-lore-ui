/**
 * Whether a host is answering, and what to show for it.
 *
 * A **P2P** host has a tunnel whose phase says this already. A **direct** host has no process
 * to watch, and until now the bar simply assumed it was up — a green dot for a machine that
 * could be switched off. Green is what lets somebody start a long push, so a green light the
 * app cannot justify is worse than showing nothing at all.
 *
 * The probe is a TCP connect (see `probe.rs`). It proves the machine is up and something is
 * listening; it does not claim loreserver is healthy or that you may do anything. That is
 * exactly what a dot should mean.
 */

import { invoke } from "@tauri-apps/api/core";
import type { SessionStatus } from "../types/app";

/** Mirrors the Rust enum. `undefined` means not asked yet, which is not the same as down. */
export type HostProbe = "up" | "refused" | "unreachable" | "bad";

export const probeHost = (url: string) => invoke<HostProbe>("probe_host", { url });

/**
 * The dot's state for a direct host.
 *
 * Before the first answer this is *checking*, not *fine*: the window has only just opened and
 * nothing is known yet. Showing green there would be the same unjustified claim, only briefer.
 *
 * Both failures are red rather than grey. Grey reads as "not connected — connect it", which is
 * an action a direct host does not have; red is accurate, because anything the user does
 * against this host is going to fail until it comes back.
 */
export function probeStatus(p: HostProbe | undefined): SessionStatus {
  switch (p) {
    case "up":
      return "connected";
    case "refused":
    case "unreachable":
    case "bad":
      return "error";
    default:
      return "connecting";
  }
}

/**
 * What to say about it, in terms of what the user would do next.
 *
 * The two failures are kept apart because they send you to different places: nothing listening
 * means start the service, nothing answering means look at the machine. Both were seen in one
 * afternoon — a stopped loreserver refuses in 0.2s, a sleeping host answers not at all.
 */
export function probeLabel(p: HostProbe | undefined, name: string, url: string): string {
  switch (p) {
    case "up":
      return `${name} — answering at ${url}`;
    case "refused":
      return `${name} — nothing is listening at ${url}. The host is up but loreserver is not running.`;
    case "unreachable":
      return `${name} — no answer from ${url}. The machine may be asleep, off, or unreachable.`;
    case "bad":
      return `${name} — ${url} is not an address this app can reach. Check the host settings.`;
    default:
      return `${name} — checking ${url}…`;
  }
}

/** Is this host fit to serve a working copy right now? */
export function isServing(p: HostProbe | undefined): boolean {
  return p === "up";
}

/**
 * Did this host just come *back*?
 *
 * Deliberately not "is it up now". The first answer after the window opens is not a return —
 * announcing "fedora is answering again" on launch would be a notification about nothing, and
 * re-reading the repository then is work the caller has already done.
 *
 * A return is a transition from a state we had established as *not serving* into one that is.
 * Unknown (`undefined`) is neither, so it never triggers on either side.
 */
export function cameBack(prev: HostProbe | undefined, next: HostProbe | undefined): boolean {
  if (!isServing(next)) return false;
  return prev !== undefined && !isServing(prev);
}
