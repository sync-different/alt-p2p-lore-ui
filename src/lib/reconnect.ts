/**
 * When to put a dead tunnel back up, and when to stop trying.
 *
 * A P2P host is a *process*, unlike a direct host which is just an address. When that process
 * dies the host is gone until somebody presses Connect — and the death is often nothing the
 * user did or saw: a coordinator restart, a peer that went away, a network blink.
 *
 * Reconnecting is transport, not work: it restores the route rather than performing anything
 * on the user's behalf, which is why it may happen automatically where a failed push may not.
 * The limits below exist so that "automatically" cannot become "forever".
 */

/**
 * Delays between attempts, in milliseconds.
 *
 * Widening, and finite. A tunnel that fails four times in a row is failing for a reason that
 * retrying will not fix — a coordinator that is down, a session id already paired, a key that
 * is wrong — and hammering it is both useless and rude to the coordinator, which is shared
 * infrastructure. After these, the user gets a Connect button and an explanation.
 */
export const BACKOFF_MS = [5_000, 15_000, 45_000];

export interface ReconnectDecision {
  retry: boolean;
  delayMs?: number;
  /** Said once when giving up, so the silence afterwards is explained. */
  exhausted?: boolean;
}

/**
 * Should this exit be retried?
 *
 * @param intentional the user pressed Disconnect. A killed child exits exactly like a crashed
 *   one, so this is the registry's record of intent rather than anything the process said —
 *   without it, disconnecting would immediately reconnect, which is the worst possible bug in
 *   a feature like this.
 * @param attempts how many have already been made since the last healthy connection.
 */
export function decideReconnect(opts: {
  intentional: boolean;
  attempts: number;
  /** False for a direct host: there is no process to restart. */
  isP2p: boolean;
}): ReconnectDecision {
  const { intentional, attempts, isP2p } = opts;
  if (!isP2p || intentional) return { retry: false };
  if (attempts >= BACKOFF_MS.length) return { retry: false, exhausted: true };
  return { retry: true, delayMs: BACKOFF_MS[attempts] };
}

/** What to say before waiting. Counts from one, because nobody thinks of the first try as zero. */
export function reconnectMessage(name: string, attempts: number, delayMs: number): string {
  return `“${name}” dropped. Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${
    attempts + 1
  } of ${BACKOFF_MS.length}).`;
}

export function exhaustedMessage(name: string): string {
  return (
    `“${name}” dropped and did not come back after ${BACKOFF_MS.length} attempts. ` +
    `Press Connect to try again.`
  );
}
